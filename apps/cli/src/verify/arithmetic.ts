import { buildStatement, policyInForce, type PublishedStatement } from '@holdfast/books';
import { MAX_FUTURE_SKEW_MS } from '@holdfast/core';
import { compareFigures } from './compare';
import { fail, firstFew, pass, type StepResult } from './report';

/**
 * Build the statement again from the published ledger and journal and compare
 * every figure. Amounts in base units must be identical; dollar figures may
 * differ by one part in a million.
 *
 * The statement names its own moment, period and series step, and the figures
 * are recomputed for those. It does not get to name how old a reading may be
 * and still count as current, nor the policy: both come from the policy the
 * journal shows to be in force, so a statement cannot present a dead source
 * as a live one by allowing itself more time.
 */
export function checkArithmetic(published: PublishedStatement, now: number): StepResult {
  const stated = published.statement;
  if (stated.asOf > now + MAX_FUTURE_SKEW_MS) return fail('arithmetic', 'the statement is dated in the future');

  const policy = policyInForce(published.policy, published.journal);
  if (policy === null) return fail('arithmetic', 'the journal was not written under the published policy, so there is no policy to recompute under');

  const recomputed = buildStatement({
    ledger: published.ledger,
    journal: published.journal,
    policy,
    now: stated.asOf,
    monthlyBurnUsd: stated.monthlyBurnUsd,
    range: stated.range,
    staleAfterMs: policy.maxDataAgeMs,
    seriesStep: stated.seriesStep,
  });

  const { compared, differences } = compareFigures(stated, recomputed);
  if (differences.length > 0) {
    const lines = differences.map((d) => `${d.path}: published ${d.published}, recomputed ${d.recomputed}`);
    return fail('arithmetic', `${differences.length} of ${compared} figures differ from what the ledger and the journal give`, firstFew(lines));
  }

  const period = stated.range.from === null && stated.range.to === null ? [] : ['the totals are for the period the statement names, not for all time'];
  const stale = stated.stale.map((s) => `the statement itself has no current ${s.source} reading: ${s.detail}`);
  const burn = stated.monthlyBurnUsd === null ? [] : [`runway is measured against a monthly burn of $${stated.monthlyBurnUsd}, which is the organisation's own figure`];
  return pass('arithmetic', `all ${compared} figures follow from the ledger and the journal`, [
    ...stale,
    ...period,
    ...burn,
    "the dollar price applied to each ZEC entry is the ledger's own; no price source was consulted",
  ]);
}
