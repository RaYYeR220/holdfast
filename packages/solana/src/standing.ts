import type { SettledCommitment } from './connection';
import type { PayoutCost } from './cost';
import { isSameRun, type PaidLine, type RequestedLine } from './reconcile';
import { refused, type PayoutPreview, type SolanaPayoutResult } from './results';
import type { FoundRun } from './search';

/** A payment of a run as read from the chain, as far as telling it from another request takes. */
export interface PaidRun {
  tx: string;
  transfers: readonly PaidLine[];
  /** Known only when this rail paid the run itself. */
  cost: PayoutCost | null;
}

/**
 * How a run id that is taken stands to the lines now asked for. A verdict
 * says what was established and no more:
 *
 * - `matches`: a payment was read, it has settled, and it paid these lines.
 * - `differs`: a payment was read, settled or not, and it paid other lines.
 * - `pending`: a payment of these lines was read and has not settled yet.
 * - `unread`: the run marker is set, so a payout under the run id landed
 *   and none can land again, but that payout could not be read. Whether it
 *   paid these lines is not known.
 */
export interface Standing {
  verdict: 'matches' | 'differs' | 'pending' | 'unread';
  /** The payment, where it was read. */
  tx: string | null;
  /** What there is to say when the verdict is not `matches`, apart from what the caller did about it. */
  error: string | null;
  lineMemos: boolean;
  cost: PayoutCost | null;
  /** Why the payment could not be read, for `unread`. */
  historyError: string | null;
}

/** The part of a request that an earlier payment is held against. */
interface Asked {
  runId: string;
  payees: readonly RequestedLine[];
}

const carriesLineMemos = (transfers: readonly PaidLine[]): boolean => transfers.some(transfer => transfer.memo !== null);
const differs = (tx: string, error: string): Standing => ({
  verdict: 'differs',
  tx,
  error,
  lineMemos: false,
  cost: null,
  historyError: null,
});

/** A payment that was read and has settled, compared with what is asked for. */
export function standingOfPaid({ runId, payees }: Asked, paid: PaidRun): Standing {
  if (!isSameRun(paid.transfers, payees)) {
    return differs(paid.tx, `run ${runId} was already paid by ${paid.tx} with different lines`);
  }
  return {
    verdict: 'matches',
    tx: paid.tx,
    error: null,
    lineMemos: carriesLineMemos(paid.transfers),
    cost: paid.cost,
    historyError: null,
  };
}

/** A payment that was read and has not reached the commitment of the rail, compared with what is asked for. */
export function standingOfPending({ runId, payees }: Asked, { run }: FoundRun, commitment: SettledCommitment): Standing {
  if (!isSameRun(run.transfers, payees)) {
    return differs(run.signature, `run ${runId} is already on chain as ${run.signature} with different lines`);
  }
  return {
    verdict: 'pending',
    tx: run.signature,
    error: `run ${runId} is on chain as ${run.signature} but has not reached ${commitment} yet`,
    lineMemos: carriesLineMemos(run.transfers),
    cost: null,
    historyError: null,
  };
}

/** A run id whose marker is set and whose payment could not be read, for the reason given. */
export function standingUnread({ runId }: Asked, reason: string): Standing {
  return {
    verdict: 'unread',
    tx: null,
    error: `run ${runId} is spent: its marker is set on chain, but the payment could not be read to compare it with these lines`,
    lineMemos: false,
    cost: null,
    historyError: reason,
  };
}

/**
 * What pay() answers for a run id that is taken. Only `matches` is answered
 * as paid. `outrun` is a payout this call sent and the chain turned away at
 * its marker, when there was one.
 */
export function answerTaken(standing: Standing, outrun?: string): SolanaPayoutResult {
  const { verdict, tx, lineMemos, cost, historyError } = standing;
  if (verdict === 'matches') {
    return { ok: true, outcome: 'paid', tx, error: null, replayed: true, lineMemos, cost, historyError };
  }
  const sent = outrun ? `transaction ${outrun} was sent for these, failed, and moved nothing` : 'nothing was sent';
  if (verdict === 'differs') return refused(`${standing.error}; ${sent}`);
  // A payment that is only waiting to settle needs no word about sending unless something was sent.
  const error = verdict === 'pending' && !outrun ? standing.error : `${standing.error}; ${sent}`;
  return { ok: false, outcome: 'unknown', tx, error, replayed: true, lineMemos, cost: null, historyError };
}

/** What preview() says of a run id that is taken. */
export function previewTaken({ verdict, tx, error, lineMemos, cost, historyError }: Standing): PayoutPreview {
  const matches = verdict === 'matches';
  return { ok: matches, error, alreadyPaid: matches, spent: true, paidBy: tx, lineMemos, cost, historyError };
}
