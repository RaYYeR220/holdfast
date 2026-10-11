import { buildLedger, entryId, type LedgerEntry, type PublishedStatement, sumAmounts } from '@holdfast/books';
import type { ScanResult } from '@holdfast/core';
import type { KeyDescription, Sources } from '../env';
import { describeDiff, diffEntries, type EntryField, isClean } from './compare';
import { describeError, fail, firstFew, pass, skipped, type StepResult } from './report';

export interface ZcashOptions {
  ufvk: string | null;
  offline: boolean;
  endpoints: readonly string[];
  /** Where the reader wants the scan to start, when they know the treasury's first block themselves. */
  birthday: number | null;
}

/** A viewing key reveals the whole treasury; it must not come back out in an error message. */
function withoutKey(text: string, ufvk: string): string {
  return text.split(ufvk).join('[viewing key]');
}

const ON_CHAIN: readonly EntryField[] = ['ts', 'kind', 'asset', 'decimals', 'amount', 'ref', 'counterparty', 'tx', 'block'];
const WITHOUT_ITS_BLOCK: readonly EntryField[] = ['kind', 'asset', 'decimals', 'amount', 'tx'];
const AS_A_PAYMENT: readonly EntryField[] = ['ts', 'asset', 'decimals', 'amount', 'tx', 'block'];

/**
 * Scan the chain again with the viewing key and hold the ledger's Zcash
 * entries against what that scan shows, one by one.
 *
 * The chain's side is built from the key and the scan alone. The statement
 * says which blocks its history covers, and that claim is checked rather than
 * followed: the range must be one, the chain must reach its end, and the
 * journal step has already held both ends against the journal. The key must
 * be the key of the treasury the statement names, or a clean scan of some
 * other account would pass for it.
 *
 * What a scan fixes about an entry is compared. Dollar values come from a
 * price the chain does not hold and are left to the arithmetic step. Whether
 * a transparent payment funded a swap is not something a viewing key shows
 * either: such an entry is checked as the payment the chain shows it to be,
 * and what the ledger says it paid for is left to the swap records. A scan
 * reports a fee by transaction only, so a fee whose transaction left the
 * treasury nothing else comes back without a block or a time to compare.
 */
export async function checkZcash(published: PublishedStatement, options: ZcashOptions, sources: Sources): Promise<StepResult> {
  const claimed = published.org.zcash;
  const ledger = published.ledger.filter((entry) => entry.source === 'zcash');

  if (claimed.network !== 'mainnet') return fail('zcash', `the statement is about Zcash ${claimed.network}; only mainnet statements are verified`);
  if (claimed.scannedTo === null) return fail('zcash', 'the statement names no block its Zcash history reaches, so none of it can be held against the chain');
  const scannedTo = claimed.scannedTo;
  const from = options.birthday ?? claimed.birthday;
  if (!Number.isSafeInteger(from) || from < 1 || !Number.isSafeInteger(scannedTo) || scannedTo < from) {
    return fail('zcash', `blocks ${from} to ${scannedTo} are not a range of the chain`);
  }

  if (options.offline) return skipped('zcash', 'not run: --offline');
  if (options.ufvk === null) return skipped('zcash', 'not run: no viewing key given (--ufvk or --ufvk-file)');
  const ufvk = options.ufvk;

  let key: KeyDescription;
  try {
    key = await sources.describeKey(ufvk);
  } catch (e) {
    return skipped('zcash', `the viewing key could not be examined: ${withoutKey(describeError(e), ufvk)}`);
  }
  if (!key.ok) return fail('zcash', `the viewing key cannot be used: ${withoutKey(key.error, ufvk)}`);
  if (key.network !== 'mainnet') return fail('zcash', `the viewing key is a ${key.network} key; only mainnet statements are verified`);
  if (key.address !== claimed.address) {
    return fail('zcash', `the viewing key belongs to ${key.address}, not to ${claimed.address}, the treasury the statement is about`);
  }

  let scan: ScanResult;
  let tip: number;
  try {
    const scanner = await sources.zcash(options.endpoints);
    tip = await scanner.tip();
    if (tip < scannedTo) return fail('zcash', `the chain ends at block ${tip}; the statement claims a history up to block ${scannedTo}`);
    scan = await scanner.scan({ ufvk, fromHeight: from, toHeight: scannedTo, knownNullifiers: [] });
  } catch (e) {
    return skipped('zcash', `the chain could not be read: ${withoutKey(describeError(e), ufvk)}`);
  }

  const rebuilt = buildLedger({ notes: scan.notes, outgoing: scan.outgoing, fees: scan.fees });
  const transparent = new Set(scan.outgoing.filter((out) => out.pool === 'transparent').map((out) => entryId.zcash(out.id)));
  const comparable = (onChain: LedgerEntry, booked: LedgerEntry): readonly EntryField[] => {
    if (onChain.kind === 'network_fee' && onChain.proof.block === null) return WITHOUT_ITS_BLOCK;
    return booked.kind === 'swap_out' && transparent.has(onChain.id) ? AS_A_PAYMENT : ON_CHAIN;
  };

  const diff = diffEntries(ledger, rebuilt, comparable);
  const range = `blocks ${from} to ${scannedTo}`;
  if (!isClean(diff)) {
    const summary = `${diff.missing.length} on chain but not in the ledger, ${diff.unexpected.length} in the ledger but not on chain, ${diff.changed.length} that differ`;
    return fail('zcash', `${range}: ${summary}`, firstFew(describeDiff(diff, 'the chain')));
  }

  // What the unspent notes hold must be what the ledger adds up to. Notes without a nullifier cannot be seen being
  // spent, so their value may or may not still be there: with any of those, the two can differ by up to that much.
  const followed = scan.notes.filter((note) => note.nullifier !== null);
  const held = followed.filter((note) => !note.spent).reduce((sum, note) => sum + note.zat, 0n);
  const unfollowed = scan.notes.filter((note) => note.nullifier === null).reduce((sum, note) => sum + note.zat, 0n);
  const booked = sumAmounts(ledger);
  if (held > booked || held < booked - unfollowed) {
    const allowed = unfollowed === 0n ? `${booked} zat` : `between ${booked - unfollowed} and ${booked} zat`;
    return fail('zcash', `${range}: the unspent notes hold ${held} zat but the ledger adds up to ${allowed}`, [
      'every entry matches the chain, so value moved in a way the viewing key does not show',
    ]);
  }

  const deposits = ledger.filter((entry) => entry.kind === 'swap_out').length;
  const notes = [
    `the key is the key of ${claimed.address}; that this is the address the organisation is paid at is for the reader to know`,
    options.birthday === null
      ? `the scan starts at block ${from}, which the statement gives as the treasury's first; name your own with --birthday if you know it`
      : `the scan starts at block ${from}, as asked`,
    `the chain is now at block ${tip}, ${tip - scannedTo} blocks past the end of the statement`,
    ...(deposits === 0 ? [] : [`${deposits} of the payments are booked as deposits into swaps; the chain shows the payments, not what they paid for`]),
    ...(unfollowed === 0n ? [] : [`${unfollowed} zat arrived in notes whose spends a viewing key cannot follow; the balance is confirmed to within that much`]),
  ];
  const balance = unfollowed === 0n ? `the unspent notes hold the ${held} zat the ledger adds up to` : `the unspent notes hold ${held} zat, which the ledger allows`;
  return pass('zcash', `${range}: all ${diff.matched} entries match the chain, and ${balance}`, notes);
}
