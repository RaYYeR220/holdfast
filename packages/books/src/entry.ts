export const LEDGER_SOURCES = ['zcash', 'swap', 'hyperliquid', 'tempo', 'solana'] as const;
export type LedgerSource = (typeof LEDGER_SOURCES)[number];

/**
 * Listed in the order entries of one moment are shown: money in, then what a
 * spend returned and sent, then what it cost.
 */
export const LEDGER_KINDS = [
  'receipt',
  'receipt_untracked',
  'change',
  'payment',
  'swap_out',
  'network_fee',
  'swap_in',
  'hedge_open',
  'hedge_close',
  'realized_pnl',
  'trade_fee',
  'funding',
  'payout',
] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

/** Where an entry can be checked against its chain. */
export interface Proof {
  chain: string;
  /** Null where the source has no transaction to point at, such as a funding payment. */
  tx: string | null;
  /** Block height, where the source records one. */
  block: number | null;
  url: string | null;
}

export interface Counterparty {
  name: string | null;
  address: string;
}

export interface LedgerEntry {
  id: string;
  /** When it happened on its own chain or venue, ms. */
  ts: number;
  source: LedgerSource;
  kind: LedgerKind;
  asset: string;
  /** Decimals of `amount`; the same symbol can have different ones on different chains. */
  decimals: number;
  /** Signed, in base units: positive adds to what the organisation holds. */
  amount: bigint;
  /** `amount` in dollars at `usdPrice`; null when no price could be applied. */
  usd: number | null;
  /** Dollars per whole unit of `asset`. */
  usdPrice: number | null;
  /** When `usdPrice` was observed, ms. */
  usdPriceAt: number | null;
  /** The reference the entry carries: a memo, a swap id, a client order id. */
  ref: string;
  counterparty: Counterparty | null;
  proof: Proof;
  /** Ids of the other entries of the same transaction, fill or swap. */
  linked: string[];
}

function rank<T>(order: readonly T[], value: T): number {
  const index = order.indexOf(value);
  return index < 0 ? order.length : index;
}

/** Time first; entries of one moment fall back to source, kind and id, so the order never depends on the input's. */
export function compareEntries(a: LedgerEntry, b: LedgerEntry): number {
  return (
    a.ts - b.ts ||
    rank(LEDGER_SOURCES, a.source) - rank(LEDGER_SOURCES, b.source) ||
    rank(LEDGER_KINDS, a.kind) - rank(LEDGER_KINDS, b.kind) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export function isReceipt(entry: LedgerEntry): boolean {
  return entry.kind === 'receipt' || entry.kind === 'receipt_untracked';
}

/** An entry that moved the shielded treasury's own ZEC. */
export function isTreasuryZec(entry: LedgerEntry): boolean {
  return entry.source === 'zcash' && entry.asset === 'ZEC';
}

export function sumAmounts(entries: Iterable<LedgerEntry>): bigint {
  let sum = 0n;
  for (const entry of entries) sum += entry.amount;
  return sum;
}
