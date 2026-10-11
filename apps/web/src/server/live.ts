import { type Policy, isFresh, isUsablePrice } from '@holdfast/core';
import type { OrgRecord } from '@holdfast/db';
import { FUNDING_WINDOW_HOURS, type JournalEntry } from '@holdfast/engine';
import type { HyperliquidState } from '@holdfast/hyperliquid';
import type { Deps } from './deps';
import { type Reading, available, missing, reading } from './reading';

/**
 * The inputs every figure about an organisation rests on, each read where it
 * lives: the venue and the reference price now, the treasury from the latest
 * tick, which is the only thing that reads the chain with the viewing key.
 * A reading older than the organisation's own data age limit is unavailable.
 */

export const ZCASH = 'zcash';
export const HYPERLIQUID = 'hyperliquid';
export const REFERENCE = 'reference';
export const JOURNAL = 'journal';

export interface TreasuryReading {
  zat: bigint;
  /** The journal entry that holds the reading. */
  seq: number;
}

export interface VenueReading extends HyperliquidState {
  /** Trailing funding APR paid to shorts. */
  fundingAprBps: number;
}

const seconds = (ms: number) => Math.round(ms / 1000);

function tooOld(what: string, asOf: number, now: number, maxAgeMs: number): string | null {
  if (isFresh(asOf, now, maxAgeMs)) return null;
  return asOf > now ? `${what} is dated after the present moment` : `${what} is ${seconds(now - asOf)} s old, over the ${seconds(maxAgeMs)} s allowed`;
}

/** The latest journal entry of an organisation, if a tick ever ran for it. */
export async function latestEntry(deps: Pick<Deps, 'store'>, orgId: string): Promise<JournalEntry | undefined> {
  const [latest] = await deps.store.listJournal(orgId, { limit: 1 });
  return latest;
}

/** The shielded balance as the latest tick read it. */
export function treasuryReading(deps: Pick<Deps, 'now' | 'redact'>, policy: Policy, latest: JournalEntry | undefined): Reading<TreasuryReading> {
  const now = deps.now();
  if (latest === undefined) return missing(ZCASH, now, 'no tick has run for this organisation yet');
  const { treasury } = latest.snapshot;
  if (treasury === null) {
    const why = latest.errors.find((error) => error.source === 'treasury')?.message ?? 'the latest tick did not read the treasury';
    return missing(ZCASH, latest.at, deps.redact(why));
  }
  const stale = tooOld('the latest treasury reading', treasury.asOf, now, policy.maxDataAgeMs);
  if (stale !== null) return missing(ZCASH, treasury.asOf, stale);
  return available(ZCASH, treasury.asOf, { zat: BigInt(treasury.zat), seq: latest.seq });
}

/** The organisation's account on the hedge venue, read now. */
export async function venueReading(deps: Pick<Deps, 'hyperliquid' | 'now' | 'redact'>, org: Pick<OrgRecord, 'hlUser' | 'policy'>): Promise<Reading<VenueReading>> {
  return reading(HYPERLIQUID, deps, async () => {
    const venue = deps.hyperliquid.venue();
    const [state, fundingAprBps] = await Promise.all([venue.state(org.hlUser), venue.fundingAprBps(FUNDING_WINDOW_HOURS)]);
    const stale = tooOld('the venue state', state.asOf, deps.now(), org.policy.maxDataAgeMs);
    if (stale !== null) throw new Error(stale);
    if (!isUsablePrice(state.markPx) || !Number.isFinite(state.accountValueUsd) || !Number.isInteger(state.shortLots) || !Number.isFinite(fundingAprBps)) {
      throw new Error('the venue state is malformed');
    }
    return { ...state, fundingAprBps };
  });
}

/** An independent ZEC/USD price, read now. */
export async function referenceReading(deps: Pick<Deps, 'reference' | 'now' | 'redact'>, policy: Policy): Promise<Reading<{ px: number; asOf: number }>> {
  return reading(REFERENCE, deps, async () => {
    const price = await deps.reference.zecUsd();
    const stale = tooOld('the reference price', price.asOf, deps.now(), policy.maxDataAgeMs);
    if (stale !== null) throw new Error(stale);
    if (!isUsablePrice(price.px)) throw new Error('the reference price is not a usable price');
    return price;
  });
}
