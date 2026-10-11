import { buildLedger, type LedgerEntry, type PublishedStatement, sumAmounts } from '@holdfast/books';
import type { ScanResult } from '@holdfast/core';
import type { Sources } from '../env';
import { describeDiff, diffEntries, type EntryField, isClean } from './compare';
import { describeError, fail, firstFew, pass, skipped, type StepResult } from './report';

export interface ZcashOptions {
  ufvk: string | null;
  offline: boolean;
  endpoints: readonly string[];
}

/** A viewing key reveals the whole treasury; it must not come back out in an error message. */
function withoutKey(text: string, ufvk: string): string {
  return text.split(ufvk).join('[viewing key]');
}

const ON_CHAIN: readonly EntryField[] = ['ts', 'kind', 'asset', 'decimals', 'amount', 'ref', 'counterparty', 'tx', 'block'];
const WITHOUT_ITS_BLOCK: readonly EntryField[] = ['kind', 'asset', 'decimals', 'amount', 'tx'];

/**
 * What a scan fixes about an entry. Dollar values come from a price the chain
 * does not hold and are left to the arithmetic step. A scan reports a fee by
 * transaction only, so a fee whose transaction left the treasury nothing else
 * comes back without a block or a time to compare.
 */
function comparable(rebuilt: LedgerEntry): readonly EntryField[] {
  return rebuilt.kind === 'network_fee' && rebuilt.proof.block === null ? WITHOUT_ITS_BLOCK : ON_CHAIN;
}

/**
 * Scan the chain again with the viewing key, from the treasury's birthday to
 * the block the statement covers, and hold the ledger's Zcash entries against
 * what that scan shows, one by one. Nothing the publisher stored is used
 * except the swap records, which decide whether a transparent payment reads
 * as a payment or as a swap's deposit.
 */
export async function checkZcash(published: PublishedStatement, options: ZcashOptions, sources: Sources): Promise<StepResult> {
  const { birthday, scannedTo, network } = published.org.zcash;
  const ledger = published.ledger.filter((entry) => entry.source === 'zcash');

  if (options.offline) return skipped('zcash', 'not run: --offline');
  if (options.ufvk === null) return skipped('zcash', 'not run: no viewing key given (--ufvk or --ufvk-file)');
  if (scannedTo === null) {
    if (ledger.length > 0) return fail('zcash', `the statement names no scanned block but its ledger holds ${ledger.length} Zcash entries`);
    return skipped('zcash', 'not run: the treasury had not been scanned when the statement was made');
  }
  if (scannedTo < birthday) return fail('zcash', `the statement covers up to block ${scannedTo}, before the treasury's birthday at ${birthday}`);
  const ufvk = options.ufvk;

  let scan: ScanResult;
  try {
    const scanner = await sources.zcash(network, options.endpoints);
    const tip = await scanner.tip();
    if (tip < scannedTo) return skipped('zcash', `the endpoint is at block ${tip}, behind block ${scannedTo} the statement covers`);
    scan = await scanner.scan({ ufvk, fromHeight: birthday, toHeight: scannedTo, knownNullifiers: [] });
  } catch (e) {
    return skipped('zcash', `the chain could not be read: ${withoutKey(describeError(e), ufvk)}`);
  }

  const rebuilt = buildLedger({ notes: scan.notes, outgoing: scan.outgoing, fees: scan.fees, swaps: published.swaps }).filter(
    (entry) => entry.source === 'zcash',
  );
  const diff = diffEntries(ledger, rebuilt, comparable);
  const range = `blocks ${birthday} to ${scannedTo}`;
  if (!isClean(diff)) {
    const summary = `${diff.missing.length} on chain but not in the ledger, ${diff.unexpected.length} in the ledger but not on chain, ${diff.changed.length} that differ`;
    return fail('zcash', `${range}: ${summary}`, firstFew(describeDiff(diff, 'the chain')));
  }

  // Notes without a nullifier cannot be seen being spent, so "unspent" says nothing about them.
  if (scan.notes.some((note) => note.nullifier === null)) {
    return pass('zcash', `${range}: all ${diff.matched} entries match the chain`, ['the treasury holds notes whose spends a viewing key cannot follow; the note balance was not compared']);
  }
  const held = scan.notes.filter((note) => !note.spent).reduce((sum, note) => sum + note.zat, 0n);
  const booked = sumAmounts(ledger);
  if (held !== booked) {
    return fail('zcash', `${range}: the unspent notes hold ${held} zat but the ledger adds up to ${booked} zat`, [
      'every entry matches the chain, so value left the treasury in a way the viewing key does not show',
    ]);
  }
  return pass('zcash', `${range}: all ${diff.matched} entries match the chain, and the unspent notes hold the ${held} zat the ledger adds up to`);
}
