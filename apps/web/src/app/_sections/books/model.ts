import type { AuditModule, AuditScope, DateRange, LedgerEntry, LedgerKind, LedgerSource } from '@holdfast/books';
import type { CheckId, ReconciliationCheck } from '@/server/pages/books';
import { formatSignedUnits } from './amounts';

/**
 * What the Books page works out from what the server read: the period a
 * request asks for, the ledger as rows a person can read, and what each
 * reconciliation check compared. Nothing here reads anything.
 */

// The period.

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The first and the last millisecond of a UTC month written `YYYY-MM`; null when it is not one. */
export function monthRange(month: string): { from: number; to: number } | null {
  const match = MONTH.exec(month);
  if (match === null) return null;
  const year = Number(match[1]);
  const index = Number(match[2]) - 1;
  return { from: Date.UTC(year, index, 1), to: Date.UTC(year, index + 1, 1) - 1 };
}

/** `2026-10` as `October 2026`. */
export function monthName(month: string): string {
  const match = MONTH.exec(month);
  return match === null ? month : `${MONTH_NAMES[Number(match[2]) - 1]} ${match[1]}`;
}

export type Period = { id: 'all'; range: DateRange } | { id: string; range: { from: number; to: number } };

export const ALL_TIME: Period = { id: 'all', range: { from: null, to: null } };

/**
 * The period a page address asks for. Anything that is not a month the
 * address can name is the whole of the books: a mistyped period shows
 * everything and never an empty statement that could be read as "nothing
 * happened".
 */
export function periodOf(param: string | string[] | undefined): Period {
  if (typeof param !== 'string') return ALL_TIME;
  const range = monthRange(param);
  return range === null ? ALL_TIME : { id: param, range };
}

// The ledger.

export const SOURCE_NAME: Record<LedgerSource, string> = { zcash: 'Zcash', swap: 'Swap', hyperliquid: 'Hyperliquid', tempo: 'Tempo', solana: 'Solana' };

const WHAT: Record<LedgerKind, string> = {
  receipt: 'Payment received',
  receipt_untracked: 'Payment received, in a pool whose spends the viewing key cannot follow',
  change: 'Change returned from the treasury’s own payment',
  payment: 'Payment sent from the treasury',
  swap_out: 'ZEC sent into a swap',
  network_fee: 'Network fee',
  swap_in: 'Swap delivered',
  hedge_open: 'Short opened',
  hedge_close: 'Short bought back',
  realized_pnl: 'Profit or loss realised on the hedge',
  trade_fee: 'Trading fee',
  funding: 'Funding',
  payout: 'Payout',
};

export interface LedgerRow {
  id: string;
  /** When it happened on its own chain or venue, ms; for a folded row, the latest of its entries. */
  ts: number;
  /** How many ledger entries the row stands for. More than one only for funding, which is paid every hour. */
  entries: number;
  source: LedgerSource;
  what: string;
  /** The reference the entry carries: a memo or an invoice number as text, a client order id or a swap id as an identifier. */
  detail: { kind: 'text' | 'id'; value: string } | null;
  /** Whom a payout paid, where the reader may know. */
  payee: string | null;
  /** The amount in its own unit, signed: `+0.01975`. */
  amount: string;
  asset: string;
  /** Null when no price could be applied to the entry. */
  usd: number | null;
  /** A hedge entry's dollars are the size of the trade, not money in or out. */
  notional: boolean;
  /** Where the entry can be checked on its chain; null where the source has no transaction to point at. */
  proof: { chain: string; tx: string; url: string | null; block: number | null } | null;
}

const DAY_MS = 86_400_000;
const NOTIONAL: readonly LedgerKind[] = ['hedge_open', 'hedge_close'];
/** Every amount is written with at least this many decimals, so that a column of them lines up on the cents. */
const MIN_FRACTION = 2;
/** A reference that is one long run of hex or base58 is an identifier, not something a person wrote. */
const IDENTIFIER = /^(0x[0-9a-fA-F]{16,}|[1-9A-HJ-NP-Za-km-z]{32,})$/;

function detailOf(ref: string): LedgerRow['detail'] {
  if (ref === '') return null;
  return { kind: IDENTIFIER.test(ref) ? 'id' : 'text', value: ref };
}

function rowOf(entry: LedgerEntry): LedgerRow {
  return {
    id: entry.id,
    ts: entry.ts,
    entries: 1,
    source: entry.source,
    what: WHAT[entry.kind] ?? entry.kind,
    detail: detailOf(entry.ref),
    payee: entry.counterparty?.name ?? null,
    amount: formatSignedUnits(entry.amount, entry.decimals, MIN_FRACTION),
    asset: entry.asset,
    usd: entry.usd,
    notional: NOTIONAL.includes(entry.kind),
    proof: entry.proof.tx === null ? null : { chain: entry.proof.chain, tx: entry.proof.tx, url: entry.proof.url, block: entry.proof.block },
  };
}

/**
 * The ledger as rows, newest first. Funding is paid every hour, so the
 * payments of one UTC day in one asset are added up into one row that says
 * how many it holds; every other entry is a row of its own. The exports hold
 * every entry singly.
 */
export function ledgerRows(ledger: readonly LedgerEntry[]): LedgerRow[] {
  const rows: LedgerRow[] = [];
  const folded = new Map<string, { row: LedgerRow; amount: bigint; decimals: number }>();
  for (const entry of ledger) {
    if (entry.kind !== 'funding') {
      rows.push(rowOf(entry));
      continue;
    }
    const key = `funding:${entry.source}:${entry.asset}:${entry.decimals}:${Math.floor(entry.ts / DAY_MS)}`;
    const held = folded.get(key);
    if (held === undefined) {
      const row = { ...rowOf(entry), id: key, detail: null };
      folded.set(key, { row, amount: entry.amount, decimals: entry.decimals });
      rows.push(row);
      continue;
    }
    held.amount += entry.amount;
    held.row.entries += 1;
    held.row.ts = Math.max(held.row.ts, entry.ts);
    // One payment without a dollar value leaves the day's total without one.
    held.row.usd = held.row.usd === null || entry.usd === null ? null : held.row.usd + entry.usd;
    held.row.amount = formatSignedUnits(held.amount, held.decimals, MIN_FRACTION);
  }
  for (const { row } of folded.values()) {
    if (row.entries > 1) row.what = `Funding, ${row.entries} hourly payments`;
  }
  return rows.sort((a, b) => b.ts - a.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** What the hedge realised in the entries given: the sum of its closed profit and loss, null when one entry has no dollar value. */
export function realisedOnHedge(ledger: readonly LedgerEntry[]): { usd: number | null; count: number } {
  const entries = ledger.filter((entry) => entry.source === 'hyperliquid' && entry.kind === 'realized_pnl');
  let usd: number | null = 0;
  for (const entry of entries) usd = usd === null || entry.usd === null ? null : usd + entry.usd;
  return { usd, count: entries.length };
}

// The reconciliation.

export interface CheckCopy {
  title: string;
  /** The two things held against each other. */
  left: string;
  right: string;
}

export const CHECK_COPY: Record<CheckId, CheckCopy> = {
  payouts: {
    title: 'Payout lines',
    left: 'Each line of every payout run the service recorded',
    right: 'the transfers found on Tempo and Solana for that run, read now',
  },
  swaps: {
    title: 'Swaps',
    left: 'Each swap on record',
    right: 'the treasury payment that funded it and what was delivered',
  },
  orders: {
    title: 'Orders',
    left: 'Each order the controller’s journal says it placed',
    right: 'the fills Hyperliquid shows for the account',
  },
  balances: {
    title: 'Treasury balances',
    left: 'The balance the journal recorded at each tick',
    right: 'what the ledger’s own Zcash entries add up to at that block',
  },
  records: {
    title: 'The records themselves',
    left: 'Every ledger entry, swap and payout run',
    right: 'the form it has to have, and every other record for a duplicate',
  },
};

/** A count with its noun. One is written as a word: the serif's figure one reads as a capital I. */
const count = (n: number, one: string, many: string): string => (n === 1 ? `One ${one}` : `${n} ${many}`);

const JOURNAL_REF = /^journal:(\d+)$/;

/** The journal entries a balance match covers, from its references: one entry, or the first and the last of a stretch. */
function journalStretch(refs: readonly string[]): string | null {
  const seqs = refs.map((ref) => JOURNAL_REF.exec(ref)?.[1]).filter((seq): seq is string => seq !== undefined);
  if (seqs.length === 0) return null;
  return seqs.length === 1 ? `entry ${seqs[0]}` : `entries ${seqs[0]} to ${seqs[seqs.length - 1]}`;
}

/** What a check found to agree, in a sentence; null when it found nothing to pair. */
export function agreementOf(check: ReconciliationCheck): string | null {
  const n = check.matched.length;
  if (check.id === 'records') return check.problems.length === 0 ? 'No record is malformed and none appears twice.' : null;
  if (n === 0) return null;
  switch (check.id) {
    case 'payouts':
      return `${count(n, 'line was', 'lines were')} found on chain with the recorded payee and amount.`;
    case 'swaps':
      return `${count(n, 'swap was', 'swaps were')} funded and delivered as recorded.`;
    case 'orders':
      return `${count(n, 'order was', 'orders were')} filled on the venue as the journal says.`;
    case 'balances': {
      const stretches = check.matched.map((match) => journalStretch(match.refs)).filter((text): text is string => text !== null);
      return stretches.length === 0 ? `${count(n, 'stretch of the journal agrees', 'stretches of the journal agree')} with the ledger.` : `Journal ${stretches.join(', ')}: the recorded balance is what the ledger adds up to.`;
    }
  }
}

/** What it means that a check paired nothing. */
export const NOTHING_TO_COMPARE: Record<CheckId, string> = {
  payouts: 'No payout run has been handed to a rail, so there is nothing to hold against a chain.',
  swaps: 'No swap is on record.',
  orders: 'The journal records no order.',
  balances: 'The journal holds no reading of the treasury yet.',
  records: '',
};

export type Verdict = 'agrees' | 'differs' | 'warned' | 'nothing';

/** How a check came out: an error means records differ; a warning means something is not settled yet; with neither, it agrees or had nothing to compare. */
export function verdictOf(check: ReconciliationCheck): Verdict {
  if (check.problems.some((problem) => problem.severity === 'error')) return 'differs';
  if (check.problems.length > 0) return 'warned';
  // The check of the records themselves pairs nothing: it passes by finding no fault.
  return check.matched.length > 0 || check.id === 'records' ? 'agrees' : 'nothing';
}

/** The whole reconciliation in one word, from its checks. */
export function overallVerdict(checks: readonly ReconciliationCheck[]): Verdict {
  const verdicts = checks.map(verdictOf);
  if (verdicts.includes('differs')) return 'differs';
  if (verdicts.includes('warned')) return 'warned';
  return verdicts.includes('agrees') ? 'agrees' : 'nothing';
}

// An auditor's scope.

/** The modules a scope is made of, in the order they are listed. Kept here, beside their names, for the code that runs in the browser. */
export const MODULES: readonly AuditModule[] = ['treasury', 'hedge', 'swaps', 'payouts'];

export const MODULE_NAME: Record<AuditModule, string> = { treasury: 'Treasury', hedge: 'Hedge', swaps: 'Swaps', payouts: 'Payouts' };

/** What each module holds, as a sentence without its full stop. */
export const MODULE_COVERS: Record<AuditModule, string> = {
  treasury: 'What the viewing key shows: payments in, payments out and network fees',
  hedge: 'The fills, fees and funding of the short on Hyperliquid',
  swaps: 'ZEC sent into swaps and what each delivered',
  payouts: 'The payout runs on Tempo and Solana, line by line',
};

/** The dates a scope covers, in words. Both ends are inclusive, as the server applies them. */
export function scopeDates(scope: Pick<AuditScope, 'from' | 'to'>, format: (ms: number) => string): string {
  if (scope.from === null && scope.to === null) return 'Every date, from the first entry onwards';
  if (scope.from === null) return `Everything up to ${format(scope.to as number)}`;
  if (scope.to === null) return `Everything from ${format(scope.from)} onwards`;
  return `From ${format(scope.from)} to ${format(scope.to)}`;
}

// A new auditor link.

export interface AuditLinkFields {
  label: string;
  /** UTC days as a date field writes them, `YYYY-MM-DD`; empty for an open end. */
  from: string;
  to: string;
  modules: readonly AuditModule[];
  /** The last UTC day the link works on; empty for no expiry. */
  expires: string;
}

export type AuditLinkField = 'label' | 'from' | 'to' | 'modules' | 'expires';

export type AuditLinkCheck =
  | { ok: true; input: { label: string; scope: { from: number | null; to: number | null; modules: AuditModule[] }; expiresAt: number | null } }
  | { ok: false; errors: Partial<Record<AuditLinkField, string>> };

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
export const AUDIT_LABEL_MAX = 120;

/** The first millisecond of a UTC day written `YYYY-MM-DD`; null when the text is not a day that exists. */
export function dayStart(text: string): number | null {
  const match = DAY.exec(text);
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = Date.UTC(year, month - 1, day);
  const date = new Date(at);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? at : null;
}

/**
 * What the form for a new auditor link holds, checked the way the server
 * checks it, so that a link the server would refuse is never asked for. A
 * scope's dates are whole UTC days: it starts with the first millisecond of
 * its first day and ends with the last of its last. A link expires at the
 * end of the day named.
 */
export function checkAuditLink(fields: AuditLinkFields, now: number): AuditLinkCheck {
  const errors: Partial<Record<AuditLinkField, string>> = {};
  const label = fields.label.trim();
  if (label === '') errors.label = 'Give the link a name, so that you know later whom it was for.';
  else if (label.length > AUDIT_LABEL_MAX) errors.label = `A name is at most ${AUDIT_LABEL_MAX} characters; this one has ${label.length}.`;

  const from = fields.from === '' ? null : dayStart(fields.from);
  if (fields.from !== '' && from === null) errors.from = 'This is not a date.';
  const toStart = fields.to === '' ? null : dayStart(fields.to);
  if (fields.to !== '' && toStart === null) errors.to = 'This is not a date.';
  const to = toStart === null ? null : toStart + DAY_MS - 1;
  if (from !== null && to !== null && from > to) errors.to = 'The scope ends before it starts.';

  const modules = [...new Set(fields.modules)];
  if (modules.length === 0) errors.modules = 'Choose at least one module: a link that covers nothing shows nothing.';

  const expiresStart = fields.expires === '' ? null : dayStart(fields.expires);
  if (fields.expires !== '' && expiresStart === null) errors.expires = 'This is not a date.';
  const expiresAt = expiresStart === null ? null : expiresStart + DAY_MS - 1;
  if (expiresAt !== null && expiresAt <= now) errors.expires = 'The link would have expired before it was made.';

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, input: { label, scope: { from, to, modules }, expiresAt } };
}

export type LinkState = 'live' | 'expired' | 'revoked' | 'unreadable';

/** Where a link stands at `now`. A link whose stored scope cannot be read as one opens nothing, whatever else is true of it. */
export function linkState(link: { scope: unknown; expiresAt: number | null; revokedAt: number | null }, now: number): LinkState {
  if (link.revokedAt !== null) return 'revoked';
  if (link.expiresAt !== null && link.expiresAt <= now) return 'expired';
  return link.scope === null ? 'unreadable' : 'live';
}
