import type { PublishedStatement } from '@holdfast/books';
import { digest, ZERO_ROOT } from '@holdfast/core';
import { verifyChain } from '@holdfast/engine';
import { fail, pass, type StepResult } from './report';

/**
 * The journal is what everything else is held against, so it is checked
 * first: every entry's digest is recomputed from its content, each must follow
 * the one before from the zero root, and the numbering must have no gap.
 *
 * An entry records only the digest of the policy it was decided under. The
 * latest entry must have been decided under the published policy, or under it
 * with the hedge ratio at zero, which is how the controller runs while the
 * lock is switched off. Earlier entries may predate a change of policy; those
 * are counted, since the export has nothing to recompute their digest from.
 */
export function checkJournal(published: PublishedStatement): StepResult {
  const { journal, org, policy } = published;
  if (journal.length === 0) return pass('journal', 'the journal is empty: there is nothing to chain');

  const foreign = journal.find((entry) => entry.orgId !== org.id);
  if (foreign !== undefined) return fail('journal', `entry ${foreign.seq} belongs to organisation ${foreign.orgId}, not ${org.id}`);

  const misnumbered = journal.findIndex((entry, i) => entry.seq !== i + 1);
  if (misnumbered >= 0) {
    return fail('journal', `position ${misnumbered + 1} holds entry ${journal[misnumbered]?.seq}: the journal does not run 1, 2, 3 without a gap`);
  }

  const chain = verifyChain(journal, ZERO_ROOT);
  if (!chain.ok) return fail('journal', `entry ${chain.seq} ${chain.reason}`);

  const acceptable = new Set([digest(policy), digest({ ...policy, hedgeRatioBps: 0 })]);
  const latest = journal[journal.length - 1];
  if (latest !== undefined && !acceptable.has(latest.policyDigest)) {
    return fail('journal', `entry ${latest.seq}, the latest, was not decided under the published policy`);
  }
  const earlier = journal.filter((entry) => !acceptable.has(entry.policyDigest)).length;
  const policies = earlier === 0 ? 'all decided under the published policy' : `${journal.length - earlier} decided under the published policy, ${earlier} under an earlier one that is not published`;
  return pass('journal', `${journal.length} entries chain from the zero root, ${policies}`);
}
