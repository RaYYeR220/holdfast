import type { OrgRecord } from '@holdfast/db';
import type { AttestationList, EntryProof } from '@/server/attestations/service';
import { type DemoJournal, type DemoOverview, demoOrg, demoOverview } from '@/server/demo/service';
import { type LockPage, journalPage, lockPage, proofOf, snapshotsOf } from '@/server/pages/lock';
import { type Failure, type Outcome, PAGE_PATIENCE_MS, failureOf, within } from '@/server/pages/treasury-lock-reads';
import { runtime } from '@/server/runtime';
import { type BacktestResult, loadBacktest } from '../../_lib/backtest';
import { loadDemo } from '../../_lib/demo';
import { keep } from '../../_lib/keep';
import type { LockParams, SnapshotRef } from './params';

/**
 * The Lock page's reads, made once for a request on the real dependencies:
 * for the public demo, and for the organisation of the owner who is signed
 * in. Nothing here throws; whatever could not be read comes back as a state.
 */

export interface ProofShown {
  seq: number;
  /** The snapshot the proof was asked under; null when the chain holds none to ask under. */
  snapshot: SnapshotRef | null;
  outcome: Outcome<EntryProof>;
}

export interface LockData {
  org: { id: string; name: string; publicDemo: boolean };
  overview: DemoOverview;
  lock: LockPage;
  journal: Outcome<DemoJournal>;
  snapshots: Outcome<AttestationList>;
  proof: ProofShown | null;
  backtest: BacktestResult;
}

export type LockRead = { status: 'ok'; data: LockData } | ({ status: 'empty' | 'unavailable' } & Failure);

async function readLock(org: OrgRecord, overview: DemoOverview, params: LockParams): Promise<LockData> {
  const deps = runtime();
  const [lock, journal, snapshots, backtest] = await Promise.all([
    lockPage(deps, org),
    journalPage(deps, org, { beforeSeq: params.before ?? undefined }),
    snapshotsOf(deps, org),
    loadBacktest(),
  ]);

  let proof: ProofShown | null = null;
  if (params.check !== null) {
    const seq = params.check;
    const at = deps.now();
    if (params.snapshot !== null) {
      proof = { seq, snapshot: params.snapshot, outcome: await proofOf(deps, org, { ...params.snapshot, seq }) };
    } else if (snapshots.status !== 'ok') {
      proof = { seq, snapshot: null, outcome: snapshots };
    } else if (snapshots.value.snapshots.status !== 'ok') {
      const { source, reason, readAt } = snapshots.value.snapshots;
      proof = { seq, snapshot: null, outcome: { status: 'unavailable', source, reason, at: readAt } };
    } else {
      const latest = snapshots.value.snapshots.value.items[0];
      if (latest === undefined) {
        proof = { seq, snapshot: null, outcome: { status: 'refused', reason: 'the contract holds no snapshot for this account yet, so there is no root to check an entry under', at } };
      } else {
        const snapshot = { series: latest.series, number: latest.number };
        proof = { seq, snapshot, outcome: await proofOf(deps, org, { ...snapshot, seq }) };
      }
    }
  }

  return { org: { id: org.id, name: org.name, publicDemo: org.publicDemo }, overview, lock, journal, snapshots, proof, backtest };
}

/** The demo's lock is the same for every visitor, so a read is kept for a few seconds; a proof under a snapshot does not change. */
const keptLock = keep<LockRead>(15_000, 64);

/** The lock of the public demo treasury. */
export function loadDemoLock(params: LockParams): Promise<LockRead> {
  return keptLock(JSON.stringify([params.before, params.check, params.snapshot === null ? null : [String(params.snapshot.series), String(params.snapshot.number)]]), () => readDemoLock(params));
}

async function readDemoLock(params: LockParams): Promise<LockRead> {
  const demo = await loadDemo();
  if (demo.status !== 'ok') return demo;
  const deps = runtime();
  try {
    const org = await within(PAGE_PATIENCE_MS, demoOrg(deps, demo.org.id));
    return { status: 'ok', data: await readLock(org, demo.overview, params) };
  } catch (error) {
    return { status: 'unavailable', ...failureOf(deps, error, deps.now()) };
  }
}

/** The lock of the organisation of the owner who is signed in. */
export async function loadOwnerLock(org: OrgRecord, params: LockParams): Promise<LockRead> {
  const deps = runtime();
  try {
    const overview = await within(PAGE_PATIENCE_MS, demoOverview(deps, org));
    return { status: 'ok', data: await readLock(org, overview, params) };
  } catch (error) {
    return { status: 'unavailable', ...failureOf(deps, error, deps.now()) };
  }
}
