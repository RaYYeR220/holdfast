import type { LedgerEntry } from '../entry';

const close = (a: number | null, b: number | null) => a === b || (a !== null && b !== null && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)));

/**
 * The first respect in which a ledger entry differs from the entry its
 * record gives, or null when it is that entry. Everything a record fixes is
 * compared, not only the amount: the date decides the period an entry is
 * reported in, the decimals decide its size, the payee decides whose total it
 * joins. Dollar values are compared where the record fixes them too, which is
 * for assets carried at par.
 */
export function differsIn(entry: LedgerEntry, expected: LedgerEntry, valueIsFixed: boolean): string | null {
  if (entry.source !== expected.source) return 'source';
  if (entry.kind !== expected.kind) return 'kind';
  if (entry.ts !== expected.ts) return 'date';
  if (entry.asset !== expected.asset) return 'asset';
  if (entry.decimals !== expected.decimals) return 'decimals';
  if (entry.amount !== expected.amount) return 'amount';
  if (entry.ref !== expected.ref) return 'reference';
  if (entry.counterparty?.name !== expected.counterparty?.name) return 'counterparty name';
  if (entry.counterparty?.address !== expected.counterparty?.address) return 'counterparty address';
  if (entry.proof.chain !== expected.proof.chain) return 'chain';
  if (entry.proof.tx !== expected.proof.tx) return 'transaction';
  if (valueIsFixed && (!close(entry.usd, expected.usd) || !close(entry.usdPrice, expected.usdPrice))) return 'dollar value';
  return null;
}
