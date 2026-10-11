import { type Advisory, type LockPlan, type Policy, SCENARIO_DEFAULTS, type Snapshot, advise, planLock, validatePolicy } from '@holdfast/core';
import type { OrgRecord } from '@holdfast/db';
import { formatZec } from '@holdfast/zcash';
import type { Deps } from '../deps';
import { invalid, refused, unavailable } from '../errors';
import { latestEntry, treasuryReading, venueReading } from '../live';
import type { Reading } from '../reading';

type LiveDeps = Pick<Deps, 'store' | 'hyperliquid' | 'now' | 'redact'>;

/** Replace the policy with one that passes validation whole. A policy that does not is refused with every reason. */
export async function replacePolicy(deps: Pick<Deps, 'store'>, org: OrgRecord, input: unknown): Promise<{ policy: Policy; lockEnabled: boolean }> {
  const checked = validatePolicy(input);
  if (!checked.ok) throw invalid('the policy is not valid', checked.errors);
  await deps.store.updateOrg(org.id, { policy: checked.policy });
  return { policy: checked.policy, lockEnabled: org.lockEnabled };
}

/**
 * Switch the runway lock on or off. This records what the treasurer wants;
 * the controller acts on it at its next tick, under the same guards as ever.
 * Off means a target of zero: an open short is unwound, nothing new is opened.
 */
export async function setLock(deps: Pick<Deps, 'store'>, org: OrgRecord, enabled: boolean): Promise<{ policy: Policy; lockEnabled: boolean }> {
  await deps.store.updateOrg(org.id, { lockEnabled: enabled });
  return { policy: org.policy, lockEnabled: enabled };
}

export interface LockPreview {
  inputs: {
    treasury: { zat: bigint; zec: string; readAt: number };
    price: { px: number; readAt: number };
    hedgeRatioBps: number;
    marginRatioBps: number;
    firstRungBps: number;
  };
  /** Figures that are not read from anywhere: the planner's own allowance for the swap and the venue's maintenance margin. */
  assumed: { swapCostBps: number; maintenanceBps: number };
  plan: LockPlan & { sellZec: string };
}

/**
 * What locking the treasury now would take: how much ZEC to turn into
 * margin, how large a short to open, and how far the price can rise before
 * the first buy-back and before liquidation. The treasury balance and the
 * price have to be current; on anything older there is no preview.
 */
export async function previewLock(deps: LiveDeps, org: OrgRecord, swapCostBps: number = SCENARIO_DEFAULTS.swapCostBps): Promise<LockPreview> {
  const treasury = treasuryReading(deps, org.policy, await latestEntry(deps, org.id));
  if (treasury.status !== 'ok') throw unavailable('the treasury balance', treasury.reason);
  const venue = await venueReading(deps, org);
  if (venue.status !== 'ok') throw unavailable('Hyperliquid', venue.reason);

  const { policy } = org;
  const assumed = { swapCostBps, maintenanceBps: SCENARIO_DEFAULTS.maintenanceBps };
  const plan = planLock({
    treasuryZat: treasury.value.zat,
    hedgeRatioBps: policy.hedgeRatioBps,
    marginRatioBps: policy.marginTargetBps,
    px: venue.value.markPx,
    swapCostBps: assumed.swapCostBps,
    maintenanceBps: assumed.maintenanceBps,
    firstRungBps: policy.deRiskTriggerBps,
  });
  if (plan.hedgeLots === 0) throw refused('there is nothing to lock: the treasury does not cover one lot of 0.01 ZEC after margin, or the policy hedges none of it');

  return {
    inputs: {
      treasury: { zat: treasury.value.zat, zec: formatZec(treasury.value.zat), readAt: treasury.readAt },
      price: { px: venue.value.markPx, readAt: venue.readAt },
      hedgeRatioBps: policy.hedgeRatioBps,
      marginRatioBps: policy.marginTargetBps,
      firstRungBps: policy.deRiskTriggerBps,
    },
    assumed,
    plan: { ...plan, sellZec: formatZec(plan.sellZat) },
  };
}

export interface Advisories {
  lockEnabled: boolean;
  /** Things only the treasurer can do, worked out from the venue as it stands now. */
  advisories: Advisory[];
  /** Null while the lock is off, when nothing is read. An unavailable treasury means no re-lock advice could be worked out. */
  treasury: Reading<{ zat: bigint }> | null;
  readAt: number;
}

/**
 * What the treasurer is asked to do: add margin, take excess margin back,
 * lock what the short does not cover. Without the venue nothing can be said,
 * and an empty list would read as "nothing to do", so that is an error.
 */
export async function currentAdvisories(deps: LiveDeps, org: OrgRecord): Promise<Advisories> {
  if (!org.lockEnabled) return { lockEnabled: false, advisories: [], treasury: null, readAt: deps.now() };
  const venue = await venueReading(deps, org);
  if (venue.status !== 'ok') throw unavailable('Hyperliquid', venue.reason);
  const treasury = treasuryReading(deps, org.policy, await latestEntry(deps, org.id));

  const snapshot: Snapshot = {
    now: deps.now(),
    treasury: treasury.status === 'ok' ? { zat: treasury.value.zat, asOf: treasury.readAt } : null,
    hl: venue.value,
    ref: null,
  };
  return {
    lockEnabled: true,
    advisories: advise(snapshot, org.policy),
    treasury: treasury.status === 'ok' ? { ...treasury, value: { zat: treasury.value.zat } } : treasury,
    readAt: venue.readAt,
  };
}
