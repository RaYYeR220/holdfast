import type { OutgoingPayment } from '@holdfast/core';
import { isSwapFinal, type SwapRecord } from './records';

/**
 * A block's time is set by its miner, and Zcash nodes accept one up to two
 * hours away from their own clock. A deposit is therefore allowed to carry a
 * block time this much earlier than the swap's record, or later than its end.
 */
export const BLOCK_CLOCK_ALLOWANCE_MS = 2 * 3_600_000;

function byTimeThenId<T extends { id: string }>(time: (item: T) => number) {
  return (a: T, b: T) => time(a) - time(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function couldFund(out: OutgoingPayment, swap: SwapRecord): boolean {
  return (
    out.zat === swap.amountIn &&
    out.time >= swap.createdAt - BLOCK_CLOCK_ALLOWANCE_MS &&
    (!isSwapFinal(swap) || out.time <= swap.updatedAt + BLOCK_CLOCK_ALLOWANCE_MS)
  );
}

/**
 * Which treasury payment paid each swap's deposit: swap id to outgoing id.
 *
 * A viewing key does not show where a transparent payment went, only how much
 * left, so a deposit is recognised by its amount: it is a transparent payment
 * of exactly the swap's input, made after the swap existed and, once the swap
 * is over, before it ended. A payment pays for one swap at most. Payments the
 * swap service named as deposits are settled first; the rest go in order, the
 * earliest swap taking the earliest payment that fits.
 */
export function matchSwapFunding(swaps: readonly SwapRecord[], outgoing: readonly OutgoingPayment[]): Map<string, string> {
  const candidates = outgoing.filter((out) => out.pool === 'transparent').sort(byTimeThenId((out) => out.time));
  const inOrder = [...swaps].sort(byTimeThenId((swap) => swap.createdAt));
  const used = new Set<string>();
  const funding = new Map<string, string>();

  const settle = (pick: (swap: SwapRecord, fitting: OutgoingPayment[]) => OutgoingPayment | undefined) => {
    for (const swap of inOrder) {
      if (funding.has(swap.id)) continue;
      const match = pick(swap, candidates.filter((out) => !used.has(out.id) && couldFund(out, swap)));
      if (match === undefined) continue;
      used.add(match.id);
      funding.set(swap.id, match.id);
    }
  };
  settle((swap, fitting) => fitting.find((out) => swap.originTxs.includes(out.txid)));
  settle((_swap, fitting) => fitting[0]);
  return funding;
}
