import { driftUsd, isFresh, isUsablePrice, marginRatio, notionalUsd, type Policy, runwayMonths, zatToLots, zatToZec } from '@holdfast/core';
import type { JournalEntry } from '@holdfast/engine';
import { isTreasuryZec, type LedgerEntry, sumAmounts } from './entry';
import { ALL_TIME, type DateRange, type FeeFigures, type FundingFigures, inRange, type PayoutFigures, summariseFlows, type ZecFlow } from './flows';
import { type Timeline, type TimelinePoint, walkJournal } from './timeline';

export type SeriesStep = 'entry' | 'day';

export interface TreasuryFigures {
  /** What the treasury's ledger entries add up to; null while the chain reading behind them is stale. */
  zat: bigint | null;
  /** The part of it received in a pool whose spends a viewing key cannot follow. */
  untrackedZat: bigint | null;
  /** When the journal last read the treasury. */
  asOf: number | null;
  px: number | null;
  pxAt: number | null;
  usd: number | null;
}

export interface HedgeFigures {
  asOf: number;
  /** Short size in lots of 0.01 ZEC; negative if the account is long. */
  shortLots: number;
  markPx: number;
  notionalUsd: number;
  accountValueUsd: number;
  /** Equity over short notional; null without a short. */
  marginRatioBps: number | null;
  /** Lots the policy calls for against the treasury read at the same moment; null when it was not read. */
  targetLots: number | null;
  coverageBps: number | null;
  fundingAprBps: number;
}

export interface LockFigures {
  lockedAt: number;
  lockedSeq: number;
  navAtLockUsd: number | null;
  navNowUsd: number | null;
  /** Receipts less payments and payouts since the lock. */
  externalFlowsUsd: number | null;
  /** Change in value since the lock that is not money arriving or leaving on purpose. */
  driftUsd: number | null;
  /** The same two figures for the same holdings left unhedged. */
  unhedgedNowUsd: number | null;
  unhedgedDriftUsd: number | null;
}

export interface SeriesPoint {
  t: number;
  seq: number;
  px: number | null;
  lockedUsd: number | null;
  unhedgedUsd: number | null;
}

export type StatementSource = 'journal' | 'zcash' | 'hyperliquid' | 'reference';

export interface StaleSource {
  source: StatementSource;
  /** When the source was last read; null if the journal holds no reading of it. */
  asOf: number | null;
  detail: string;
}

/**
 * The figures the app and an auditor see. A section is null when its source
 * could not be read recently enough, or when it lies outside an auditor's
 * scope; it is never filled with an older or an estimated number.
 */
export interface Statement {
  asOf: number;
  /** Period the flow figures and the series cover. */
  range: DateRange;
  monthlyBurnUsd: number | null;
  staleAfterMs: number;
  seriesStep: SeriesStep;
  treasury: TreasuryFigures | null;
  hedge: HedgeFigures | null;
  lock: LockFigures | null;
  receipts: ZecFlow | null;
  /** ZEC paid out of the treasury directly. */
  payments: ZecFlow | null;
  /** ZEC the treasury sent into swaps. With receipts, payments and network fees it accounts for the balance. */
  swapped: ZecFlow | null;
  funding: FundingFigures | null;
  fees: FeeFigures;
  payouts: PayoutFigures | null;
  runwayMonths: number | null;
  series: SeriesPoint[];
  stale: StaleSource[];
  /** Ledger entries in the period that have no dollar value; dollar totals that include one are null. */
  unpriced: string[];
}

export interface StatementInput {
  ledger: readonly LedgerEntry[];
  journal: readonly JournalEntry[];
  policy: Policy;
  now: number;
  monthlyBurnUsd: number | null;
  range?: DateRange;
  /** Age past which a reading no longer counts as current; the policy's data age limit unless set. */
  staleAfterMs?: number;
  /** One series point per journal entry, or the last entry of each UTC day. */
  seriesStep?: SeriesStep;
}

const DAY_MS = 86_400_000;

type Snapshot = JournalEntry['snapshot'];

interface Readings {
  latest: JournalEntry | undefined;
  treasury: { entry: JournalEntry; reading: NonNullable<Snapshot['treasury']> } | undefined;
  hl: { entry: JournalEntry; reading: NonNullable<Snapshot['hl']> } | undefined;
  ref: { entry: JournalEntry; reading: NonNullable<Snapshot['ref']> } | undefined;
}

/** The most recent time the journal read each source. */
function latestReadings(journal: readonly JournalEntry[]): Readings {
  const readings: Readings = { latest: journal.at(-1), treasury: undefined, hl: undefined, ref: undefined };
  for (let i = journal.length - 1; i >= 0 && (readings.treasury === undefined || readings.hl === undefined || readings.ref === undefined); i--) {
    const entry = journal[i] as JournalEntry;
    const { treasury, hl, ref } = entry.snapshot;
    if (readings.treasury === undefined && treasury !== null) readings.treasury = { entry, reading: treasury };
    if (readings.hl === undefined && hl !== null) readings.hl = { entry, reading: hl };
    if (readings.ref === undefined && ref !== null) readings.ref = { entry, reading: ref };
  }
  return readings;
}

function staleness(source: StatementSource, what: string, asOf: number | undefined, now: number, maxAgeMs: number): StaleSource | null {
  if (asOf === undefined) return { source, asOf: null, detail: `the journal holds no ${what}` };
  if (isFresh(asOf, now, maxAgeMs)) return null;
  const age = now - asOf;
  const detail = age < 0 ? `the last ${what} is dated after the statement` : `the last ${what} is ${Math.round(age / 1000)} s old, over the ${Math.round(maxAgeMs / 1000)} s allowed`;
  return { source, asOf, detail };
}

function hedgeFigures(found: NonNullable<Readings['hl']>, policy: Policy): HedgeFigures | null {
  const hl = found.reading;
  if (!isUsablePrice(hl.markPx) || !Number.isFinite(hl.accountValueUsd) || !Number.isInteger(hl.shortLots)) return null;
  const ratio = marginRatio(hl);
  const treasury = found.entry.snapshot.treasury;
  const targetLots = treasury === null ? null : Math.floor((zatToLots(BigInt(treasury.zat)) * policy.hedgeRatioBps) / 10_000);
  return {
    asOf: hl.asOf,
    shortLots: hl.shortLots,
    markPx: hl.markPx,
    notionalUsd: notionalUsd(hl.shortLots, hl.markPx),
    accountValueUsd: hl.accountValueUsd,
    marginRatioBps: ratio === null ? null : Math.round(ratio * 10_000),
    targetLots,
    coverageBps: targetLots === null || targetLots <= 0 ? null : Math.round((hl.shortLots / targetLots) * 10_000),
    fundingAprBps: hl.fundingAprBps,
  };
}

/**
 * Value at the lock against value now. "Now" is the latest journal entry that
 * read both the treasury and the venue recently enough; without one there is
 * a lock but nothing current to hold against it.
 */
function lockFigures(timeline: Timeline, current: TimelinePoint | undefined): LockFigures | null {
  const lock = timeline.lock;
  if (lock === null) return null;

  const figures: LockFigures = {
    lockedAt: lock.at,
    lockedSeq: lock.seq,
    navAtLockUsd: lock.navUsd,
    navNowUsd: null,
    externalFlowsUsd: null,
    driftUsd: null,
    unhedgedNowUsd: null,
    unhedgedDriftUsd: null,
  };
  if (current === undefined) return figures;

  // The entry that opened the lock is its own starting point: nothing has
  // flowed since. Any other entry counts only if it was written under this lock.
  const flowsSince = current.seq === lock.seq ? 0 : current.lock?.seq === lock.seq ? current.lock.externalUsd : undefined;
  if (flowsSince === undefined) return figures;

  figures.navNowUsd = current.navUsd;
  figures.externalFlowsUsd = flowsSince;
  figures.unhedgedNowUsd = current.unhedgedUsd;
  if (lock.navUsd !== null && flowsSince !== null) {
    const since = { navAtLock: lock.navUsd, externalFlowsUsd: flowsSince };
    if (current.navUsd !== null) figures.driftUsd = driftUsd({ navNow: current.navUsd, ...since });
    if (current.unhedgedUsd !== null) figures.unhedgedDriftUsd = driftUsd({ navNow: current.unhedgedUsd, ...since });
  }
  return figures;
}

function series(points: readonly TimelinePoint[], range: DateRange, step: SeriesStep): SeriesPoint[] {
  const inside = points.filter((point) => inRange(point.at, range));
  const kept = step === 'entry' ? inside : inside.filter((point, i) => Math.floor(point.at / DAY_MS) !== Math.floor((inside[i + 1]?.at ?? Infinity) / DAY_MS));
  return kept.map((point) => ({ t: point.at, seq: point.seq, px: point.px, lockedUsd: point.navUsd, unhedgedUsd: point.unhedgedUsd }));
}

/**
 * The statement as of `now`.
 *
 * Totals for the period come from the ledger. Figures that describe the
 * present come from the latest journal entry that read their source recently
 * enough. The treasury balance is the sum of the ledger's own entries;
 * `reconcile` is what holds that sum against the balances the journal recorded.
 */
export function buildStatement(input: StatementInput): Statement {
  const { ledger, policy, now } = input;
  const journal = [...input.journal].sort((a, b) => a.seq - b.seq);
  const range = input.range ?? ALL_TIME;
  const staleAfterMs = input.staleAfterMs ?? policy.maxDataAgeMs;
  const seriesStep = input.seriesStep ?? 'day';

  const readings = latestReadings(journal);
  const stale = [
    staleness('journal', 'entry', readings.latest?.at, now, staleAfterMs),
    staleness('zcash', 'treasury reading', readings.treasury?.reading.asOf, now, staleAfterMs),
    staleness('hyperliquid', 'venue reading', readings.hl?.reading.asOf, now, staleAfterMs),
    staleness('reference', 'reference price', readings.ref?.reading.asOf, now, staleAfterMs),
  ].filter((s): s is StaleSource => s !== null);
  const fresh = (source: StatementSource) => !stale.some((s) => s.source === source);

  const venue = fresh('hyperliquid') ? readings.hl : undefined;
  const hedge = venue === undefined ? null : hedgeFigures(venue, policy);
  if (venue !== undefined && hedge === null) {
    stale.push({ source: 'hyperliquid', asOf: venue.reading.asOf, detail: 'the last venue reading is malformed' });
  }

  // The venue's mark values the treasury where it is current; the reference price stands in when it is not.
  const price =
    hedge !== null
      ? { px: hedge.markPx, at: hedge.asOf }
      : readings.ref !== undefined && fresh('reference') && isUsablePrice(readings.ref.reading.px)
        ? { px: readings.ref.reading.px, at: readings.ref.reading.asOf }
        : null;

  const treasuryEntries = ledger.filter(isTreasuryZec);
  const zat = fresh('zcash') ? sumAmounts(treasuryEntries) : null;
  const treasury: TreasuryFigures = {
    zat,
    untrackedZat: zat === null ? null : sumAmounts(treasuryEntries.filter((entry) => entry.kind === 'receipt_untracked')),
    asOf: readings.treasury?.reading.asOf ?? null,
    px: price?.px ?? null,
    pxAt: price?.at ?? null,
    usd: zat === null || price === null ? null : zatToZec(zat) * price.px,
  };

  const timeline = walkJournal(journal, ledger);
  const pointBySeq = new Map(timeline.points.map((point) => [point.seq, point]));
  const current = journal.findLast((entry) => {
    const { treasury: t, hl } = entry.snapshot;
    return t !== null && hl !== null && isFresh(t.asOf, now, staleAfterMs) && isFresh(hl.asOf, now, staleAfterMs);
  });
  const currentPoint = current === undefined ? undefined : pointBySeq.get(current.seq);
  const navNow = currentPoint?.navUsd ?? null;

  const flows = summariseFlows(ledger, range);
  return {
    asOf: now,
    range,
    monthlyBurnUsd: input.monthlyBurnUsd,
    staleAfterMs,
    seriesStep,
    treasury,
    hedge,
    lock: lockFigures(timeline, currentPoint),
    receipts: flows.receipts,
    payments: flows.payments,
    swapped: flows.swapped,
    funding: flows.funding,
    fees: flows.fees,
    payouts: flows.payouts,
    runwayMonths: navNow === null ? null : runwayMonths(navNow, input.monthlyBurnUsd ?? 0),
    series: series(timeline.points, range, seriesStep),
    stale,
    unpriced: flows.unpriced,
  };
}
