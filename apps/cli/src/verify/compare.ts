import type { LedgerEntry } from '@holdfast/books';

/** Dollar figures are floating point and may differ in the last digits between two derivations. */
const DOLLAR_TOLERANCE = 1e-6;

/** Whole numbers — counts, lots, timestamps — must be identical; anything fractional is a dollar figure. */
function sameNumber(a: number, b: number, tolerance: number): boolean {
  if (a === b) return true;
  if (Number.isInteger(a) && Number.isInteger(b)) return false;
  return Math.abs(a - b) <= tolerance * Math.max(Math.abs(a), Math.abs(b));
}

const show = (value: unknown): string => (typeof value === 'bigint' ? value.toString() : value === undefined ? 'absent' : (JSON.stringify(value) ?? String(value)));

export interface Difference {
  path: string;
  published: string;
  recomputed: string;
}

export interface FigureComparison {
  /** Individual figures looked at. */
  compared: number;
  differences: Difference[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Compare a published statement with one derived again, figure by figure.
 * Amounts in base units are exact; a figure present on one side only is a
 * difference, whichever side it is.
 */
export function compareFigures(published: unknown, recomputed: unknown): FigureComparison {
  const result: FigureComparison = { compared: 0, differences: [] };

  const walk = (a: unknown, b: unknown, path: string): void => {
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) result.differences.push({ path: `${path}.length`, published: String(a.length), recomputed: String(b.length) });
      for (let i = 0; i < Math.min(a.length, b.length); i++) walk(a[i], b[i], `${path}[${i}]`);
      return;
    }
    if (isRecord(a) && isRecord(b)) {
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        walk(a[key], b[key], path === '' ? key : `${path}.${key}`);
      }
      return;
    }
    result.compared++;
    const same = typeof a === 'number' && typeof b === 'number' ? sameNumber(a, b, DOLLAR_TOLERANCE) : a === b;
    if (!same) result.differences.push({ path, published: show(a), recomputed: show(b) });
  };

  walk(published, recomputed, '');
  return result;
}

/** The properties of an entry that its chain or venue determines. */
const FIELDS = {
  ts: (e: LedgerEntry) => e.ts,
  kind: (e: LedgerEntry) => e.kind,
  asset: (e: LedgerEntry) => e.asset,
  decimals: (e: LedgerEntry) => e.decimals,
  amount: (e: LedgerEntry) => e.amount,
  usd: (e: LedgerEntry) => e.usd,
  usdPrice: (e: LedgerEntry) => e.usdPrice,
  usdPriceAt: (e: LedgerEntry) => e.usdPriceAt,
  ref: (e: LedgerEntry) => e.ref,
  counterparty: (e: LedgerEntry) => e.counterparty?.address ?? null,
  tx: (e: LedgerEntry) => e.proof.tx,
  block: (e: LedgerEntry) => e.proof.block,
} satisfies Record<string, (e: LedgerEntry) => unknown>;

export type EntryField = keyof typeof FIELDS;

export interface EntryDiff {
  matched: number;
  /** On the chain or venue, and not in the published ledger. */
  missing: LedgerEntry[];
  /** In the published ledger, and not on the chain or venue. */
  unexpected: LedgerEntry[];
  changed: { id: string; field: EntryField; published: string; rebuilt: string }[];
}

/**
 * Hold the published entries of one source against the same entries rebuilt
 * from that source, line by line. `fields` names what the source fixes about
 * an entry and so what to compare: a dollar value, for one, can only be
 * compared where the source itself gives the price.
 */
export function diffEntries(
  published: readonly LedgerEntry[],
  rebuilt: readonly LedgerEntry[],
  fields: (rebuilt: LedgerEntry, published: LedgerEntry) => readonly EntryField[],
): EntryDiff {
  const diff: EntryDiff = { matched: 0, missing: [], unexpected: [], changed: [] };
  const expected = new Map(rebuilt.map((entry) => [entry.id, entry]));

  for (const entry of published) {
    const twin = expected.get(entry.id);
    if (twin === undefined) {
      // Not on the source at all, or a second copy of an entry already accounted for.
      diff.unexpected.push(entry);
      continue;
    }
    expected.delete(entry.id);
    const before = diff.changed.length;
    for (const field of fields(twin, entry)) {
      const a = FIELDS[field](entry);
      const b = FIELDS[field](twin);
      const same = typeof a === 'number' && typeof b === 'number' ? sameNumber(a, b, 1e-9) : a === b;
      if (!same) diff.changed.push({ id: entry.id, field, published: show(a), rebuilt: show(b) });
    }
    if (diff.changed.length === before) diff.matched++;
  }
  diff.missing.push(...expected.values());
  return diff;
}

export function describeDiff(diff: EntryDiff, source: string): string[] {
  return [
    ...diff.missing.map((e) => `${e.id}: ${source} shows this ${e.kind} of ${e.amount} ${e.asset} base units, and the ledger does not have it`),
    ...diff.unexpected.map((e) => `${e.id}: the ledger has this ${e.kind} of ${e.amount} ${e.asset} base units, and ${source} does not show it`),
    ...diff.changed.map((c) => `${c.id}: ${c.field} is ${c.published} in the ledger and ${c.rebuilt} on ${source}`),
  ];
}

export function isClean(diff: EntryDiff): boolean {
  return diff.missing.length === 0 && diff.unexpected.length === 0 && diff.changed.length === 0;
}
