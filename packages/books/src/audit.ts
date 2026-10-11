import { zatToZec } from '@holdfast/core';
import { formatUnits } from './assets';
import { belongsToItsSource, isTreasuryZec, type LedgerEntry, sumAmounts } from './entry';
import { type DateRange, inRange, summariseFlows } from './flows';
import type { HedgeFigures, Statement, StaleSource, TreasuryFigures } from './statement';
import { isoTime } from './time';

export const AUDIT_MODULES = ['treasury', 'hedge', 'swaps', 'payouts'] as const;
export type AuditModule = (typeof AUDIT_MODULES)[number];

/** What an auditor link lets its holder see. */
export interface AuditScope extends DateRange {
  modules: readonly AuditModule[];
}

export interface ScopedStatement {
  scope: AuditScope;
  statement: Statement;
  ledger: LedgerEntry[];
}

const isBound = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isFinite(value));
const isModule = (value: unknown): value is AuditModule => AUDIT_MODULES.includes(value as AuditModule);

/**
 * Read a scope as it was stored with its link. A scope decides what an
 * outsider sees, so one that is not exactly a scope is refused: a bound that
 * is not a number or a module this version does not know must not be read as
 * "no limit".
 */
export function parseAuditScope(value: unknown): AuditScope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new RangeError('an audit scope must be an object');
  const { from, to, modules } = value as Record<string, unknown>;
  if (!isBound(from) || !isBound(to)) throw new RangeError('the dates of an audit scope must be timestamps or null');
  if (!Array.isArray(modules) || !modules.every(isModule)) throw new RangeError(`the modules of an audit scope must be among ${AUDIT_MODULES.join(', ')}`);
  return { from, to, modules: [...new Set(modules)] };
}

/** The same scope, or one that shows nothing where it is not a scope at all. */
function closed(scope: AuditScope): AuditScope {
  try {
    return parseAuditScope(scope);
  } catch {
    return { from: null, to: null, modules: [] };
  }
}

/**
 * The modules an entry belongs to. A treasury payment into a swap belongs to
 * both: it is the treasury's spend and the swap's input. An entry of a kind
 * its source does not produce belongs to none and is shown to nobody.
 */
export function entryModules(entry: LedgerEntry): AuditModule[] {
  if (!belongsToItsSource(entry)) return [];
  if (entry.kind === 'payout') return ['payouts'];
  if (entry.source === 'hyperliquid') return ['hedge'];
  if (entry.source === 'zcash') return entry.kind === 'swap_out' ? ['treasury', 'swaps'] : ['treasury'];
  return ['swaps'];
}

const later = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.max(a, b));
const earlier = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));

function staleInScope(stale: StaleSource, has: (module: AuditModule) => boolean): boolean {
  if (stale.source === 'zcash') return has('treasury');
  if (stale.source === 'hyperliquid') return has('hedge');
  if (stale.source === 'reference') return has('treasury') || has('hedge');
  return true;
}

/**
 * Cut a statement and its ledger down to what a scope covers.
 *
 * Entries outside the scope are removed, and so is every reference to them
 * from the entries that stay: the ids they link to, and, on a treasury
 * payment into a swap shown without the swaps module, the swap it names.
 * Every total is worked out again from the entries that remain; nothing is
 * carried over that was computed from the whole ledger.
 *
 * A figure that the remaining entries cannot give would let its reader work
 * out what was removed, so it is left out:
 * - a balance, a position or a value is the sum of everything before it, and
 *   is shown only to a scope that starts at the beginning;
 * - a current reading is shown only when the scope's dates include the
 *   statement's own;
 * - the hedge target and its coverage are worked out from the treasury
 *   balance, and are shown only with the treasury;
 * - value, drift, runway and the series add every module together, and are
 *   shown only with all of them.
 */
export function scopeStatement(statement: Statement, ledger: readonly LedgerEntry[], given: AuditScope): ScopedStatement {
  const scope = closed(given);
  const has = (module: AuditModule) => scope.modules.includes(module);
  const range: DateRange = { from: later(statement.range.from, scope.from), to: earlier(statement.range.to, scope.to) };

  const visible = ledger.filter((entry) => inRange(entry.ts, scope) && entryModules(entry).some(has));
  const ids = new Set(visible.map((entry) => entry.id));
  const scoped = visible.map((entry): LedgerEntry => {
    const linked = entry.linked.filter((id) => ids.has(id));
    const namesHiddenSwap = entry.kind === 'swap_out' && !has('swaps');
    return namesHiddenSwap ? { ...entry, ref: '', counterparty: null, linked } : { ...entry, linked };
  });
  const flows = summariseFlows(scoped, range);

  const everyModule = AUDIT_MODULES.every(has);
  const fromTheStart = scope.from === null;
  const current = inRange(statement.asOf, scope);

  let treasury: TreasuryFigures | null = null;
  if (has('treasury') && fromTheStart) {
    const entries = scoped.filter(isTreasuryZec);
    const reading = current ? statement.treasury : null;
    // The balance is summed again from what the scope holds; where the statement gave none, neither does this.
    const zat = reading !== null && reading.zat === null ? null : sumAmounts(entries);
    const px = reading?.px ?? null;
    treasury = {
      zat,
      untrackedZat: zat === null ? null : sumAmounts(entries.filter((entry) => entry.kind === 'receipt_untracked')),
      asOf: reading?.asOf ?? null,
      px,
      pxAt: reading?.pxAt ?? null,
      usd: zat === null || px === null ? null : zatToZec(zat) * px,
    };
  }

  let hedge: HedgeFigures | null = null;
  if (has('hedge') && fromTheStart && current && statement.hedge !== null) {
    hedge = has('treasury') ? statement.hedge : { ...statement.hedge, targetLots: null, coverageBps: null };
  }
  const whole = everyModule && fromTheStart && current;

  return {
    scope,
    ledger: scoped,
    statement: {
      asOf: statement.asOf,
      range,
      monthlyBurnUsd: whole ? statement.monthlyBurnUsd : null,
      staleAfterMs: statement.staleAfterMs,
      seriesStep: statement.seriesStep,
      treasury,
      hedge,
      lock: whole ? statement.lock : null,
      receipts: has('treasury') ? flows.receipts : null,
      payments: has('treasury') ? flows.payments : null,
      swapped: has('treasury') ? flows.swapped : null,
      funding: has('hedge') ? flows.funding : null,
      fees: {
        networkZat: has('treasury') ? flows.fees.networkZat : null,
        networkUsd: has('treasury') ? flows.fees.networkUsd : null,
        tradeUsd: has('hedge') ? flows.fees.tradeUsd : null,
        swapUsd: has('swaps') ? flows.fees.swapUsd : null,
        totalUsd: everyModule ? flows.fees.totalUsd : null,
      },
      payouts: has('payouts') ? flows.payouts : null,
      runwayMonths: whole ? statement.runwayMonths : null,
      series: everyModule && fromTheStart ? statement.series.filter((point) => inRange(point.t, scope)) : [],
      stale: current ? statement.stale.filter((s) => staleInScope(s, has)) : [],
      unpriced: flows.unpriced,
    },
  };
}

const COLUMNS = [
  'id',
  'time',
  'source',
  'kind',
  'asset',
  'amount',
  'base_units',
  'usd',
  'usd_price',
  'usd_price_time',
  'reference',
  'counterparty_name',
  'counterparty_address',
  'chain',
  'tx',
  'block',
  'url',
  'linked',
] as const;

const NEEDS_QUOTES = /[",\r\n]/;
/** The full-width forms of = + - and @, which a spreadsheet may take for the plain ones. */
const FULL_WIDTH_SIGNS = String.fromCharCode(0xff1d, 0xff0b, 0xff0d, 0xff20);

/** A cell starts a formula if one of these signs is the first thing in it after any blanks, or if it starts with a tab or a line break. */
const STARTS_A_FORMULA = new RegExp(`^\\s*[=+\\-@${FULL_WIDTH_SIGNS}]|^[\\t\\r\\n]`);

function quote(cell: string): string {
  return NEEDS_QUOTES.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

/**
 * Text that came from outside — a memo, a payee's name — must not be run as a
 * formula by the spreadsheet that opens the file, so a cell starting with
 * `=`, `+`, `-` or `@` gets a leading apostrophe. The figures this module
 * formats itself are exempt: a negative amount starts with `-` and has to
 * stay a number.
 */
function text(value: string): string {
  return quote(STARTS_A_FORMULA.test(value) ? `'${value}` : value);
}

/** A figure is written bare only when it is one; anything else in its place is treated as the text it is. */
function figure(value: number | bigint | null): string {
  if (value === null) return '';
  return typeof value === 'bigint' || (typeof value === 'number' && Number.isFinite(value)) ? String(value) : text(String(value));
}

function units(entry: LedgerEntry): string {
  const plain = typeof entry.amount === 'bigint' && Number.isInteger(entry.decimals) && entry.decimals >= 0 && entry.decimals <= 36;
  return plain ? formatUnits(entry.amount, entry.decimals) : '';
}

function row(entry: LedgerEntry): string {
  return [
    text(entry.id),
    isoTime(entry.ts) ?? '',
    text(entry.source),
    text(entry.kind),
    text(entry.asset),
    units(entry),
    figure(entry.amount),
    figure(entry.usd),
    figure(entry.usdPrice),
    isoTime(entry.usdPriceAt) ?? '',
    text(entry.ref),
    text(entry.counterparty?.name ?? ''),
    text(entry.counterparty?.address ?? ''),
    text(entry.proof.chain),
    text(entry.proof.tx ?? ''),
    figure(entry.proof.block),
    text(entry.proof.url ?? ''),
    text(entry.linked.join(' ')),
  ].join(',');
}

/** The ledger as RFC 4180 CSV: comma-separated, CRLF line ends, quotes doubled inside quoted cells. */
export function toCsv(ledger: readonly LedgerEntry[]): string {
  return [COLUMNS.join(','), ...ledger.map(row)].map((line) => `${line}\r\n`).join('');
}

/** The ledger as JSON. Amounts are decimal strings of base units, since JSON numbers cannot carry them exactly. */
export function toJson(ledger: readonly LedgerEntry[]): string {
  return JSON.stringify(
    ledger.map((entry) => ({ ...entry, amount: entry.amount.toString() })),
    null,
    2,
  );
}
