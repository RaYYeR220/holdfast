import { policyInForce, type PublishedStatement } from '@holdfast/books';
import { digest, ZERO_ROOT } from '@holdfast/core';
import { verifyChain } from '@holdfast/engine';
import { fail, pass, type StepResult } from './report';

/**
 * The journal is what everything else is held against, so it is checked
 * first: every entry's digest is recomputed from its content, each must follow
 * the one before from the zero root, and the numbering must have no gap.
 *
 * A statement without a journal has nothing to be held against and does not
 * pass. Nor does one whose own header disagrees with its journal about where
 * the treasury's history starts and how far it reaches: the later steps go by
 * the header, and the balances they rely on were recorded by the journal.
 *
 * An entry records only the digest of the policy it was decided under. The
 * latest entry must have been decided under the published policy, or under it
 * with the hedge ratio at zero, which is how the controller runs while the
 * lock is switched off. Earlier entries may predate a change of policy; those
 * are counted, since the export has nothing to recompute their digest from.
 */
export function checkJournal(published: PublishedStatement): StepResult {
  const { journal, org, policy } = published;
  if (journal.length === 0) return fail('journal', 'the statement carries no journal: there is nothing to hold its figures against');

  const foreign = journal.find((entry) => entry.orgId !== org.id);
  if (foreign !== undefined) return fail('journal', `entry ${foreign.seq} belongs to organisation ${foreign.orgId}, not ${org.id}`);

  const misnumbered = journal.findIndex((entry, i) => entry.seq !== i + 1);
  if (misnumbered >= 0) {
    return fail('journal', `position ${misnumbered + 1} holds entry ${journal[misnumbered]?.seq}: the journal does not run 1, 2, 3 without a gap`);
  }

  const chain = verifyChain(journal, ZERO_ROOT);
  if (!chain.ok) return fail('journal', `entry ${chain.seq} ${chain.reason}`);

  const latest = journal[journal.length - 1];
  const inForce = policyInForce(policy, journal);
  if (inForce === null) return fail('journal', `entry ${latest?.seq}, the latest, was not decided under the published policy`);

  const scans = journal.flatMap((entry) => (entry.scan === null ? [] : [entry.scan]));
  const reached = scans.at(-1)?.to ?? null;
  if (reached !== org.zcash.scannedTo) {
    const journalSays = reached === null ? 'the journal never scanned the chain' : `the journal's last scan reached block ${reached}`;
    const headerSays = org.zcash.scannedTo === null ? 'names no block' : `says its Zcash history reaches block ${org.zcash.scannedTo}`;
    return fail('journal', `the statement ${headerSays}, but ${journalSays}`);
  }
  const started = scans[0]?.from;
  if (started !== undefined && started !== org.zcash.birthday) {
    return fail('journal', `the statement gives block ${org.zcash.birthday} as the treasury's birthday, but the journal's first scan started at block ${started}`);
  }

  const digests = new Set([digest(policy), digest({ ...policy, hedgeRatioBps: 0 })]);
  const acceptable = journal.filter((entry) => digests.has(entry.policyDigest)).length;
  const earlier = journal.length - acceptable;
  const policies = earlier === 0 ? 'all decided under the published policy' : `${acceptable} decided under the published policy, ${earlier} under an earlier one that is not published`;
  const details = inForce.hedgeRatioBps === policy.hedgeRatioBps ? [] : ['the latest entry was decided with the lock switched off: the hedge ratio in force is zero'];
  return pass('journal', `${journal.length} entries chain from the zero root, ${policies}`, [
    ...details,
    'the chain shows the journal was not altered after it was written; nothing here shows it is the only journal ever written',
  ]);
}
