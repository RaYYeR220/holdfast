import type { PayoutResult } from '@holdfast/core';
import type { PayoutCost } from './cost';

/**
 * - `paid`: the run is paid. `tx` is the transaction that paid it, or null
 *   when the run is marked paid on chain but that transaction could not be
 *   read from history; `historyError` then says why.
 * - `failed`: a transaction was sent and it is certain that it paid nothing.
 *   `tx` is that transaction if it failed on chain, null if it expired.
 * - `unknown`: a transaction was sent and may still pay; `tx` names it. The
 *   run must not be treated as unpaid. Calling pay() again is safe: the
 *   chain accepts one payment per run, whoever sends the second.
 * - `refused`: nothing was paid. Nothing was sent either, with one exception
 *   that the error spells out: a payout that reached the chain after another
 *   payout of the same run id with different lines, and was turned away.
 */
export type PayoutOutcome = 'paid' | 'failed' | 'unknown' | 'refused';

export interface SolanaPayoutResult extends PayoutResult {
  outcome: PayoutOutcome;
  /** True when this call paid nothing itself because the run was already paid or already on its way. */
  replayed: boolean;
  /** Whether each line's memo went on chain. False when only the run memo fit. */
  lineMemos: boolean;
  /**
   * SOL the run takes from the service key; null where that was not worked
   * out. For a payout the chain turned away because the run was already
   * paid, it is the fee of that transaction and nothing else.
   */
  cost: PayoutCost | null;
  /**
   * Why the history of the paying account could not be read, or null when
   * it was. A payment does not wait for history: what is missing without it
   * is the description of an earlier payment, the comparison of its lines
   * with the ones asked for, and the notice of a payment made without a run
   * marker.
   */
  historyError: string | null;
}

/** What pay() would do with a run, worked out without sending anything. */
export interface PayoutPreview {
  /** Whether pay() would go ahead: send the run, or answer with the payment already made. */
  ok: boolean;
  error: string | null;
  /** Whether the run is already paid. */
  alreadyPaid: boolean;
  /** The transaction that paid this run id, when there is one and it could be read. */
  paidBy: string | null;
  lineMemos: boolean;
  cost: PayoutCost | null;
  /** As in {@link SolanaPayoutResult}. */
  historyError: string | null;
}

/** What became of a transaction that was sent in order to be refused by the chain. */
export interface RefusalProbe {
  /** The probe transaction, or null when none was sent. */
  signature: string | null;
  /** True only when the transaction was read back from the chain with an error. */
  failedOnChain: boolean;
  error: string | null;
}

export type AllowanceProbe = RefusalProbe;
export type RepeatRunProbe = RefusalProbe;

export function refused(error: string, cost: PayoutCost | null = null): SolanaPayoutResult {
  return { ok: false, outcome: 'refused', tx: null, error, replayed: false, lineMemos: false, cost, historyError: null };
}
