import { createNoopSigner, type Address, type TransactionSigner } from '@solana/kit';
import type { PayoutPlan } from '../src/payout';
import { addressOf } from './fake-node';

export const RUN_ID = 'HF-2026-10-0001';
export const DELEGATE: Address = addressOf(1);
export const SOURCE: Address = addressOf(2);
export const MINT: Address = addressOf(3);

export interface PlanLine {
  memo?: string;
  create?: boolean;
  amount?: bigint;
}

/** A payout plan whose payees are all distinct. Line `n` pays wallet `payeeOf(n)` at `tokenAccountOf(n)`. */
export function planOf(
  lines: readonly PlanLine[],
  options: { runId?: string; lineMemos?: boolean; delegate?: TransactionSigner } = {},
): PayoutPlan {
  return {
    delegate: options.delegate ?? createNoopSigner(DELEGATE),
    source: SOURCE,
    mint: MINT,
    decimals: 6,
    runId: options.runId ?? RUN_ID,
    lineMemos: options.lineMemos ?? true,
    transfers: lines.map((line, index) => ({
      payee: payeeOf(index),
      tokenAccount: tokenAccountOf(index),
      amount: line.amount ?? BigInt(index + 1) * 1_000_000n,
      memo: line.memo ?? '',
      createTokenAccount: line.create ?? false,
    })),
  };
}

export const payeeOf = (line: number): Address => addressOf(1_000 + line);
export const tokenAccountOf = (line: number): Address => addressOf(2_000 + line);
