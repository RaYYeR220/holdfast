import type { JournalEntry } from '@holdfast/engine';
import { checkBalances } from './checks/balance';
import { checkOrders } from './checks/orders';
import { checkPayouts } from './checks/payouts';
import { checkSwaps } from './checks/swaps';
import type { LedgerEntry } from './entry';
import type { PayoutEvidence } from './evidence';
import { Findings, type Reconciliation, runRef, swapRef } from './problems';
import type { SwapRecord } from './records';

export interface ReconcileInput {
  ledger: readonly LedgerEntry[];
  journal: readonly JournalEntry[];
  /** Every payout run beside what its chain shows for it. */
  payouts?: readonly PayoutEvidence[];
  swaps?: readonly SwapRecord[];
}

/** A record given twice would be matched twice, or once and hide that the other copy differs. */
function checkDuplicates<T>(items: readonly T[], what: string, key: (item: T) => string, ref: (key: string) => string, out: Findings): void {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  for (const [id, count] of counts) {
    if (count > 1) out.error('duplicate_record', `${what} ${id} appears ${count} times`, ref(id));
  }
}

/**
 * Hold the records that must agree against each other and say what does not.
 *
 * Nothing here throws on bad data. A check that cannot read what it was given
 * reports that as a problem, and the other checks still run.
 */
export function reconcile(input: ReconcileInput): Reconciliation {
  const out = new Findings();
  const payouts = input.payouts ?? [];
  const swaps = input.swaps ?? [];

  const attempt = (what: string, check: () => void) => {
    try {
      check();
    } catch (e) {
      out.error('unreadable', `${what} could not be reconciled: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  attempt('the records', () => {
    checkDuplicates(input.ledger, 'ledger entry', (entry) => entry.id, (id) => id, out);
    checkDuplicates(swaps, 'swap', (swap) => swap.id, swapRef, out);
    checkDuplicates(payouts, 'payout run', (p) => p.run.id, runRef, out);
    for (const { run } of payouts) {
      checkDuplicates(run.lines, `line of run ${run.id} numbered`, (line) => String(line.lineNo), () => runRef(run.id), out);
    }
  });
  attempt('payouts', () => checkPayouts(payouts, input.ledger, out));
  attempt('swaps', () => checkSwaps(swaps, input.ledger, out));
  attempt('orders', () => checkOrders(input.journal, input.ledger, out));
  attempt('treasury balances', () => checkBalances(input.journal, input.ledger, out));

  return { matched: out.matched, problems: out.problems };
}
