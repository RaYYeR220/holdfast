import type { PayoutResult } from '@holdfast/core';
import type { PayoutCost } from './cost';

/**
 * - `paid`: the lines asked for are paid, and `tx` is the transaction that
 *   paid them: one this call sent, or one that was read from the chain and
 *   compared with them. A run is never called paid on a run marker alone.
 * - `failed`: a transaction was sent and it is certain that it paid nothing.
 *   `tx` is that transaction if it failed on chain, null if it expired.
 * - `unknown`: whether the lines asked for are paid could not be settled,
 *   and the run must not be treated as unpaid. Either a transaction for it
 *   is on its way or has not settled, and `tx` names it; or the run id is
 *   spent, its marker being set on chain, while the payment behind it could
 *   not be read to compare, in which case `tx` is null and `historyError`
 *   says why. Calling pay() again is safe: the chain accepts one payout per
 *   run id, whoever sends the second.
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
   * it was. What follows from that depends on the run. One that was sent
   * regardless, its missing marker being enough, went without the look for
   * a payment made by hand. One that was refused or answered `unknown`
   * because of it says so in `error`.
   */
  historyError: string | null;
}

/** What pay() would do with a run, worked out without sending anything. */
export interface PayoutPreview {
  /** Whether pay() would go ahead: send the run, or answer with a payment of these lines that was already made. */
  ok: boolean;
  error: string | null;
  /**
   * Whether these lines are already paid: a payment under the run id was
   * read from the chain, has settled, and paid them. It is not true of a run
   * id that is merely spent.
   */
  alreadyPaid: boolean;
  /**
   * Whether the run id is taken, so that pay() would send nothing: its
   * marker is set on chain, or a payment under it was read. With
   * `alreadyPaid` false, that payment paid other lines or has not settled,
   * as `error` says, or it could not be read to compare, and `historyError`
   * says why.
   */
  spent: boolean;
  /** The payment under this run id, when one was read. */
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
