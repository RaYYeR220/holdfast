import type { PayoutResult } from '@holdfast/core';
import type { PayoutCost } from './cost';

/**
 * - `paid`: the run is on chain; `tx` is the transaction that paid it.
 * - `failed`: a transaction was sent and it is certain that it paid nothing.
 *   `tx` is that transaction if it failed on chain, null if it expired.
 * - `unknown`: a transaction was sent and may still pay; `tx` names it. The
 *   run must not be treated as unpaid. Calling pay() again is safe on the
 *   same rail, which follows that transaction instead of sending another. A
 *   restarted rail has only the chain to go by and cannot see a transaction
 *   that has not landed yet, so wait for `tx` to settle before retrying there.
 * - `refused`: nothing was sent.
 */
export type PayoutOutcome = 'paid' | 'failed' | 'unknown' | 'refused';

export interface SolanaPayoutResult extends PayoutResult {
  outcome: PayoutOutcome;
  /** True when this call sent nothing because the run was already paid or already on its way. */
  replayed: boolean;
  /** Whether each line's memo went on chain. False when only the run memo fit. */
  lineMemos: boolean;
  /** SOL the run takes from the service key; null where that was not worked out. */
  cost: PayoutCost | null;
}

/** What pay() would do with a run, worked out without sending anything. */
export interface PayoutPreview {
  /** Whether pay() would go ahead: send the run, or return the transaction that already paid it. */
  ok: boolean;
  error: string | null;
  /** The transaction that already paid this run id, if there is one. */
  paidBy: string | null;
  lineMemos: boolean;
  cost: PayoutCost | null;
}

export interface AllowanceProbe {
  /** The probe transaction, or null when none was sent. */
  signature: string | null;
  /** True only when the transaction was read back from the chain with an error. */
  failedOnChain: boolean;
  error: string | null;
}

export function refused(error: string, cost: PayoutCost | null = null): SolanaPayoutResult {
  return { ok: false, outcome: 'refused', tx: null, error, replayed: false, lineMemos: false, cost };
}
