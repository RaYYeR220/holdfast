import type { Zat } from './units';

/**
 * What the controller needs from the outside world. Each chain adapter
 * implements one of these; the orchestrator and the tests depend only on the
 * interfaces.
 */

export type ShieldedPool = 'sapling' | 'orchard' | 'ironwood';

/** A note the treasury owns: money that came in, or change from its own spend. */
export interface OwnedNote {
  /** Stable identity of the note across rescans. */
  id: string;
  txid: string;
  height: number;
  /** Block time, ms. */
  time: number;
  zat: Zat;
  memo: string;
  pool: ShieldedPool;
  kind: 'incoming' | 'change';
  /**
   * Lets a later scan notice the spend. Null for pools where the viewing key
   * cannot derive it here; such notes are counted but their spends are not seen.
   */
  nullifier: string | null;
  /** Spent later inside the same scanned range. */
  spent: boolean;
}

/** Value the treasury sent out, as far as a viewing key can tell. */
export interface OutgoingPayment {
  id: string;
  txid: string;
  height: number;
  time: number;
  zat: Zat;
  memo: string;
  pool: ShieldedPool | 'transparent';
}

export interface ScanResult {
  notes: OwnedNote[];
  outgoing: OutgoingPayment[];
  /** Fees paid by transactions the treasury sent. */
  fees: { txid: string; zat: Zat }[];
  /** Nullifiers of previously known notes that were spent in the scanned range. */
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
