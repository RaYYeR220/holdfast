import type { JournalEntry } from '@holdfast/engine';
import { isTreasuryZec, type LedgerEntry } from '../entry';
import { type Findings, journalRef } from '../problems';

/** Running totals of entries ordered by one key, answering "how much up to here". */
function totalsBy(entries: readonly LedgerEntry[], key: (entry: LedgerEntry) => number): (limit: number) => bigint {
  const sorted = entries.map((entry) => ({ at: key(entry), amount: entry.amount })).sort((a, b) => a.at - b.at);
  const running: bigint[] = [];
  let sum = 0n;
  for (const item of sorted) {
    sum += item.amount;
    running.push(sum);
  }

  return (limit) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((sorted[mid] as { at: number }).at <= limit) lo = mid + 1;
      else hi = mid;
    }
    return lo === 0 ? 0n : (running[lo - 1] as bigint);
  };
}

/**
 * What a set of treasury entries added up to when a journal entry was
 * written. The journal records the block its scan reached, and a balance is
 * exact only by block: a block's own timestamp can sit on either side of the
 * moment the scan ran. Time is used where an entry has no block.
 */
function balanceAt(entries: readonly LedgerEntry[]): (height: number | null, asOf: number) => bigint {
  const withBlock = entries.filter((entry) => entry.proof.block !== null);
  const withoutBlock = entries.filter((entry) => entry.proof.block === null);
  const byBlock = totalsBy(withBlock, (entry) => entry.proof.block as number);
  const byTimeUnblocked = totalsBy(withoutBlock, (entry) => entry.ts);
  const byTime = totalsBy(entries, (entry) => entry.ts);
  return (height, asOf) => (height === null ? byTime(asOf) : byBlock(height) + byTimeUnblocked(asOf));
}

type Verdict = 'agrees' | 'differs' | 'unverifiable';

interface Stretch {
  verdict: Verdict;
  difference: bigint;
  first: number;
  last: number;
  recorded: bigint;
  expected: bigint;
}

function report(stretch: Stretch, out: Findings): void {
  const refs = stretch.first === stretch.last ? [journalRef(stretch.first)] : [journalRef(stretch.first), journalRef(stretch.last)];
  const which = stretch.first === stretch.last ? `journal entry ${stretch.first}` : `journal entries ${stretch.first} to ${stretch.last}`;
  if (stretch.verdict === 'agrees') {
    out.match('balance', ...refs);
  } else if (stretch.verdict === 'differs') {
    const sign = stretch.difference > 0n ? '+' : '';
    out.error(
      'balance_mismatch',
      `${which}: the journal recorded ${stretch.recorded} zat where the ledger's Zcash entries add up to ${stretch.expected} zat (${sign}${stretch.difference})`,
      ...refs,
    );
  } else {
    out.warn(
      'balance_unverifiable',
      `${which}: the treasury holds notes in a pool whose spends a viewing key cannot follow, so the recorded balance cannot be rebuilt from the ledger`,
      ...refs,
    );
  }
}

/**
 * The balance each journal entry recorded against the ledger at that block.
 *
 * The journal counts only notes whose spends it can follow. Once a note of the
 * other kind has been received, later spends may draw on either, and the
 * followed balance can no longer be derived from what came in and went out;
 * from then on entries are reported as unverifiable instead of being judged.
 *
 * Neighbouring entries with the same verdict are reported once, so a single
 * fault does not repeat for every tick that came after it.
 */
export function checkBalances(journal: readonly JournalEntry[], ledger: readonly LedgerEntry[], out: Findings): void {
  const treasury = ledger.filter(isTreasuryZec);
  const followed = balanceAt(treasury.filter((entry) => entry.kind !== 'receipt_untracked'));
  const unfollowed = balanceAt(treasury.filter((entry) => entry.kind === 'receipt_untracked'));

  let open: Stretch | null = null;
  for (const entry of [...journal].sort((a, b) => a.seq - b.seq)) {
    const reading = entry.snapshot.treasury;
    if (reading === null) continue;

    const height = entry.scan === null ? null : entry.scan.to;
    const expected = followed(height, reading.asOf);
    const recorded = BigInt(reading.zat);
    const judged = unfollowed(height, reading.asOf) === 0n;
    const difference = judged ? recorded - expected : 0n;
    const verdict: Verdict = !judged ? 'unverifiable' : difference === 0n ? 'agrees' : 'differs';

    if (open !== null && open.verdict === verdict && open.difference === difference) {
      open.last = entry.seq;
      continue;
    }
    if (open !== null) report(open, out);
    open = { verdict, difference, first: entry.seq, last: entry.seq, recorded, expected };
  }
  if (open !== null) report(open, out);
}
