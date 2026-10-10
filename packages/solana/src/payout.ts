import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getTransactionMessageSize,
  isSolanaError,
  pipe,
  setTransactionMessageFeePayerSigner,
  type Address,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit';
import { getAddMemoInstruction, LEGACY_MEMO_PROGRAM_ADDRESS_V3 } from '@solana-program/memo';
import {
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from '@solana-program/token';
import { TRANSACTION_SIZE_LIMIT, type PayoutShape } from './capacity';

export interface PayoutTransfer {
  /** The payee's wallet. */
  payee: Address;
  /** The payee's associated token account, where the tokens land. */
  tokenAccount: Address;
  amount: bigint;
  /** Empty for a line without a memo. */
  memo: string;
  /** Create the payee's token account first. The delegate pays its rent. */
  createTokenAccount: boolean;
}

export interface PayoutPlan {
  /** The service key: transfer authority and fee payer. */
  delegate: TransactionSigner;
  /** The team's token account the delegate was approved on. */
  source: Address;
  mint: Address;
  decimals: number;
  runId: string;
  transfers: readonly PayoutTransfer[];
  /** Carry each line's memo, or only the run memo when they do not fit. */
  lineMemos: boolean;
}

/**
 * Memos are written with the long-standing Memo program
 * (MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr) rather than its newer
 * replacement. Finding a run again depends on RPC nodes indexing its memo.
 * Every node indexes this program, while an Agave 3.1 node still answers
 * `memo: null` for a memo written through the newer one. This program is
 * also immutable.
 */
export const PAYOUT_MEMO_PROGRAM_ADDRESS = LEGACY_MEMO_PROGRAM_ADDRESS_V3;

function memoInstruction(memo: string): Instruction {
  return getAddMemoInstruction({ memo }, { programAddress: PAYOUT_MEMO_PROGRAM_ADDRESS });
}

/**
 * Instructions of a payout run, in the order they go on chain:
 *
 *   1. Memo: the run id
 *   2. for each line, in the order given:
 *        CreateAssociatedTokenIdempotent   only if the payee has no token account yet
 *        TransferChecked                   source to payee, authority = the delegate
 *        Memo: the line's memo             only if line memos are carried
 *
 * The run memo leads so that it is the first entry of the memo string RPC
 * nodes index per transaction. A line memo directly follows its transfer,
 * which is how the two are paired again when a run is read back.
 */
export function payoutInstructions(plan: PayoutPlan): Instruction[] {
  const instructions: Instruction[] = [memoInstruction(plan.runId)];
  for (const transfer of plan.transfers) {
    if (transfer.createTokenAccount) {
      instructions.push(
        getCreateAssociatedTokenIdempotentInstruction({
          payer: plan.delegate,
          ata: transfer.tokenAccount,
          owner: transfer.payee,
          mint: plan.mint,
        }),
      );
    }
    instructions.push(
      getTransferCheckedInstruction({
        source: plan.source,
        mint: plan.mint,
        destination: transfer.tokenAccount,
        authority: plan.delegate,
        amount: transfer.amount,
        decimals: plan.decimals,
      }),
    );
    if (plan.lineMemos && transfer.memo !== '') instructions.push(memoInstruction(transfer.memo));
  }
  return instructions;
}

/** A v0 message for the run with the delegate as fee payer; it still needs a blockhash. */
export function payoutMessage(plan: PayoutPlan) {
  return pipe(
    createTransactionMessage({ version: 0 }),
    message => setTransactionMessageFeePayerSigner(plan.delegate, message),
    message => appendTransactionMessageInstructions(payoutInstructions(plan), message),
  );
}

/**
 * Measured on the compiled message, so a payee paid twice is counted once.
 * Kit refuses to compile what no transaction can hold at all, such as more
 * than 64 instructions; that is one more way of not fitting.
 */
export function fitsOneTransaction(plan: PayoutPlan): boolean {
  try {
    return getTransactionMessageSize(payoutMessage(plan)) <= TRANSACTION_SIZE_LIMIT;
  } catch (error) {
    if (isSolanaError(error)) return false;
    throw error;
  }
}

/** The plan as the size arithmetic in capacity.ts sees it. */
export function payoutShape(plan: PayoutPlan): PayoutShape {
  return {
    runIdBytes: plan.runId.length,
    lines: plan.transfers.map(transfer => ({
      memoBytes: plan.lineMemos ? transfer.memo.length : 0,
      createsTokenAccount: transfer.createTokenAccount,
    })),
  };
}
