import {
  AUDIT_MODULES,
  type AuditModule,
  type AuditScope,
  type DateRange,
  type LedgerEntry,
  type Match,
  type MatchKind,
  type Problem,
  type ProblemKind,
  type Reconciliation,
  type Statement,
  inRange,
  parseAuditScope,
  scopeStatement,
} from '@holdfast/books';
import type { OrgRecord } from '@holdfast/db';
import { hashToken } from '../books/audit-links';
import { type Books, gatherBooks, reconciliationOf, statementOf } from '../books/service';
import type { Deps } from '../deps';
import { ApiError, notFound } from '../errors';
import { type Reading, available, missing } from '../reading';

/** How long the reconciliation may wait for the payout chains before the books are shown without it, ms. */
export const RECONCILIATION_PATIENCE_MS = 20_000;

/**
 * The books as the pages show them: the statement, the ledger behind it and
 * the reconciliation, read together so that all three describe the same
 * moment. The owner's page, the public demo and an auditor's link each get
 * the same shape, cut down to what that reader may see.
 */

type BooksDeps = Pick<Deps, 'store' | 'hyperliquid' | 'tempo' | 'solana' | 'now' | 'redact'>;

/** Where a reconciliation comes from: the service's own records, held against each other and against the payout chains. */
export const RECORDS = 'records and chains';

/**
 * The things a reconciliation holds against each other, one check for each:
 * payout lines against the transfers on their chain, swaps against the
 * payments that funded them and what arrived, orders in the journal against
 * fills on the venue, the balances the journal recorded against the ledger,
 * and the records themselves for being well formed and unique.
 */
export const RECONCILIATION_CHECKS = ['payouts', 'swaps', 'orders', 'balances', 'records'] as const;
export type CheckId = (typeof RECONCILIATION_CHECKS)[number];

const CHECK_OF_MATCH: Record<MatchKind, CheckId> = { payout_line: 'payouts', swap: 'swaps', order: 'orders', balance: 'balances' };

const CHECK_OF_PROBLEM: Record<ProblemKind, CheckId> = {
  missing_transfer: 'payouts',
  wrong_amount: 'payouts',
  wrong_recipient: 'payouts',
  duplicate_memo: 'payouts',
  unexpected_transfer: 'payouts',
  memo_not_on_chain: 'payouts',
  run_total_mismatch: 'payouts',
  run_status_mismatch: 'payouts',
  run_tx_mismatch: 'payouts',
  run_unsettled: 'payouts',
  payout_ledger_mismatch: 'payouts',
  unknown_token: 'payouts',
  unfunded_swap: 'swaps',
  swap_funding_mismatch: 'swaps',
  swap_arrival_missing: 'swaps',
  swap_arrival_mismatch: 'swaps',
  swap_below_minimum: 'swaps',
  swap_unsettled: 'swaps',
  swap_entry_without_swap: 'swaps',
  swap_ledger_mismatch: 'swaps',
  order_without_fill: 'orders',
  fill_without_order: 'orders',
  fill_size_mismatch: 'orders',
  fill_side_mismatch: 'orders',
  duplicate_cloid: 'orders',
  balance_mismatch: 'balances',
  balance_unverifiable: 'balances',
  balance_unrecorded: 'balances',
  malformed_entry: 'records',
  duplicate_record: 'records',
  unreadable: 'records',
};

export interface ReconciliationCheck {
  id: CheckId;
  /** The records the check found to agree, each with the references that name them. */
  matched: Match[];
  /** What it found that does not agree, or could not be settled. */
  problems: Problem[];
}

/** A reconciliation sorted into its checks, in a fixed order, every check present even when it found nothing. */
export function checksOf(reconciliation: Reconciliation): ReconciliationCheck[] {
  return RECONCILIATION_CHECKS.map((id) => ({
    id,
    matched: reconciliation.matched.filter((match) => CHECK_OF_MATCH[match.kind] === id),
    problems: reconciliation.problems.filter((problem) => CHECK_OF_PROBLEM[problem.kind] === id),
  }));
}

/** The modules a scope has to cover before the outcome of a check tells its holder nothing they could not already see. */
const CHECK_NEEDS: Record<CheckId, readonly AuditModule[]> = {
  payouts: ['payouts'],
  swaps: ['treasury', 'swaps'],
  orders: ['hedge'],
  balances: ['treasury'],
  records: AUDIT_MODULES,
};

/**
 * The checks an auditor's scope may be shown. A check runs over every record
 * of its kind, from the first to the latest, and its findings name records
 * by id and by amount. So a scope sees a check only when it has no date
 * bound that leaves a record out, and covers every module the check reads.
 */
export function checksInScope(scope: AuditScope, asOf: number): CheckId[] {
  if (scope.from !== null || !inRange(asOf, scope)) return [];
  return RECONCILIATION_CHECKS.filter((id) => CHECK_NEEDS[id].every((module) => scope.modules.includes(module)));
}

export interface BooksPage {
  statement: Statement;
  /** The ledger entries of the statement's period, oldest first. */
  ledger: LedgerEntry[];
  /** How many entries the whole ledger holds, whatever the period. */
  entries: number;
  /** The UTC months, `YYYY-MM`, that hold at least one entry: what a period can be chosen from. */
  months: string[];
  /** The checks of the reconciliation, over the whole of the records and not the period alone. */
  reconciliation: Reading<ReconciliationCheck[]>;
}

const monthOf = (ts: number): string => new Date(ts).toISOString().slice(0, 7);

function monthsOf(ledger: readonly LedgerEntry[]): string[] {
  return [...new Set(ledger.filter((entry) => Number.isFinite(entry.ts) && entry.ts > 0).map((entry) => monthOf(entry.ts)))].sort();
}

/**
 * The reconciliation, or the reason there is none. A payout chain that
 * cannot be read, or that does not answer within `patienceMs`, leaves the
 * whole of it unavailable: a check that silently skipped a run would read as
 * agreement.
 */
async function reconciliationReading(deps: BooksDeps, org: OrgRecord, books: Books, patienceMs: number): Promise<Reading<ReconciliationCheck[]>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), patienceMs);
  });
  try {
    const work = reconciliationOf(deps, org, books);
    // Whatever the reconciliation does after the page has stopped waiting for it is nobody's to handle.
    work.catch(() => undefined);
    const outcome = await Promise.race([work, late]);
    if (outcome === 'late') return missing(RECORDS, deps.now(), `the payout chains did not answer within ${patienceMs / 1000} s`);
    return available(RECORDS, deps.now(), checksOf(outcome));
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'unavailable') throw error;
    const source = String(error.details.source ?? RECORDS);
    const prefix = `${source} is unavailable: `;
    const reason = error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
    return missing(source, deps.now(), deps.redact(reason));
  } finally {
    clearTimeout(timer);
  }
}

export interface BooksOptions {
  /** How long the reconciliation may wait for the payout chains, ms. */
  reconciliationPatienceMs?: number;
}

/** The books of an organisation for its owner, with the flow figures and the ledger cut to `range`. */
export async function booksPage(deps: BooksDeps, org: OrgRecord, range: DateRange, options: BooksOptions = {}): Promise<BooksPage> {
  const books = await gatherBooks(deps, org);
  return {
    statement: statementOf(deps, org, books, range),
    ledger: books.ledger.filter((entry) => inRange(entry.ts, range)),
    entries: books.ledger.length,
    months: monthsOf(books.ledger),
    reconciliation: await reconciliationReading(deps, org, books, options.reconciliationPatienceMs ?? RECONCILIATION_PATIENCE_MS),
  };
}

/**
 * The same books for the public face of an organisation that has chosen to
 * be a demo. Payees are not named, here as in the demo's payouts: a payout
 * entry keeps its amount, its memo and its transaction and loses whom it
 * paid. An organisation that is not a demo answers as not found.
 */
export async function demoBooksPage(deps: BooksDeps, org: OrgRecord, range: DateRange, options: BooksOptions = {}): Promise<BooksPage> {
  if (!org.publicDemo) throw notFound();
  const page = await booksPage(deps, org, range, options);
  const { payouts } = page.statement;
  return {
    ...page,
    statement: { ...page.statement, payouts: payouts === null ? null : { ...payouts, byPayee: [] } },
    ledger: page.ledger.map((entry) => (entry.kind === 'payout' ? { ...entry, counterparty: null } : entry)),
  };
}

export interface AuditPage {
  organisation: string;
  label: string;
  expiresAt: number | null;
  scope: AuditScope;
  statement: Statement;
  ledger: LedgerEntry[];
  /** The checks this scope may see; empty when it may see none. */
  checks: CheckId[];
  /** Those checks' outcomes; null when the scope may see none, so none were run for it. */
  reconciliation: Reading<ReconciliationCheck[]> | null;
}

/**
 * What the holder of an auditor link is shown: the scoped statement and
 * ledger, as `auditView` gives them, and beside them the reconciliation
 * checks the scope may see. A token that is unknown, revoked or expired, or
 * whose stored scope cannot be read as one, opens nothing and is told
 * nothing: every such case is the same "not found".
 */
export async function auditPage(deps: BooksDeps, token: string): Promise<AuditPage> {
  const link = await deps.store.liveAuditLink(hashToken(token));
  if (link === null) throw notFound();
  let scope: AuditScope;
  try {
    scope = parseAuditScope(link.scope);
  } catch {
    throw notFound();
  }
  if (scope.modules.length === 0) throw notFound();
  const org = await deps.store.findOrg(link.orgId);
  if (org === null) throw notFound();

  const books = await gatherBooks(deps, org);
  const scoped = scopeStatement(statementOf(deps, org, books), books.ledger, scope);
  const checks = checksInScope(scoped.scope, scoped.statement.asOf);
  let reconciliation: AuditPage['reconciliation'] = null;
  if (checks.length > 0) {
    const whole = await reconciliationReading(deps, org, books, RECONCILIATION_PATIENCE_MS);
    reconciliation = whole.status === 'ok' ? { ...whole, value: whole.value.filter((check) => checks.includes(check.id)) } : whole;
  }
  return { organisation: org.name, label: link.label, expiresAt: link.expiresAt, scope: scoped.scope, statement: scoped.statement, ledger: scoped.ledger, checks, reconciliation };
}
