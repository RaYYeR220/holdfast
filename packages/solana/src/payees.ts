import type { PayoutLine } from '@holdfast/core';
import { fetchEncodedAccounts, isAddress, type Address } from '@solana/kit';
import { associatedTokenAddress, isOwnedByTokenProgram } from './accounts';
import { MAX_TOKEN_AMOUNT } from './amounts';
import type { SettledCommitment, SolanaRpc } from './connection';
import { validateMemo } from './memo';
import type { PayoutTransfer } from './payout';
import type { RequestedLine } from './reconcile';

/** A payout line whose payee has been checked and whose token account has been derived. */
export interface Payee extends RequestedLine {
  wallet: Address;
}

/**
 * Check a run without talking to the node and derive where each line pays.
 * Returns what is wrong with the run when it cannot be paid as written.
 */
export async function identifyPayees(
  lines: readonly PayoutLine[],
  runId: string,
  mint: Address,
  source: Address,
): Promise<Payee[] | string> {
  const runIdProblem = validateMemo(runId);
  if (runIdProblem) return `run id: ${runIdProblem}`;
  if (lines.length === 0) return 'run has no lines';

  const payees: Payee[] = [];
  for (const [index, line] of lines.entries()) {
    const at = `line ${index + 1}`;
    if (line.amount <= 0n || line.amount > MAX_TOKEN_AMOUNT) return `${at}: invalid amount ${line.amount}`;
    const memoProblem = line.memo === '' ? null : validateMemo(line.memo);
    if (memoProblem) return `${at}: ${memoProblem}`;
    if (!isAddress(line.to)) return `${at}: "${line.to}" is not a Solana address`;
    const tokenAccount = await associatedTokenAddress(line.to, mint);
    if (tokenAccount === source) return `${at}: the payee is the paying account itself`;
    payees.push({ wallet: line.to, tokenAccount, amount: line.amount, memo: line.memo });
  }
  return payees;
}

/**
 * Look the payees up on chain and turn them into transfers, marking the
 * token accounts that still have to be created.
 */
export async function resolveTransfers(
  rpc: SolanaRpc,
  commitment: SettledCommitment,
  payees: readonly Payee[],
): Promise<PayoutTransfer[] | string> {
  const [wallets, tokenAccounts] = await Promise.all([
    fetchEncodedAccounts(rpc, payees.map(payee => payee.wallet), { commitment }),
    fetchEncodedAccounts(rpc, payees.map(payee => payee.tokenAccount), { commitment }),
  ]);

  const created = new Set<Address>();
  const transfers: PayoutTransfer[] = [];
  for (const [index, { wallet, tokenAccount, amount, memo }] of payees.entries()) {
    // An address that is itself a token account or a mint could never
    // spend from a token account opened in its name.
    if (isOwnedByTokenProgram(wallets[index])) {
      return `line ${index + 1}: ${wallet} is a token account or mint, not a wallet`;
    }
    const missing = !isOwnedByTokenProgram(tokenAccounts[index]);
    transfers.push({ payee: wallet, tokenAccount, amount, memo, createTokenAccount: missing && !created.has(tokenAccount) });
    if (missing) created.add(tokenAccount);
  }
  return transfers;
}

export function isSameRequest(a: readonly RequestedLine[], b: readonly RequestedLine[]): boolean {
  return (
    a.length === b.length &&
    a.every((line, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        line.tokenAccount === other.tokenAccount &&
        line.amount === other.amount &&
        line.memo === other.memo
      );
    })
  );
}
