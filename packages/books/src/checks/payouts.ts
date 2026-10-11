import type { LedgerEntry } from '../entry';
import type { OnChainRun, OnChainTransfer, PayoutEvidence } from '../evidence';
import { entryId, uniqueBy } from '../ids';
import { type Findings, runRef } from '../problems';
import { PAYOUT_PAID, type PayoutChain, type PayoutLineRecord, type PayoutRunRecord } from '../records';

/** Tempo addresses and hashes are hex and compare without case; Solana's are base58 and do not. */
function sameId(chain: PayoutChain, a: string, b: string): boolean {
  return chain === 'tempo' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function paidTo(chain: PayoutChain, line: PayoutLineRecord, transfer: OnChainTransfer): boolean {
  if (sameId(chain, line.toAddress, transfer.to)) return true;
  return transfer.tokenAccount !== null && sameId(chain, line.toAddress, transfer.tokenAccount);
}

/** Compare a line with the transfer taken to be its payment. */
function compare(run: PayoutRunRecord, onChain: OnChainRun, line: PayoutLineRecord, transfer: OnChainTransfer, out: Findings): void {
  const ref = entryId.payout(run.id, line.lineNo);
  const amountOk = transfer.amount === line.amount;
  const recipientOk = paidTo(run.chain, line, transfer);
  if (!amountOk) {
    out.error('wrong_amount', `line ${line.lineNo} of run ${run.id} is ${line.amount} but ${transfer.amount} was transferred`, ref, onChain.tx);
  }
  if (!recipientOk) {
    out.error('wrong_recipient', `line ${line.lineNo} of run ${run.id} is for ${line.toAddress} but ${transfer.to} was paid`, ref, onChain.tx);
  }
  if (amountOk && recipientOk) out.match('payout_line', ref, onChain.tx);
}

/**
 * Pair every line of a paid run with one transfer.
 *
 * The memo decides wherever the chain carries one: a memo found once on each
 * side is a pair, and a memo found more than once on either side pairs with
 * nothing. Transfers without a memo of their own — a Solana run whose line
 * memos did not fit — can only be told apart by payee and amount, so those
 * are paired that way and the run is marked as not provable by memo.
 */
function matchLines(run: PayoutRunRecord, onChain: OnChainRun, out: Findings): void {
  const lines = [...run.lines].sort((a, b) => a.lineNo - b.lineNo);
  const transfers = onChain.transfers;
  const openLines = new Set(lines);
  const openTransfers = new Set(transfers);

  const memos = new Set([...lines.map((l) => l.memo), ...transfers.map((t) => t.memo ?? '')]);
  memos.delete('');
  for (const memo of memos) {
    const withMemo = lines.filter((l) => l.memo === memo);
    const carrying = transfers.filter((t) => t.memo === memo);
    if (withMemo.length > 1 || carrying.length > 1) {
      const refs = withMemo.map((l) => entryId.payout(run.id, l.lineNo));
      out.error('duplicate_memo', `memo "${memo}" is on ${withMemo.length} line(s) and ${carrying.length} transfer(s) of run ${run.id}`, ...refs, onChain.tx);
      for (const l of withMemo) openLines.delete(l);
      for (const t of carrying) openTransfers.delete(t);
      continue;
    }
    const [line] = withMemo;
    const [transfer] = carrying;
    if (line === undefined || transfer === undefined) continue;
    compare(run, onChain, line, transfer, out);
    openLines.delete(line);
    openTransfers.delete(transfer);
  }

  const unlabelled = [...openTransfers].filter((t) => t.memo === null || t.memo === '');
  let pairedWithoutMemo = false;
  const pair = (line: PayoutLineRecord, transfer: OnChainTransfer) => {
    compare(run, onChain, line, transfer, out);
    pairedWithoutMemo ||= line.memo !== '';
    openLines.delete(line);
    openTransfers.delete(transfer);
    unlabelled.splice(unlabelled.indexOf(transfer), 1);
  };
  for (const line of [...openLines]) {
    const exact = unlabelled.find((t) => t.amount === line.amount && paidTo(run.chain, line, t));
    if (exact !== undefined) pair(line, exact);
  }
  for (const line of [...openLines]) {
    const [next] = unlabelled;
    if (next !== undefined) pair(line, next);
  }
  if (pairedWithoutMemo) {
    out.warn('memo_not_on_chain', `run ${run.id} carries no line memos on chain; its lines were matched by payee and amount`, runRef(run.id), onChain.tx);
  }

  for (const line of openLines) {
    out.error('missing_transfer', `line ${line.lineNo} of run ${run.id} (${line.memo}) has no transfer in ${onChain.tx}`, entryId.payout(run.id, line.lineNo), onChain.tx);
  }
  for (const transfer of openTransfers) {
    const label = transfer.memo === null || transfer.memo === '' ? 'without a memo' : `with memo "${transfer.memo}"`;
    out.error('unexpected_transfer', `${onChain.tx} pays ${transfer.amount} to ${transfer.to} ${label}, which no line of run ${run.id} asks for`, runRef(run.id), onChain.tx);
  }
}

function checkRun({ run, onChain }: PayoutEvidence, out: Findings): void {
  const total = run.lines.reduce((sum, line) => sum + line.amount, 0n);
  if (total !== run.total) {
    out.error('run_total_mismatch', `run ${run.id} records a total of ${run.total} but its lines add up to ${total}`, runRef(run.id));
  }

  if (run.status !== PAYOUT_PAID) {
    if (onChain !== null) {
      const detail = `run ${run.id} is "${run.status}" in the database but ${onChain.tx} paid it on chain`;
      // A run being sent is expected to land; any other status says no money moved.
      if (run.status === 'sending') out.warn('run_status_mismatch', detail, runRef(run.id), onChain.tx);
      else out.error('run_status_mismatch', detail, runRef(run.id), onChain.tx);
    } else if (run.status === 'sending') {
      out.warn('run_unsettled', `run ${run.id} was sent and is not on chain yet`, runRef(run.id));
    }
    return;
  }

  if (onChain === null) {
    for (const line of run.lines) {
      out.error('missing_transfer', `line ${line.lineNo} of run ${run.id} (${line.memo}) is marked paid but the run was not found on chain`, entryId.payout(run.id, line.lineNo));
    }
    return;
  }
  if (run.tx !== null && !sameId(run.chain, run.tx, onChain.tx)) {
    out.error('run_tx_mismatch', `run ${run.id} records ${run.tx} but was found on chain in ${onChain.tx}`, runRef(run.id), run.tx, onChain.tx);
  }
  if (onChain.otherTxs.length > 0) {
    out.error('duplicate_memo', `memos of run ${run.id} also appear in ${onChain.otherTxs.join(', ')}: lines were paid more than once`, runRef(run.id), ...onChain.otherTxs);
  }
  matchLines(run, onChain, out);
}

/** The ledger must hold exactly the lines of the paid runs, with their amounts, memos and payees. */
function checkLedger(runs: readonly PayoutRunRecord[], ledger: readonly LedgerEntry[], out: Findings): void {
  const entries = new Map(ledger.filter((entry) => entry.kind === 'payout').map((entry) => [entry.id, entry]));

  for (const run of runs) {
    if (run.status !== PAYOUT_PAID) continue;
    for (const line of run.lines) {
      const id = entryId.payout(run.id, line.lineNo);
      const entry = entries.get(id);
      entries.delete(id);
      if (entry === undefined) {
        out.error('payout_ledger_mismatch', `line ${line.lineNo} of run ${run.id} is paid but is not in the ledger`, id);
      } else if (entry.amount !== -line.amount || entry.ref !== line.memo || entry.counterparty?.address !== line.toAddress) {
        out.error('payout_ledger_mismatch', `the ledger entry for line ${line.lineNo} of run ${run.id} differs from the line`, id);
      }
    }
  }
  for (const id of entries.keys()) {
    out.error('payout_ledger_mismatch', `ledger entry ${id} has no paid payout line behind it`, id);
  }
}

/** Each payout line against exactly one transfer on chain with the same memo, amount and payee. */
export function checkPayouts(payouts: readonly PayoutEvidence[], ledger: readonly LedgerEntry[], out: Findings): void {
  const evidence = uniqueBy(payouts, (p) => p.run.id);
  for (const item of evidence) checkRun(item, out);
  checkLedger(evidence.map((p) => p.run), ledger, out);
}
