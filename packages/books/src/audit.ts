import { formatUnits } from './assets';
import { isTreasuryZec, type LedgerEntry, sumAmounts } from './entry';
import { type DateRange, inRange, summariseFlows } from './flows';
import type { Statement, StaleSource } from './statement';

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

/** A treasury payment into a swap belongs to both: it is the treasury's spend and the swap's input. */
export function entryModules(entry: LedgerEntry): AuditModule[] {
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
 * from the entries that stay. Period totals are worked out again from the
 * entries that remain. A figure that cannot be derived from those entries
 * alone would give away what was removed, so it is dropped rather than
 * carried over: a balance needs the whole history up to its date, a current
 * reading needs the scope's dates to include the statement's own, and value,
 * drift, runway and the series combine every module.
 */
export function scopeStatement(statement: Statement, ledger: readonly LedgerEntry[], scope: AuditScope): ScopedStatement {
  const has = (module: AuditModule) => scope.modules.includes(module);
  const range: DateRange = { from: later(statement.range.from, scope.from), to: earlier(statement.range.to, scope.to) };

  const visible = ledger.filter((entry) => inRange(entry.ts, scope) && entryModules(entry).some(has));
  const ids = new Set(visible.map((entry) => entry.id));
  const scoped = visible.map((entry) => ({ ...entry, linked: entry.linked.filter((id) => ids.has(id)) }));
  const flows = summariseFlows(scoped, range);

  const everyModule = AUDIT_MODULES.every(has);
  const fromTheStart = scope.from === null;
  const toThePresent = inRange(statement.asOf, scope);
  const whole = everyModule && fromTheStart && toThePresent;

  const treasuryEntries = scoped.filter(isTreasuryZec);
  const balanceAtEnd = {
    zat: sumAmounts(treasuryEntries),
    untrackedZat: sumAmounts(treasuryEntries.filter((entry) => entry.kind === 'receipt_untracked')),
    asOf: null,
    px: null,
    pxAt: null,
    usd: null,
  };

  return {
    scope: { from: scope.from, to: scope.to, modules: [...scope.modules] },
    ledger: scoped,
    statement: {
      asOf: statement.asOf,
      range,
      monthlyBurnUsd: whole ? statement.monthlyBurnUsd : null,
      staleAfterMs: statement.staleAfterMs,
      seriesStep: statement.seriesStep,
      treasury: !has('treasury') || !fromTheStart ? null : toThePresent ? statement.treasury : balanceAtEnd,
      hedge: has('hedge') && toThePresent ? statement.hedge : null,
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
      series: everyModule ? statement.series.filter((point) => inRange(point.t, scope)) : [],
      stale: statement.stale.filter((s) => staleInScope(s, has)),
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
const STARTS_A_FORMULA = /^[=+\-@\t\r]/;

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

const figure = (value: number | bigint | null): string => (value === null ? '' : String(value));
const isoTime = (ms: number | null): string => (ms === null || !Number.isFinite(ms) ? '' : new Date(ms).toISOString());

function row(entry: LedgerEntry): string {
  return [
    text(entry.id),
    isoTime(entry.ts),
    text(entry.source),
    text(entry.kind),
    text(entry.asset),
    formatUnits(entry.amount, entry.decimals),
    figure(entry.amount),
    figure(entry.usd),
    figure(entry.usdPrice),
    isoTime(entry.usdPriceAt),
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
