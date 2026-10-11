import type { PayoutLine } from '@holdfast/core';
import type { OrgRecord, PayoutChain, PayoutRunRow, PayoutSettlement, PayoutStatus } from '@holdfast/db';
import { MAX_LINES_PER_RUN, lineMemo, lineOfMemo, sameLines } from '@holdfast/tempo';
import { getAddress, isAddress } from 'viem';
import { looksLikeSolanaAddress } from '../config';
import type { Deps, SolanaRunOnChain } from '../deps';
import { invalid, notFound, refused, unavailable } from '../errors';
import { solanaAccess, tempoAccess } from '../rails/access';
import { type Reading, reading } from '../reading';
import { messageOf } from '../redact';
import { txUrlOf } from './receipt';

type PayoutDeps = Pick<Deps, 'store' | 'tempo' | 'solana' | 'now' | 'redact'>;

/** The largest amount a Solana token account can hold. */
const U64_MAX = 2n ** 64n - 1n;
/** What the Solana rail says when it would not send because an earlier payment could not be ruled out yet. */
const NOT_RULED_OUT = /^could not rule out that run/;

export interface NewRunLine {
  payee: { name: string; address: string };
  /** Token base units. */
  amount: bigint;
  /** The payee's own reference, such as an invoice number; may be empty. */
  reference: string;
}

export interface RunView extends PayoutRunRow {
  txUrl: string | null;
}

/**
 * How an attempt to pay ended.
 * - `paid`: the run is paid, by this call or by an earlier one.
 * - `refused`: nothing was sent and the run stays unpaid; the error says what is in the way.
 * - `failed`: a transaction was sent and certainly paid nothing.
 * - `unsettled`: whether the run is paid is not established. It must not be treated as unpaid.
 * - `not_sent`: nothing was sent for a passing reason; the run is as it was and may be executed again.
 */
export type ExecutionOutcome = 'paid' | 'refused' | 'failed' | 'unsettled' | 'not_sent';

export interface Execution {
  run: RunView;
  outcome: ExecutionOutcome;
  /** True when the run was already paid and this call sent nothing. */
  replayed: boolean;
  error: string | null;
}

/** What a chain shows for a run id, in one shape for both chains. */
export interface RunOnChain {
  tx: string;
  txUrl: string;
  transfers: { to: string; amount: bigint; memo: string | null; logIndex: number | null }[];
  /** Further transactions carrying the run's memos: lines paid more than once. */
  otherTxs: string[];
  /** Whether the transfers are the run's lines: the same payees and amounts, in order. */
  matchesRun: boolean;
}

const viewOf = (deps: Pick<Deps, 'tempo' | 'solana'>, run: PayoutRunRow): RunView => ({ ...run, txUrl: run.tx === null ? null : txUrlOf(deps, run.chain, run.tx) });

const railLines = (run: PayoutRunRow): PayoutLine[] => run.lines.map((line) => ({ to: line.toAddress, amount: line.amount, memo: line.memo }));

/**
 * Create a draft run. Its id is the next of the month for this organisation,
 * and goes on chain with the payment: on Tempo every line's memo is
 * `<run id>/<line>`, on Solana the run id leads the transaction and each line
 * carries its reference. A Solana run also records a slot that is safely in
 * the past, before which it cannot have been paid.
 */
export async function createRun(deps: PayoutDeps, org: OrgRecord, input: { chain: PayoutChain; lines: readonly NewRunLine[] }): Promise<RunView> {
  const { lines } = input;
  if (lines.length > MAX_LINES_PER_RUN) throw invalid(`a run carries at most ${MAX_LINES_PER_RUN} lines`);

  if (input.chain === 'tempo') {
    const { account } = await tempoAccess(deps, org);
    const payees = lines.map((line, index) => {
      // A mixed-case address has to carry a correct checksum: a wrong one is a typo, not a payee.
      if (!isAddress(line.payee.address)) throw invalid(`line ${index + 1}: "${line.payee.address}" is not a Tempo address`);
      return getAddress(line.payee.address);
    });
    const run = await deps.store.createPayoutRun(org.id, {
      chain: 'tempo',
      token: deps.tempo.token,
      tokenSymbol: deps.tempo.tokenSymbol,
      tokenDecimals: deps.tempo.decimals,
      account,
      notBefore: null,
      at: deps.now(),
      lines: (runId) => lines.map((line, index) => ({ payeeName: line.payee.name, toAddress: payees[index] ?? '', amount: line.amount, memo: lineMemo(runId, index + 1), reference: line.reference })),
    });
    return viewOf(deps, run);
  }

  const { rail, owner } = await solanaAccess(deps, org);
  const references = new Set<string>();
  lines.forEach((line, index) => {
    if (!looksLikeSolanaAddress(line.payee.address)) throw invalid(`line ${index + 1}: "${line.payee.address}" is not a Solana address`);
    if (line.amount > U64_MAX) throw invalid(`line ${index + 1}: the amount is more than a token account can hold`);
    // The reference is the line's memo on chain, and a memo is how a line is found again.
    if (line.reference !== '' && references.has(line.reference)) throw invalid(`line ${index + 1}: reference "${line.reference}" is used by an earlier line`);
    references.add(line.reference);
  });
  let notBefore: bigint;
  try {
    notBefore = await rail.checkpoint();
  } catch (error) {
    throw unavailable('Solana', deps.redact(messageOf(error)));
  }
  const run = await deps.store.createPayoutRun(org.id, {
    chain: 'solana',
    token: deps.solana.mint,
    tokenSymbol: deps.solana.tokenSymbol,
    tokenDecimals: deps.solana.decimals,
    account: owner,
    notBefore,
    at: deps.now(),
    lines: () => lines.map((line) => ({ payeeName: line.payee.name, toAddress: line.payee.address, amount: line.amount, memo: line.reference, reference: line.reference })),
  });
  return viewOf(deps, run);
}

export async function listRuns(deps: PayoutDeps, orgId: string): Promise<RunView[]> {
  return (await deps.store.listPayoutRuns(orgId)).map((run) => viewOf(deps, run));
}

async function requireRun(deps: PayoutDeps, orgId: string, runId: string): Promise<PayoutRunRow> {
  const run = await deps.store.findPayoutRun(orgId, runId);
  if (run === null) throw notFound();
  return run;
}

/** The account a run pays from: the one it was created for. */
function accountOf(run: PayoutRunRow): string {
  if (run.account === null) throw refused(`run ${run.id} was recorded without the account it pays from`);
  return run.account;
}

export interface RunPreview {
  run: RunView;
  /** Whether executing now would go ahead: send the run, or answer with the payment already made. */
  wouldProceed: boolean;
  problems: string[];
  /** Solana only. */
  solana: { alreadyPaid: boolean; spent: boolean; paidBy: string | null; lineMemos: boolean; cost: { newTokenAccounts: number; rentLamports: bigint; markerLamports: bigint; feeLamports: bigint } | null; historyError: string | null } | null;
}

/** Everything the rail checks before it sends, without sending: allowance, balance, key, payees, fees. */
export async function previewRun(deps: PayoutDeps, org: OrgRecord, runId: string): Promise<RunPreview> {
  const run = await requireRun(deps, org.id, runId);
  const account = accountOf(run);
  const lines = railLines(run);
  if (run.chain === 'tempo') {
    const { rail } = await tempoAccess(deps, org);
    const check = await rail.preflight({ account, lines, runId });
    return { run: viewOf(deps, run), wouldProceed: check.ok, problems: check.ok ? [] : check.problems.map(deps.redact), solana: null };
  }
  const { rail } = await solanaAccess(deps, org);
  const preview = await rail.preview({ account, lines, runId, ...(run.notBefore === null ? {} : { notBefore: run.notBefore }) });
  return {
    run: viewOf(deps, run),
    wouldProceed: preview.ok,
    problems: preview.error === null ? [] : [deps.redact(preview.error)],
    solana: { alreadyPaid: preview.alreadyPaid, spent: preview.spent, paidBy: preview.paidBy, lineMemos: preview.lineMemos, cost: preview.cost, historyError: preview.historyError },
  };
}

function solanaMatches(run: PayoutRunRow, found: SolanaRunOnChain): boolean {
  return (
    found.transfers.length === run.lines.length &&
    found.transfers.every((transfer, index) => {
      const line = run.lines[index];
      return line !== undefined && transfer.to === line.toAddress && transfer.amount === line.amount && (transfer.memo === null || transfer.memo === line.memo);
    })
  );
}

/** Ask the run's chain what it holds under the run id. Rejects when the chain cannot give a whole answer. */
async function lookUp(deps: PayoutDeps, org: OrgRecord, run: PayoutRunRow): Promise<RunOnChain | null> {
  const account = accountOf(run);
  if (run.chain === 'tempo') {
    const { rail } = await tempoAccess(deps, org);
    const found = await rail.findRun(account, run.id);
    if (found === null) return null;
    return {
      tx: found.tx,
      txUrl: deps.tempo.txUrl(found.tx),
      transfers: found.lines.map((line) => ({ to: line.to, amount: line.amount, memo: line.memo, logIndex: line.logIndex })),
      otherTxs: [...found.otherTxs],
      matchesRun: found.otherTxs.length === 0 && sameLines(railLines(run), found.lines),
    };
  }
  const { rail } = await solanaAccess(deps, org);
  const found = await rail.findRun(account, run.id, run.notBefore === null ? {} : { notBefore: run.notBefore });
  if (found === null) return null;
  return {
    tx: found.signature,
    txUrl: deps.solana.txUrl(found.signature),
    transfers: found.transfers.map((transfer) => ({ to: transfer.to, amount: transfer.amount, memo: transfer.memo, logIndex: null })),
    otherTxs: [],
    matchesRun: solanaMatches(run, found),
  };
}

/** The settlement that records a run as paid by what was found on chain, line by line. */
function paidBy(run: PayoutRunRow, found: RunOnChain, at: number): PayoutSettlement {
  return {
    status: 'paid',
    tx: found.tx,
    error: null,
    executedAt: run.executedAt ?? at,
    lines: run.lines.map((line, index) => {
      const transfer = run.chain === 'tempo' ? found.transfers.find((t) => t.memo !== null && lineOfMemo(t.memo, run.id) === line.lineNo) : found.transfers[index];
      return { lineNo: line.lineNo, tx: found.tx, logIndex: transfer?.logIndex ?? null, reconciled: transfer !== undefined };
    }),
  };
}

/**
 * A run with what its chain shows for it now. When the chain holds the run's
 * own lines under its id, the run is recorded as paid by that transaction,
 * whatever the database thought before: that is how a payment whose outcome
 * was not seen gets settled. A draft was never sent and is not looked up.
 */
export async function runStatus(deps: PayoutDeps, org: OrgRecord, runId: string): Promise<{ run: RunView; onChain: Reading<RunOnChain | null> | null }> {
  const run = await requireRun(deps, org.id, runId);
  if (run.status === 'draft') return { run: viewOf(deps, run), onChain: null };
  const onChain = await reading(run.chain, deps, () => lookUp(deps, org, run));
  let current = run;
  if (onChain.status === 'ok' && onChain.value !== null && onChain.value.matchesRun && (run.status !== 'paid' || run.lines.some((line) => !line.reconciled))) {
    current = (await deps.store.settlePayoutRun(org.id, runId, paidBy(run, onChain.value, deps.now()))) ?? run;
  }
  return { run: viewOf(deps, current), onChain };
}

/** What to record after an attempt, given what the run was before it. */
function settlement(prior: PayoutStatus, attempt: { outcome: ExecutionOutcome; tx: string | null; error: string | null }, at: number): PayoutSettlement {
  const { outcome, tx, error } = attempt;
  if (outcome === 'paid') return { status: 'paid', tx, error: null, executedAt: at };
  // An earlier attempt whose outcome was never seen may still have paid; only a payment settles that.
  if (prior === 'sending' || outcome === 'unsettled') return { status: 'sending', tx, error, executedAt: null };
  if (outcome === 'not_sent') return { status: prior, tx: null, error, executedAt: null };
  return { status: outcome === 'failed' ? 'failed' : 'refused', tx, error, executedAt: null };
}

/**
 * Pay a run through its rail. The rail is what makes this safe to repeat: on
 * Tempo it looks the run up on chain before it sends and its transaction can
 * only collide with an earlier one; on Solana the chain refuses a second
 * payout of the same run id. Nothing here is a guard of its own on top.
 *
 * A run that is paid is answered from the record. A Solana run whose last
 * attempt was left unsettled is not sent again under the same id: it is
 * looked up, and settled if the chain shows it paid.
 */
export async function executeRun(deps: PayoutDeps, org: OrgRecord, runId: string): Promise<Execution> {
  const run = await requireRun(deps, org.id, runId);
  if (run.status === 'paid') return { run: viewOf(deps, run), outcome: 'paid', replayed: true, error: null };
  const account = accountOf(run);
  const lines = railLines(run);
  const access = run.chain === 'tempo' ? { chain: 'tempo' as const, ...(await tempoAccess(deps, org)) } : { chain: 'solana' as const, ...(await solanaAccess(deps, org)) };

  const prior = await deps.store.beginPayoutRun(org.id, runId);
  if (prior === null) throw notFound();
  const finish = async (attempt: { outcome: ExecutionOutcome; tx: string | null; error: string | null }, replayed = false): Promise<Execution> => {
    const error = attempt.error === null ? null : deps.redact(attempt.error);
    const settled = await deps.store.settlePayoutRun(org.id, runId, settlement(prior, { ...attempt, error }, deps.now()));
    if (settled === null) throw notFound();
    // Another call may have recorded the run as paid in the meantime; the record is what holds.
    return settled.status === 'paid' ? { run: viewOf(deps, settled), outcome: 'paid', replayed: replayed || attempt.outcome !== 'paid', error: null } : { run: viewOf(deps, settled), outcome: attempt.outcome, replayed, error };
  };
  if (prior === 'paid') return finish({ outcome: 'paid', tx: run.tx, error: null }, true);

  if (access.chain === 'tempo') {
    const result = await access.rail.pay({ account, lines, runId });
    if (result.ok) return finish({ outcome: 'paid', tx: result.tx, error: null }, result.alreadyPaid);
    // With no transaction to name, this call put nothing on chain; with one, its fate is the rail's to tell and it has not said "paid".
    return finish({ outcome: result.tx === null && prior !== 'sending' ? 'refused' : 'unsettled', tx: result.tx, error: result.error });
  }

  if (prior === 'sending') {
    let found: RunOnChain | null;
    try {
      found = await lookUp(deps, org, run);
    } catch (error) {
      throw unavailable('Solana', `run ${runId} is unsettled and could not be looked up: ${deps.redact(messageOf(error))}`);
    }
    if (found !== null && found.matchesRun) {
      const settled = await deps.store.settlePayoutRun(org.id, runId, paidBy(run, found, deps.now()));
      if (settled === null) throw notFound();
      return { run: viewOf(deps, settled), outcome: 'paid', replayed: true, error: null };
    }
    const error = found === null ? `no payment of run ${runId} is on chain; it stays unsettled and is not sent again under the same id` : `run ${runId} is on chain in ${found.tx} with other lines than these`;
    return finish({ outcome: 'unsettled', tx: found?.tx ?? run.tx, error });
  }

  const result = await access.rail.pay({ account, lines, runId, ...(run.notBefore === null ? {} : { notBefore: run.notBefore }) });
  if (result.outcome === 'paid') return finish({ outcome: 'paid', tx: result.tx, error: null }, result.replayed);
  if (result.outcome === 'unknown') return finish({ outcome: 'unsettled', tx: result.tx, error: result.error ?? result.historyError });
  if (result.outcome === 'failed') return finish({ outcome: 'failed', tx: result.tx, error: result.error });
  return finish({ outcome: NOT_RULED_OUT.test(result.error ?? '') ? 'not_sent' : 'refused', tx: null, error: result.error });
}
