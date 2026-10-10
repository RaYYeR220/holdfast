import { type Action, type Hex, type Snapshot, advise, decide, digest } from '@holdfast/core';
import type { JournalEntry, OrderRecord, OrgState, TickDeps, TickOutcome } from './types';

/** Blocks re-read on every tick so a reorganisation cannot leave stale notes. */
export const REORG_DEPTH = 20;
/** Upper bound on one tick's scan, so a first sync spreads over several ticks. */
export const MAX_BLOCKS_PER_TICK = 5_000;
/** Funding is judged over the last three days. */
export const FUNDING_WINDOW_HOURS = 72;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Same organisation, same tick, same order: a retried tick cannot trade twice. */
export function cloidFor(orgId: string, seq: number, index: number): Hex {
  return digest({ orgId, seq, index }).slice(0, 34) as Hex;
}

async function readTreasury(org: OrgState, deps: TickDeps, errors: JournalEntry['errors']) {
  try {
    const tip = await deps.scanner.tip();
    const resumeFrom = org.scannedTo === null ? org.birthday : org.scannedTo - REORG_DEPTH + 1;
    const from = Math.max(org.birthday, resumeFrom);
    const to = Math.min(tip, from + MAX_BLOCKS_PER_TICK - 1);
    if (to >= from) {
      const knownNullifiers = await deps.store.unspentNullifiers(org.id);
      const scan = await deps.scanner.scan({ ufvk: org.ufvk, fromHeight: from, toHeight: to, knownNullifiers });
      await deps.store.commitScan(org.id, { from, to, ...scan });
    }
    const caughtUp = to >= tip;
    // A balance read part-way through a catch-up is missing whatever the
    // unscanned blocks hold; it is not a balance yet.
    const treasury = caughtUp ? { zat: await deps.store.trackedBalance(org.id), asOf: deps.now() } : null;
    if (!caughtUp) errors.push({ source: 'treasury', message: `catching up: scanned to ${to} of ${tip}` });
    return { treasury, scan: { from, to, tip, caughtUp } };
  } catch (e) {
    errors.push({ source: 'treasury', message: message(e) });
    return { treasury: null, scan: null };
  }
}

async function readVenue(org: OrgState, deps: TickDeps, errors: JournalEntry['errors']): Promise<Snapshot['hl']> {
  try {
    const [state, fundingAprBps] = await Promise.all([
      deps.venue.state(org.hlUser),
      deps.venue.fundingAprBps(FUNDING_WINDOW_HOURS),
    ]);
    return { ...state, fundingAprBps };
  } catch (e) {
    errors.push({ source: 'venue', message: message(e) });
    return null;
  }
}

async function readReference(deps: TickDeps, errors: JournalEntry['errors']): Promise<Snapshot['ref']> {
  try {
    return await deps.reference.zecUsd();
  } catch (e) {
    errors.push({ source: 'reference', message: message(e) });
    return null;
  }
}

async function execute(org: OrgState, action: Action, deps: TickDeps): Promise<OrderRecord> {
  const cloid = cloidFor(org.id, org.nextSeq, 0);
  const side = action.kind === 'increaseShort' ? 'sell' : 'buy';
  const reduceOnly = action.kind === 'reduceShort';
  let result: OrderRecord['result'];
  try {
    result = await deps.venue.place({ user: org.hlUser, side, lots: action.lots, limitPx: action.limitPx, reduceOnly, cloid });
  } catch (e) {
    // An adapter is expected to report failures, not throw them; if it does
    // throw, the order's fate is unknown and the journal must say so.
    result = { ok: false, filledLots: 0, avgPx: null, oid: null, error: `outcome unknown: ${message(e)}` };
  }
  return { seq: org.nextSeq, cloid, side, lots: action.lots, limitPx: action.limitPx, reduceOnly, result };
}

/**
 * One pass for one organisation: read the treasury, the venue and the
 * reference price; decide; place at most one order; write the journal.
 *
 * Nothing here retries. A source that fails is recorded and left out of the
 * snapshot, and the controller treats what is missing as stale.
 */
export async function tick(orgId: string, deps: TickDeps): Promise<TickOutcome> {
  const locked = await deps.store.withOrgLock(orgId, async () => {
    const org = await deps.store.loadOrg(orgId);
    const errors: JournalEntry['errors'] = [];

    const [{ treasury, scan }, hl, ref] = await Promise.all([
      readTreasury(org, deps, errors),
      readVenue(org, deps, errors),
      readReference(deps, errors),
    ]);

    const at = deps.now();
    const snapshot: Snapshot = { now: at, treasury, hl, ref };
    // With the lock switched off the target is zero: nothing new is opened
    // and an existing short is unwound by the same rules that guard it.
    const policy = org.lockEnabled ? org.policy : { ...org.policy, hedgeRatioBps: 0 };
    const decision = decide(snapshot, policy);
    const advisories = org.lockEnabled ? advise(snapshot, policy) : [];

    const action = decision.actions[0];
    const order = action === undefined ? null : await execute(org, action, deps);

    const body = {
      orgId,
      seq: org.nextSeq,
      at,
      snapshot,
      policyDigest: digest(policy),
      decision,
      advisories,
      order,
      errors,
      scan,
    };
    const entry: JournalEntry = { ...body, prev: org.lastDigest, digest: digest({ prev: org.lastDigest, body }) };
    await deps.store.appendJournal(entry);
    return entry;
  });

  return locked.ran ? { ran: true, entry: locked.value } : { ran: false, reason: 'locked' };
}

/** Recompute an entry's digest from its content; used by auditors and tests. */
export function entryDigest(entry: JournalEntry): Hex {
  const { prev, digest: _stored, ...body } = entry;
  return digest({ prev, body });
}

/** Check that a run of entries is an unbroken, untampered chain. */
export function verifyChain(entries: JournalEntry[], start: Hex): { ok: true } | { ok: false; seq: number; reason: string } {
  let prev = start;
  for (const entry of entries) {
    if (entry.prev !== prev) return { ok: false, seq: entry.seq, reason: 'does not follow the previous entry' };
    if (entryDigest(entry) !== entry.digest) return { ok: false, seq: entry.seq, reason: 'content does not match its digest' };
    prev = entry.digest;
  }
  return { ok: true };
}
