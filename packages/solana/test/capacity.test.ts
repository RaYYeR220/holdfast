import { getTransactionMessageSize } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { estimatePayoutFit, maxPayoutLines, payoutTransactionSize, TRANSACTION_SIZE_LIMIT } from '../src/capacity';
import { MAX_MEMO_LENGTH } from '../src/memo';
import { payoutMessage, payoutShape } from '../src/payout';
import { planOf, RUN_ID, type PlanLine } from './fixtures';

const compiledSize = (plan: ReturnType<typeof planOf>): number => getTransactionMessageSize(payoutMessage(plan));

describe('payoutTransactionSize', () => {
  it('matches the size of the compiled transaction byte for byte', () => {
    const creations: ((line: number) => boolean)[] = [() => true, () => false, line => line % 2 === 0];
    // 19 lines is the most a transaction holds; beyond 64 instructions kit will not compile at all.
    for (const lineCount of [1, 2, 5, 9, 13, 19]) {
      for (const create of creations) {
        for (const memoLength of [0, 16, MAX_MEMO_LENGTH]) {
          for (const runId of ['r', RUN_ID, 'r'.repeat(MAX_MEMO_LENGTH)]) {
            const lines: PlanLine[] = Array.from({ length: lineCount }, (_, line) => ({
              memo: 'm'.repeat(memoLength),
              create: create(line),
            }));
            const plan = planOf(lines, { runId });
            expect(payoutTransactionSize(payoutShape(plan)), `${lineCount} lines, memo ${memoLength}`).toBe(
              compiledSize(plan),
            );
          }
        }
      }
    }
  });

  it('agrees with the three-line run measured on chain', () => {
    const shape = {
      runIdBytes: RUN_ID.length,
      lines: [24, 26, 20].map(memoBytes => ({ memoBytes, createsTokenAccount: true })),
    };
    expect(payoutTransactionSize(shape)).toBe(698);
  });

  it('counts a memo only when line memos are carried', () => {
    const lines = [{ memo: 'INV-1041' }, { memo: 'INV-1042' }];
    const withMemos = planOf(lines, { lineMemos: true });
    const without = planOf(lines, { lineMemos: false });
    expect(payoutTransactionSize(payoutShape(withMemos)) - payoutTransactionSize(payoutShape(without))).toBe(
      2 * (3 + 'INV-1041'.length),
    );
    expect(payoutTransactionSize(payoutShape(without))).toBe(compiledSize(without));
  });

  it('is an upper bound when a payee is paid twice', () => {
    const plan = planOf([{ create: true }, { create: false }]);
    const [first, second] = plan.transfers;
    if (!first || !second) throw new Error('fixture has two lines');
    const twice = { ...plan, transfers: [first, { ...second, payee: first.payee, tokenAccount: first.tokenAccount }] };
    expect(compiledSize(twice)).toBeLessThan(payoutTransactionSize(payoutShape(twice)));
  });
});

describe('estimatePayoutFit', () => {
  it('reports the size against the 1232 byte limit', () => {
    const fit = estimatePayoutFit({ lines: 19, runIdBytes: RUN_ID.length, newTokenAccounts: 0 });
    expect(fit).toEqual({ size: 1213, limit: TRANSACTION_SIZE_LIMIT, fits: true });
    expect(estimatePayoutFit({ lines: 20, runIdBytes: RUN_ID.length, newTokenAccounts: 0 }).fits).toBe(false);
  });

  it('assumes every payee needs a token account unless told otherwise', () => {
    const worst = estimatePayoutFit({ lines: 6, runIdBytes: RUN_ID.length });
    const explicit = estimatePayoutFit({ lines: 6, runIdBytes: RUN_ID.length, newTokenAccounts: 6 });
    const none = estimatePayoutFit({ lines: 6, runIdBytes: RUN_ID.length, newTokenAccounts: 0 });
    expect(worst).toEqual(explicit);
    expect(worst.size - none.size).toBe(2 * 32 + 6 * (32 + 10));
  });
});

describe('maxPayoutLines', () => {
  const runIdBytes = RUN_ID.length;

  it('fits 19 payees that already have token accounts', () => {
    expect(maxPayoutLines({ runIdBytes, newTokenAccounts: false })).toBe(19);
  });

  it('fits 9 payees that all need a token account', () => {
    expect(maxPayoutLines({ runIdBytes })).toBe(9);
  });

  it('gives up lines to line memos', () => {
    expect(maxPayoutLines({ runIdBytes, lineMemoBytes: 16, newTokenAccounts: false })).toBe(13);
    expect(maxPayoutLines({ runIdBytes, lineMemoBytes: 16 })).toBe(8);
  });

  it('still carries five payees when everything is at its worst', () => {
    expect(maxPayoutLines({ runIdBytes: MAX_MEMO_LENGTH, lineMemoBytes: MAX_MEMO_LENGTH })).toBe(5);
  });
});
