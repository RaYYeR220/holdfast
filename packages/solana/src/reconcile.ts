import {
  decodeTransactionFromRpcResponse,
  getAccountMetasFromCompiledTransactionMessage,
  getInstructionsFromCompiledTransactionMessage,
  isInstructionWithAccounts,
  isInstructionWithData,
  MAX_SUPPORTED_TRANSACTION_VERSION,
  type Address,
  type ResolvedInstruction,
  type Signature,
} from '@solana/kit';
import { getMemosFromInstructions } from '@solana-program/memo';
import {
  parseTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
  TRANSFER_CHECKED_DISCRIMINATOR,
} from '@solana-program/token';
import type { SettledCommitment, SolanaRpc } from './connection';
import { parseSignatureMemos } from './memo';

export interface RunTransfer {
  /** The payee's wallet. */
  to: string;
  /** The payee's token account that was credited. */
  tokenAccount: string;
  /** Token base units. */
  amount: bigint;
  /** The line's memo, or null when the run carried only its run memo. */
  memo: string | null;
}

export interface PayoutRun {
  runId: string;
  signature: string;
  slot: bigint;
  /** Block time, ms; null while the node has not recorded one. */
  time: number | null;
  /** Sum of the transfers, token base units. */
  total: bigint;
  transfers: RunTransfer[];
}

/** What makes a transaction one of this rail's runs for a given team account. */
export interface RunIdentity {
  runId: string;
  /** The team's token account. */
  source: Address;
  mint: Address;
  delegate: Address;
}

const SIGNATURE_PAGE = 1_000;
const MAX_SIGNATURE_PAGES = 10;

function delegateTransfer(instruction: ResolvedInstruction, run: RunIdentity) {
  if (instruction.programAddress !== TOKEN_PROGRAM_ADDRESS) return null;
  if (!isInstructionWithData(instruction) || !isInstructionWithAccounts(instruction)) return null;
  if (instruction.data[0] !== TRANSFER_CHECKED_DISCRIMINATOR || instruction.accounts.length < 4) return null;
  const { accounts, data } = parseTransferCheckedInstruction(instruction);
  const ours =
    accounts.source.address === run.source &&
    accounts.mint.address === run.mint &&
    accounts.authority.address === run.delegate;
  return ours ? { tokenAccount: accounts.destination.address, amount: data.amount } : null;
}

/**
 * Read a run out of the instructions of a successful transaction, or return
 * null when it is not that run.
 *
 * A memo alone proves nothing: anyone can send a transaction that mentions
 * the team's token account and carries any text. What cannot be forged is a
 * transfer out of that account under the delegate's authority, so only those
 * transfers are reported, and only when the run id is the leading memo.
 */
export function readRun(
  instructions: readonly ResolvedInstruction[],
  run: RunIdentity,
): { tokenAccount: Address; amount: bigint; memo: string | null }[] | null {
  const memos = new Map(getMemosFromInstructions(instructions).map(({ index, memo }) => [index, memo]));
  const [leadingMemo] = memos.values();
  if (leadingMemo !== run.runId) return null;
  const transfers = instructions.flatMap((instruction, index) => {
    const transfer = delegateTransfer(instruction, run);
    return transfer ? [{ ...transfer, memo: memos.get(index + 1) ?? null }] : [];
  });
  return transfers.length > 0 ? transfers : null;
}

async function fetchRun(
  rpc: SolanaRpc,
  signature: Signature,
  run: RunIdentity,
  commitment: SettledCommitment,
): Promise<PayoutRun | null> {
  const response = await rpc
    .getTransaction(signature, {
      commitment,
      encoding: 'base64',
      maxSupportedTransactionVersion: MAX_SUPPORTED_TRANSACTION_VERSION,
    })
    .send();
  if (!response?.meta || response.meta.err !== null) return null;

  const { compiledMessage, loadedAddresses } = decodeTransactionFromRpcResponse(response);
  const transfers = readRun(getInstructionsFromCompiledTransactionMessage(compiledMessage, loadedAddresses), run);
  if (!transfers) return null;

  // The instruction names the credited token account; the wallet behind it is
  // only recorded in the transaction's token balance metadata.
  const accounts = getAccountMetasFromCompiledTransactionMessage(compiledMessage, loadedAddresses);
  const walletOf = new Map<Address, Address>();
  for (const balance of response.meta.postTokenBalances ?? []) {
    const tokenAccount = accounts[balance.accountIndex]?.address;
    if (tokenAccount && balance.owner) walletOf.set(tokenAccount, balance.owner);
  }

  return {
    runId: run.runId,
    signature,
    slot: response.slot,
    time: response.blockTime === null ? null : Number(response.blockTime) * 1_000,
    total: transfers.reduce((sum, transfer) => sum + transfer.amount, 0n),
    transfers: transfers.map(transfer => {
      const to = walletOf.get(transfer.tokenAccount);
      if (!to) throw new Error(`transaction ${signature} has no token balance record for ${transfer.tokenAccount}`);
      return { to, tokenAccount: transfer.tokenAccount, amount: transfer.amount, memo: transfer.memo };
    }),
  };
}

/**
 * Locate a run by its memo in the history of the team's token account.
 * `getSignaturesForAddress` returns each transaction's memos, so candidates
 * are found without fetching every transaction; each candidate is then read
 * in full and checked against {@link readRun}. Failed transactions keep their
 * memos in that history and are skipped.
 *
 * Looks at the 10,000 most recent transactions of the account.
 */
export async function findRunOnChain(
  rpc: SolanaRpc,
  run: RunIdentity,
  commitment: SettledCommitment,
): Promise<PayoutRun | null> {
  let before: Signature | undefined;
  for (let page = 0; page < MAX_SIGNATURE_PAGES; page++) {
    const entries = await rpc
      .getSignaturesForAddress(run.source, { commitment, limit: SIGNATURE_PAGE, ...(before ? { before } : {}) })
      .send();
    for (const entry of entries) {
      if (entry.err !== null || parseSignatureMemos(entry.memo)[0] !== run.runId) continue;
      const found = await fetchRun(rpc, entry.signature, run, commitment);
      if (found) return found;
    }
    before = entries.at(-1)?.signature;
    if (entries.length < SIGNATURE_PAGE || !before) return null;
  }
  return null;
}
