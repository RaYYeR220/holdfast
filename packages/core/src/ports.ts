import type { Zat } from './units';

/**
 * What the controller needs from the outside world. Each chain adapter
 * implements one of these; the orchestrator and the tests depend only on the
 * interfaces.
 */

export interface Receipt {
  txid: string;
  height: number;
  /** Block time, ms. */
  time: number;
  zat: Zat;
  memo: string;
  pool: 'sapling' | 'orchard' | 'ironwood';
  /** Present when the viewing key can derive it; used to notice spends. */
  nullifier: string | null;
}

export interface ScanResult {
  receipts: Receipt[];
  /** Nullifiers of known notes that were spent in the scanned range. */
  spentNullifiers: string[];
}

export interface TreasuryScanner {
  tip(): Promise<number>;
  scan(i: { ufvk: string; fromHeight: number; toHeight: number; knownNullifiers: string[] }): Promise<ScanResult>;
}

export interface VenueState {
  asOf: number;
  markPx: number;
  oraclePx: number;
  /** Short size in lots; negative when the account is long. */
  shortLots: number;
  accountValueUsd: number;
}

export interface OrderRequest {
  user: string;
  side: 'buy' | 'sell';
  lots: number;
  limitPx: number;
  reduceOnly: boolean;
  /** Deterministic client order id; a repeated request must not trade twice. */
  cloid: `0x${string}`;
}

export interface OrderResult {
  ok: boolean;
  filledLots: number;
  avgPx: number | null;
  oid: string | null;
  error: string | null;
}

export interface HedgeVenue {
  state(user: string): Promise<VenueState>;
  /** Trailing funding APR paid to shorts over the last `hours`. */
  fundingAprBps(hours: number): Promise<number>;
  place(order: OrderRequest): Promise<OrderResult>;
}

export interface PayoutLine {
  to: string;
  /** Token base units. */
  amount: bigint;
  /** Human-readable reference carried on chain. */
  memo: string;
}

export interface PayoutAllowance {
  remaining: bigint;
  limit: bigint | null;
  /** When a periodic limit refills, ms; null for a one-off allowance. */
  resetsAt: number | null;
}

export interface PayoutResult {
  ok: boolean;
  tx: string | null;
  error: string | null;
}

export interface PayoutRail {
  chain: 'tempo' | 'solana';
  remaining(account: string): Promise<PayoutAllowance>;
  pay(i: { account: string; lines: PayoutLine[]; runId: string }): Promise<PayoutResult>;
}

export interface ReferencePrice {
  zecUsd(): Promise<{ px: number; asOf: number }>;
}
