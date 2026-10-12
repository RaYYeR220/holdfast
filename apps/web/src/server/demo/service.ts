import { type Hex, lotsToZec, marginRatio, notionalUsd, zatToLots } from '@holdfast/core';
import type { OrgRecord, PayoutChain } from '@holdfast/db';
import { type JournalEntry, verifyChain } from '@holdfast/engine';
import { formatZec } from '@holdfast/zcash';
import { type AttestationSummary, latestAttestation } from '../attestations/service';
import { gatherBooks, statementOf } from '../books/service';
import type { Deps } from '../deps';
import { ApiError, notFound } from '../errors';
import { JOURNAL, latestEntry, treasuryReading, venueReading } from '../live';
import { tokenOf, txUrlOf } from '../payouts/receipt';
import { type Reading, available, mapReading, missing } from '../reading';
import { messageOf } from '../redact';
import { type KeyScope, keyScopes } from '../safety/scopes';

/**
 * The public face of an organisation that has chosen to be a demo. Every
 * function here builds its answer field by field from what it means to show;
 * no row and no record is passed through whole, except a journal entry,
 * which is covered by its digest and can only be checked whole. An
 * organisation that is not a demo does not exist as far as this module says.
 */

const DATABASE = 'database';
const PAGE = 25;
const MAX_PAGE = 100;
const RECEIPTS_SHOWN = 100;

type DemoDeps = Pick<Deps, 'store' | 'hyperliquid' | 'tempo' | 'solana' | 'attestor' | 'now' | 'redact'>;

export async function demoOrg(deps: Pick<Deps, 'store'>, orgId: string): Promise<OrgRecord> {
  const org = await deps.store.findOrg(orgId);
  if (org === null || !org.publicDemo) throw notFound();
  return org;
}

export async function demoList(deps: Pick<Deps, 'store'>): Promise<{ id: string; name: string }[]> {
  return (await deps.store.listOrgs({ publicDemo: true })).map((org) => ({ id: org.id, name: org.name }));
}

export interface DemoOverview {
  org: { id: string; name: string };
  lockEnabled: boolean;
  lastTick: Reading<{ seq: number; at: number; ageMs: number; mode: JournalEntry['decision']['mode']; digest: Hex }>;
  treasury: Reading<{ zat: bigint; zec: string }>;
  hedge: Reading<{ shortLots: number; shortZec: number; markPx: number; oraclePx: number; notionalUsd: number; accountValueUsd: number }>;
  /** Equity over short notional; null bps when there is no short to hold margin against. */
  marginRatio: Reading<{ bps: number | null }>;
  funding: Reading<{ aprBps: number }>;
  /** The part of the treasury whose dollar value the short fixes. */
  locked: Reading<{ lots: number; zec: number; usd: number }>;
  /** The short against what the policy calls for; it needs the treasury and the venue both. */
  coverage: Reading<{ targetLots: number; bps: number | null }>;
  /** The latest snapshot the HedgeAttestor contract holds of the hedge, read from the chain now; a null value when the current series holds none. */
  attestation: Reading<AttestationSummary | null>;
}

export async function demoOverview(deps: DemoDeps, org: OrgRecord): Promise<DemoOverview> {
  const now = deps.now();
  const latest = await latestEntry(deps, org.id);
  const treasury = treasuryReading(deps, org.policy, latest);
  const [venue, attestation] = await Promise.all([venueReading(deps, org), latestAttestation(deps, org)]);

  const coverage = ((): DemoOverview['coverage'] => {
    if (treasury.status !== 'ok') return treasury;
    if (venue.status !== 'ok') return venue;
    const targetLots = Math.floor((zatToLots(treasury.value.zat) * org.policy.hedgeRatioBps) / 10_000);
    return available('zcash+hyperliquid', Math.min(treasury.readAt, venue.readAt), {
      targetLots,
      bps: targetLots <= 0 ? null : Math.round((venue.value.shortLots / targetLots) * 10_000),
    });
  })();

  return {
    org: { id: org.id, name: org.name },
    lockEnabled: org.lockEnabled,
    lastTick:
      latest === undefined
        ? missing(JOURNAL, now, 'no tick has run for this organisation yet')
        : available(JOURNAL, latest.at, { seq: latest.seq, at: latest.at, ageMs: now - latest.at, mode: latest.decision.mode, digest: latest.digest }),
    treasury: mapReading(treasury, (t) => ({ zat: t.zat, zec: formatZec(t.zat) })),
    hedge: mapReading(venue, (v) => ({
      shortLots: v.shortLots,
      shortZec: lotsToZec(v.shortLots),
      markPx: v.markPx,
      oraclePx: v.oraclePx,
      notionalUsd: notionalUsd(Math.max(0, v.shortLots), v.markPx),
      accountValueUsd: v.accountValueUsd,
    })),
    marginRatio: mapReading(venue, (v) => {
      const ratio = marginRatio(v);
      return { bps: ratio === null ? null : Math.round(ratio * 10_000) };
    }),
    funding: mapReading(venue, (v) => ({ aprBps: v.fundingAprBps })),
    locked: mapReading(venue, (v) => {
      const lots = Math.max(0, v.shortLots);
      return { lots, zec: lotsToZec(lots), usd: notionalUsd(lots, v.markPx) };
    }),
    coverage,
    attestation,
  };
}

/** An entry with the messages of its errors made safe to show. The real scanner already does this; nothing here relies on it. */
function shown(entry: JournalEntry, deps: Pick<Deps, 'redact'>): JournalEntry {
  return { ...entry, errors: entry.errors.map((error) => ({ source: error.source, message: deps.redact(error.message) })) };
}

export interface DemoJournal {
  readAt: number;
  /** Newest first. */
  entries: JournalEntry[];
  /** Whether the entries of this page form an unbroken, untampered chain, checked on the stored entries. */
  chain: { ok: true; fromSeq: number; toSeq: number } | { ok: false; seq: number; reason: string } | null;
  /** Whether the newest entry of the page is the one the organisation's row names as its last; null on a later page. */
  isHead: boolean | null;
  /** Pass as `beforeSeq` for the next page; null when this is the last one. */
  nextBeforeSeq: number | null;
}

export async function demoJournal(deps: Pick<Deps, 'store' | 'now' | 'redact'>, org: OrgRecord, page: { limit?: number | undefined; beforeSeq?: number | undefined }): Promise<DemoJournal> {
  const limit = Math.min(page.limit ?? PAGE, MAX_PAGE);
  const entries = await deps.store.listJournal(org.id, { limit, ...(page.beforeSeq === undefined ? {} : { beforeSeq: page.beforeSeq }) });
  const oldest = entries.at(-1);
  const newest = entries[0];
  let chain: DemoJournal['chain'] = null;
  if (oldest !== undefined && newest !== undefined) {
    const verdict = verifyChain([...entries].reverse(), oldest.prev);
    chain = verdict.ok ? { ok: true, fromSeq: oldest.seq, toSeq: newest.seq } : verdict;
  }
  return {
    readAt: deps.now(),
    entries: entries.map((entry) => shown(entry, deps)),
    chain,
    isHead: newest === undefined || newest.seq !== org.nextSeq - 1 ? null : newest.digest === org.lastDigest,
    nextBeforeSeq: oldest !== undefined && oldest.seq > 1 && entries.length === limit ? oldest.seq : null,
  };
}

export interface DemoReceipt {
  txid: string;
  height: number;
  time: number;
  zat: bigint;
  zec: string;
  memo: string;
  pool: string;
}

/** Payments the treasury received, with their memos, as far as the latest scan reached. */
export async function demoReceipts(deps: Pick<Deps, 'store' | 'now' | 'redact'>, org: OrgRecord): Promise<{ receipts: Reading<{ scannedTo: number | null; items: DemoReceipt[] }> }> {
  const read = treasuryReading(deps, org.policy, await latestEntry(deps, org.id));
  if (read.status !== 'ok') return { receipts: read };
  const notes = await deps.store.notes(org.id);
  const items = notes
    .filter((note) => note.kind === 'incoming')
    .reverse()
    .slice(0, RECEIPTS_SHOWN)
    .map((note) => ({ txid: note.txid, height: note.height, time: note.time, zat: note.zat, zec: formatZec(note.zat), memo: note.memo, pool: note.pool }));
  return { receipts: available(read.source, read.readAt, { scannedTo: org.scannedTo, items }) };
}

export interface DemoPayout {
  id: string;
  chain: PayoutChain;
  token: { address: string; symbol: string | null; decimals: number | null };
  total: bigint;
  paidAt: number | null;
  tx: string | null;
  txUrl: string | null;
  lines: { lineNo: number; amount: bigint; memo: string; receiptToken: string | null }[];
}

/** The runs that were paid, each line with the token of its public receipt. Payees are not named. */
export async function demoPayouts(deps: Pick<Deps, 'store' | 'tempo' | 'solana' | 'now'>, org: OrgRecord): Promise<{ payouts: Reading<DemoPayout[]> }> {
  const runs = (await deps.store.listPayoutRuns(org.id)).filter((run) => run.status === 'paid');
  const payouts = runs.map((run) => ({
    id: run.id,
    chain: run.chain,
    token: tokenOf(run),
    total: run.total,
    paidAt: run.executedAt,
    tx: run.tx,
    txUrl: run.tx === null ? null : txUrlOf(deps, run.chain, run.tx),
    lines: run.lines.map((line) => ({ lineNo: line.lineNo, amount: line.amount, memo: line.memo, receiptToken: line.receiptToken })),
  }));
  return { payouts: available(DATABASE, deps.now(), payouts) };
}

export interface DemoRefusal {
  chain: string;
  kind: string;
  attempted: string;
  outcome: string;
  tx: string | null;
  txUrl: string | null;
  at: number;
}

function refusalUrl(deps: Pick<Deps, 'tempo' | 'solana'>, chain: string, tx: string | null): string | null {
  if (tx === null || (chain !== 'tempo' && chain !== 'solana')) return null;
  return txUrlOf(deps, chain, tx);
}

/** Each key's scope as its chain reports it now, the refusals on record, and the latest snapshot of the hedge the chain holds. */
export async function demoSafety(deps: DemoDeps, org: OrgRecord): Promise<{ keys: KeyScope[]; refusals: Reading<DemoRefusal[]>; attestation: Reading<AttestationSummary | null> }> {
  const [keys, attestation] = await Promise.all([keyScopes(deps, org), latestAttestation(deps, org)]);
  const refusals = (await deps.store.listRefusals(org.id)).map((refusal) => ({
    chain: refusal.chain,
    kind: refusal.kind,
    attempted: refusal.attempted,
    outcome: refusal.outcome,
    tx: refusal.tx,
    txUrl: refusalUrl(deps, refusal.chain, refusal.tx),
    at: refusal.createdAt,
  }));
  return { keys, refusals: available(DATABASE, deps.now(), refusals), attestation };
}

/** The statement's figures without the ledger behind them and without the names of payees. */
export async function demoBooks(deps: DemoDeps, org: OrgRecord) {
  const now = deps.now();
  try {
    const statement = statementOf(deps, org, await gatherBooks(deps, org));
    const { payouts } = statement;
    return {
      books: available('ledger', now, {
        asOf: statement.asOf,
        range: statement.range,
        treasury: statement.treasury,
        hedge: statement.hedge,
        lock: statement.lock,
        receipts: statement.receipts,
        payments: statement.payments,
        swapped: statement.swapped,
        funding: statement.funding,
        fees: statement.fees,
        payouts: payouts === null ? null : { usd: payouts.usd, count: payouts.count, byPeriod: payouts.byPeriod, byAsset: payouts.byAsset },
        runwayMonths: statement.runwayMonths,
        /** Sources whose last reading is too old for the figures that rest on them, which are null above. */
        stale: statement.stale.map((s) => ({ source: s.source, asOf: s.asOf, detail: s.detail })),
      }),
    };
  } catch (error) {
    if (error instanceof ApiError && error.code === 'unavailable') {
      return { books: missing<never>(String(error.details.source ?? 'ledger'), now, deps.redact(messageOf(error))) };
    }
    throw error;
  }
}
