import { type PublishedStatement, reconcile } from '@holdfast/books';
import { fail, firstFew, pass, type StepResult } from './report';

/**
 * Hold the published records against each other: every ledger entry against
 * the form the books give it, payout lines against the transfers recorded for
 * them, swaps against the payments that funded them and what arrived, journal
 * orders against fills, and the balance each journal entry recorded against
 * the ledger. An error fails the step; a warning is shown and does not.
 *
 * This is a check of consistency. The payout transfers and the swap records
 * are the publisher's own account of two chains and a swap service that this
 * step does not read, and it says so. Tokens are known only from the list
 * built into the books: the statement cannot bring its own.
 */
export function checkReconciliation(published: PublishedStatement): StepResult {
  const { ledger, journal, payouts, swaps } = published;
  const { matched, problems } = reconcile({ ledger, journal, payouts, swaps });
  const errors = problems.filter((p) => p.severity === 'error');
  const warnings = problems.filter((p) => p.severity === 'warning');
  const details = firstFew([...errors, ...warnings].map((p) => `${p.severity} ${p.kind}: ${p.detail}`));

  if (errors.length > 0) {
    const kinds = [...new Set(errors.map((p) => p.kind))].join(', ');
    return fail('reconciliation', `${errors.length} error${errors.length === 1 ? '' : 's'}: ${kinds}`, details);
  }
  if (matched.length === 0) {
    return fail('reconciliation', 'nothing in the statement could be held against anything else in it', details);
  }

  const unread = [
    ...(payouts.length === 0 ? [] : [`the ${payouts.length} payout run(s) are held against the transfers the statement itself lists; Tempo and Solana were not read`]),
    ...(swaps.length === 0 ? [] : [`the ${swaps.length} swap(s) are held against the statement's own swap records; the swap service was not asked`]),
  ];
  const noted = warnings.length === 0 ? 'nothing disagrees' : `no errors, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`;
  return pass('reconciliation', `the statement's records agree with each other in ${matched.length} places; ${noted}`, [...details, ...unread]);
}
