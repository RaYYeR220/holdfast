import { type PublishedStatement, reconcile } from '@holdfast/books';
import { fail, firstFew, pass, type StepResult } from './report';

/**
 * Hold the published records against each other: payout lines against the
 * transfers found on chain, swaps against the payments that funded them and
 * what arrived, journal orders against fills, and the balance each journal
 * entry recorded against the ledger. An error fails the step; a warning is
 * shown and does not.
 */
export function checkReconciliation(published: PublishedStatement): StepResult {
  const { matched, problems } = reconcile(published);
  const errors = problems.filter((p) => p.severity === 'error');
  const warnings = problems.filter((p) => p.severity === 'warning');
  const details = firstFew([...errors, ...warnings].map((p) => `${p.severity} ${p.kind}: ${p.detail}`));

  if (errors.length > 0) {
    const kinds = [...new Set(errors.map((p) => p.kind))].join(', ');
    return fail('reconciliation', `${errors.length} error${errors.length === 1 ? '' : 's'}: ${kinds}`, details);
  }
  const noted = warnings.length === 0 ? 'nothing disagrees' : `no errors, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`;
  return pass('reconciliation', `${matched.length} matches between payouts, swaps, orders, balances and their evidence; ${noted}`, details);
}
