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

/** Whether a reading taken at this block and time already includes the entry. */
function covers(height: number | null, asOf: number, entry: LedgerEntry): boolean {
  return height !== null && entry.proof.block !== null ? entry.proof.block <= height : entry.ts <= asOf;
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

type Verdict = 'agrees' | 'differs' | 'within';

interface Stretch {
  verdict: Verdict;
  /** How far the recorded balance is from where the ledger allows it to be. */
  difference: bigint;
  /** Zatoshi received in notes whose spends cannot be followed: how loosely the ledger pins the balance. */
  slack: bigint;
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
    const allowed = stretch.slack === 0n ? `${stretch.expected} zat` : `between ${stretch.expected - stretch.slack} and ${stretch.expected} zat`;
    out.error(
      'balance_mismatch',
      `${which}: the journal recorded ${stretch.recorded} zat where the ledger's Zcash entries add up to ${allowed} (${sign}${stretch.difference})`,
      ...refs,
    );
  } else {
    out.warn(
      'balance_unverifiable',
      `${which}: ${stretch.slack} zat were received in a pool whose spends a viewing key cannot follow, so the recorded balance can only be placed within that much of the ledger`,
      ...refs,
    );
  }
}

/**
 * The balance each journal entry recorded against the ledger at that block.
 *
 * The journal counts only notes whose spends it can follow. A note of the
 * other kind may or may not still be there, so once some have been received
 * the followed balance is known only to lie between the ledger's total and
 * that total less everything received that way. A balance inside that band
 * is reported as placed but not pinned; one outside it is wrong whatever
 * happened to those notes.
 *
 * Every treasury entry must also fall under some recorded balance. Entries
 * the journal's last reading does not reach are confirmed by nothing here.
 *
 * Neighbouring entries with the same verdict are reported once, so a single
 * fault does not repeat for every tick that came after it.
 */
export function checkBalances(journal: readonly JournalEntry[], ledger: readonly LedgerEntry[], out: Findings): void {
  const treasury = ledger.filter(isTreasuryZec);
  const total = balanceAt(treasury);
  const unfollowed = balanceAt(treasury.filter((entry) => entry.kind === 'receipt_untracked'));

  let open: Stretch | null = null;
  let last: { height: number | null; asOf: number; seq: number } | null = null;
  for (const entry of [...journal].sort((a, b) => a.seq - b.seq)) {
    const reading = entry.snapshot.treasury;
    if (reading === null) continue;

    const height = entry.scan === null ? null : entry.scan.to;
    last = { height, asOf: reading.asOf, seq: entry.seq };
    const expected = total(height, reading.asOf);
    const slack = unfollowed(height, reading.asOf);
    const recorded = BigInt(reading.zat);
    const difference = recorded > expected ? recorded - expected : recorded < expected - slack ? recorded - (expected - slack) : 0n;
    const verdict: Verdict = difference !== 0n ? 'differs' : slack === 0n ? 'agrees' : 'within';

    if (open !== null && open.verdict === verdict && open.difference === difference && open.slack === slack) {
      open.last = entry.seq;
      continue;
    }
    if (open !== null) report(open, out);
    open = { verdict, difference, slack, first: entry.seq, last: entry.seq, recorded, expected };
  }
  if (open !== null) report(open, out);

  const reached = last;
  const beyond = treasury.filter((entry) => reached === null || !covers(reached.height, reached.asOf, entry));
  if (beyond.length > 0) {
    const where = reached === null ? 'the journal recorded no balance at all' : `the last balance the journal recorded is in entry ${reached.seq}`;
    out.error(
      'balance_unrecorded',
      `${beyond.length} treasury ${beyond.length === 1 ? 'entry lies' : 'entries lie'} beyond any balance in the journal (${where}): nothing recorded at the time confirms them`,
      ...beyond.slice(0, 5).map((entry) => entry.id),
    );
  }
}
