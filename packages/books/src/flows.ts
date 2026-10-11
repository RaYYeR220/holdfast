import { belongsToItsSource, isReceipt, isTreasuryZec, type LedgerEntry } from './entry';
import { isoTime } from './time';

/** Inclusive at both ends, ms; a null end is open. */
export interface DateRange {
  from: number | null;
  to: number | null;
}

export const ALL_TIME: DateRange = { from: null, to: null };

export function inRange(ts: number, range: DateRange): boolean {
  return (range.from === null || ts >= range.from) && (range.to === null || ts <= range.to);
}

export interface ZecFlow {
  zat: bigint;
  usd: number | null;
  count: number;
}

export interface FundingFigures {
  /** Funding credited less funding charged. */
  usd: number | null;
  count: number;
}

export interface FeeFigures {
  networkZat: bigint | null;
  networkUsd: number | null;
  /** Venue fees less rebates. */
  tradeUsd: number | null;
  /** What completed swaps lost between the value sent and the value delivered. */
  swapUsd: number | null;
  totalUsd: number | null;
}

export interface PayoutPeriod {
  /** Calendar month in UTC, `YYYY-MM`. */
  period: string;
  usd: number | null;
  count: number;
}

export interface PayoutPayee {
  payee: string;
  addresses: string[];
  usd: number | null;
  count: number;
}

export interface PayoutAssetTotal {
  chain: string;
  asset: string;
  decimals: number;
  /** Base units paid out. */
  amount: bigint;
}

export interface PayoutFigures {
  usd: number | null;
  count: number;
  byPeriod: PayoutPeriod[];
  byPayee: PayoutPayee[];
  byAsset: PayoutAssetTotal[];
}

export interface Flows {
  receipts: ZecFlow;
  /** ZEC the treasury paid out directly. */
  payments: ZecFlow;
  /** ZEC the treasury sent into swaps: converted, not paid to anyone. */
  swapped: ZecFlow;
  funding: FundingFigures;
  fees: FeeFigures;
  payouts: PayoutFigures;
  /** Ids of entries that have no dollar value; every dollar total they belong to is null. */
  unpriced: string[];
}

/** A total is only a total if every part of it has a value; one unpriced entry leaves it unknown. */
function sumUsd(values: readonly (number | null)[]): number | null {
  let sum = 0;
  for (const value of values) {
    if (value === null) return null;
    sum += value;
  }
  return sum;
}

function monthOf(ts: number): string {
  return isoTime(ts)?.slice(0, 7) ?? 'unknown';
}

/** Dollars that left, as a positive figure. Subtracting from zero keeps an empty total from reading as minus zero. */
function paid(entries: readonly LedgerEntry[]): number | null {
  const usd = sumUsd(entries.map((entry) => entry.usd));
  return usd === null ? null : 0 - usd;
}

function received(entries: readonly LedgerEntry[]): ZecFlow {
  return {
    zat: entries.reduce((sum, entry) => sum + entry.amount, 0n),
    usd: sumUsd(entries.map((entry) => entry.usd)),
    count: entries.length,
  };
}

function sent(entries: readonly LedgerEntry[]): ZecFlow {
  return { zat: -entries.reduce((sum, entry) => sum + entry.amount, 0n), usd: paid(entries), count: entries.length };
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function payoutFigures(payouts: readonly LedgerEntry[]): PayoutFigures {
  return {
    usd: paid(payouts),
    count: payouts.length,
    byPeriod: groupBy(payouts, (entry) => monthOf(entry.ts)).map(([period, entries]) => ({ period, usd: paid(entries), count: entries.length })),
    byPayee: groupBy(payouts, (entry) => entry.counterparty?.name ?? entry.counterparty?.address ?? '').map(([payee, entries]) => ({
      payee,
      addresses: [...new Set(entries.flatMap((entry) => (entry.counterparty === null ? [] : [entry.counterparty.address])))].sort(),
      usd: paid(entries),
      count: entries.length,
    })),
    byAsset: groupBy(payouts, (entry) => `${entry.proof.chain}:${entry.asset}:${entry.decimals}`).map(([, entries]) => {
      const first = entries[0] as LedgerEntry;
      return {
        chain: first.proof.chain,
        asset: first.asset,
        decimals: first.decimals,
        amount: -entries.reduce((sum, entry) => sum + entry.amount, 0n),
      };
    }),
  };
}

/**
 * Value sent into each swap that delivered within the range, less the value
 * it delivered. The two legs are paired by the swap they both name, and a
 * swap with no input leg, or with more than one, has no cost that can be
 * stated.
 */
function swapCost(arrivals: readonly LedgerEntry[], deposits: readonly LedgerEntry[]): number | null {
  return sumUsd(
    arrivals.map((arrival) => {
      const [deposit, ...others] = deposits.filter((entry) => entry.ref === arrival.ref);
      if (deposit === undefined || others.length > 0 || deposit.usd === null || arrival.usd === null) return null;
      return 0 - deposit.usd - arrival.usd;
    }),
  );
}

/**
 * The totals a statement reports for a period, from the ledger alone.
 * `ledger` is everything known; only entries dated inside `range` are counted.
 */
export function summariseFlows(ledger: readonly LedgerEntry[], range: DateRange): Flows {
  // An entry of a kind its source does not produce is checked by nothing and counts towards nothing.
  const known = ledger.filter(belongsToItsSource);
  const entries = known.filter((entry) => inRange(entry.ts, range));
  const ofKind = (...kinds: LedgerEntry['kind'][]) => entries.filter((entry) => kinds.includes(entry.kind));

  const networkFees = ofKind('network_fee');
  const networkUsd = paid(networkFees);
  const tradeUsd = paid(ofKind('trade_fee'));
  // A deposit made before the period still belongs to the swap that delivered inside it.
  const swapUsd = swapCost(
    ofKind('swap_in'),
    known.filter((entry) => entry.kind === 'swap_out'),
  );
  const funding = ofKind('funding');

  return {
    receipts: received(entries.filter(isReceipt)),
    payments: sent(ofKind('payment')),
    swapped: sent(ofKind('swap_out').filter(isTreasuryZec)),
    funding: { usd: sumUsd(funding.map((entry) => entry.usd)), count: funding.length },
    fees: {
      networkZat: -networkFees.reduce((sum, entry) => sum + entry.amount, 0n),
      networkUsd,
      tradeUsd,
      swapUsd,
      totalUsd: sumUsd([networkUsd, tradeUsd, swapUsd]),
    },
    payouts: payoutFigures(ofKind('payout')),
    unpriced: entries.filter((entry) => entry.usd === null).map((entry) => entry.id),
  };
}
