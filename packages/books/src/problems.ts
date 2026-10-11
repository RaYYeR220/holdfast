export type Severity = 'error' | 'warning';

export const PROBLEM_KINDS = [
  // Payout lines against the transfers found on chain.
  'missing_transfer',
  'wrong_amount',
  'wrong_recipient',
  'duplicate_memo',
  'unexpected_transfer',
  'memo_not_on_chain',
  'run_total_mismatch',
  'run_status_mismatch',
  'run_tx_mismatch',
  'run_unsettled',
  'payout_ledger_mismatch',
  // Swaps against the treasury payments that funded them and what arrived.
  'unfunded_swap',
  'swap_funding_mismatch',
  'swap_arrival_missing',
  'swap_arrival_mismatch',
  'swap_below_minimum',
  'swap_unsettled',
  'swap_entry_without_swap',
  // Orders in the journal against fills on the venue.
  'order_without_fill',
  'fill_without_order',
  'fill_size_mismatch',
  'fill_side_mismatch',
  'duplicate_cloid',
  // Balances the journal recorded against the ledger.
  'balance_mismatch',
  'balance_unverifiable',
  // The records themselves.
  'duplicate_record',
  'unreadable',
] as const;
export type ProblemKind = (typeof PROBLEM_KINDS)[number];

export interface Problem {
  kind: ProblemKind;
  severity: Severity;
  detail: string;
  /** Ledger entry ids, `run:<id>`, `swap:<id>`, `journal:<seq>` or transaction ids the problem is about. */
  refs: string[];
}

export type MatchKind = 'payout_line' | 'swap' | 'order' | 'balance';

export interface Match {
  kind: MatchKind;
  refs: string[];
}

export interface Reconciliation {
  matched: Match[];
  problems: Problem[];
}

export const journalRef = (seq: number): string => `journal:${seq}`;
export const runRef = (runId: string): string => `run:${runId}`;
export const swapRef = (swapId: string): string => `swap:${swapId}`;

/** Collects what the checks find. */
export class Findings implements Reconciliation {
  readonly matched: Match[] = [];
  readonly problems: Problem[] = [];

  match(kind: MatchKind, ...refs: string[]): void {
    this.matched.push({ kind, refs });
  }

  error(kind: ProblemKind, detail: string, ...refs: string[]): void {
    this.problems.push({ kind, severity: 'error', detail, refs });
  }

  warn(kind: ProblemKind, detail: string, ...refs: string[]): void {
    this.problems.push({ kind, severity: 'warning', detail, refs });
  }
}
