import { buildStatement, type PublishedStatement } from '@holdfast/books';
import { compareFigures } from './compare';
import { fail, firstFew, pass, type StepResult } from './report';

/**
 * Build the statement again from the published ledger and journal, with the
 * moment, period and settings the published one names, and compare every
 * figure. Amounts in base units must be identical; dollar figures may differ
 * by one part in a million.
 */
export function checkArithmetic(published: PublishedStatement): StepResult {
  const stated = published.statement;
  const recomputed = buildStatement({
    ledger: published.ledger,
    journal: published.journal,
    policy: published.policy,
    now: stated.asOf,
    monthlyBurnUsd: stated.monthlyBurnUsd,
    range: stated.range,
    staleAfterMs: stated.staleAfterMs,
    seriesStep: stated.seriesStep,
  });

  const { compared, differences } = compareFigures(stated, recomputed);
  if (differences.length > 0) {
    const lines = differences.map((d) => `${d.path}: published ${d.published}, recomputed ${d.recomputed}`);
    return fail('arithmetic', `${differences.length} of ${compared} figures differ from what the ledger and the journal give`, firstFew(lines));
  }
  return pass('arithmetic', `all ${compared} figures follow from the ledger and the journal`);
}
