import { isInstructionWithAccounts, isInstructionWithData, type Address, type ResolvedInstruction } from '@solana/kit';
import { getMemosFromInstructions } from '@solana-program/memo';
import {
  parseTransferCheckedInstruction,
  parseTransferInstruction,
  TOKEN_PROGRAM_ADDRESS,
  TRANSFER_CHECKED_DISCRIMINATOR,
  TRANSFER_DISCRIMINATOR,
} from '@solana-program/token';

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

/** A run and the team token account it is paid from. */
export interface RunIdentity {
  runId: string;
  /** The team's token account. */
  source: Address;
}

/** A line of a run somebody asks to be paid, with the payee's token account already derived. */
export interface RequestedLine {
  tokenAccount: Address;
  amount: bigint;
  /** Empty for a line without a memo. */
  memo: string;
}

/** A transfer of a paid run, reduced to what identifies it. */
export type PaidLine = Pick<RunTransfer, 'tokenAccount' | 'amount' | 'memo'>;

/**
 * Whether a run found on chain is the run being asked for: the same token
 * accounts and amounts in the same order. Memos are compared too unless the
 * run on chain carries none, which is what a run looks like when its line
 * memos did not fit.
 */
export function isSameRun(paid: readonly PaidLine[], lines: readonly RequestedLine[]): boolean {
  const carriesLineMemos = paid.some(transfer => transfer.memo !== null);
  return (
    paid.length === lines.length &&
    paid.every((transfer, index) => {
      const line = lines[index];
      return (
        line !== undefined &&
        transfer.tokenAccount === line.tokenAccount &&
        transfer.amount === line.amount &&
        (!carriesLineMemos || (transfer.memo ?? '') === line.memo)
      );
    })
  );
}

function transferOutOf(instruction: ResolvedInstruction, source: Address) {
  if (instruction.programAddress !== TOKEN_PROGRAM_ADDRESS) return null;
  if (!isInstructionWithData(instruction) || !isInstructionWithAccounts(instruction)) return null;
  const [kind] = instruction.data;
  if (kind === TRANSFER_CHECKED_DISCRIMINATOR && instruction.accounts.length >= 4) {
    const { accounts, data } = parseTransferCheckedInstruction(instruction);
    return accounts.source.address === source ? { tokenAccount: accounts.destination.address, amount: data.amount } : null;
  }
  if (kind === TRANSFER_DISCRIMINATOR && instruction.accounts.length >= 3) {
    const { accounts, data } = parseTransferInstruction(instruction);
    return accounts.source.address === source ? { tokenAccount: accounts.destination.address, amount: data.amount } : null;
  }
  return null;
}

/**
 * Read a run out of the instructions of a successful transaction. Returns
 * null when the run id is not its leading memo, and otherwise the transfers
 * out of the team's token account, each with the memo that directly follows
 * it.
 *
 * A memo alone proves nothing: anyone can send a transaction that mentions
 * the team's token account and carries any text. What cannot be forged is a
 * successful transfer out of that account, which takes the signature of its
 * owner or of its delegate. Whoever of the two signed, the run was paid.
 */
export function readRun(
  instructions: readonly ResolvedInstruction[],
  run: RunIdentity,
): { tokenAccount: Address; amount: bigint; memo: string | null }[] | null {
  const memos = new Map(getMemosFromInstructions(instructions).map(({ index, memo }) => [index, memo]));
  const [leadingMemo] = memos.values();
  if (leadingMemo !== run.runId) return null;
  return instructions.flatMap((instruction, index) => {
    const transfer = transferOutOf(instruction, run.source);
    return transfer ? [{ ...transfer, memo: memos.get(index + 1) ?? null }] : [];
  });
}
