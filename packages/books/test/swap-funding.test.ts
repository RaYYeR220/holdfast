import type { OutgoingPayment } from '@holdfast/core';
import { describe, expect, it } from 'vitest';
import { BLOCK_CLOCK_ALLOWANCE_MS, matchSwapFunding, type SwapRecord } from '../src/index';
import { deposit, marginSwap } from './fixtures';

const MINUTE = 60_000;
const swap = (over: Partial<SwapRecord>): SwapRecord => ({ ...marginSwap, originTxs: [], ...over });
const payment = (over: Partial<OutgoingPayment>): OutgoingPayment => ({ ...deposit, ...over });

describe('matching swaps to the payments that funded them', () => {
  it('pairs a swap with the transparent payment of its amount', () => {
    expect(matchSwapFunding([marginSwap], [deposit])).toEqual(new Map([[marginSwap.id, deposit.id]]));
  });

  it('wants the amount to the zatoshi', () => {
    expect(matchSwapFunding([marginSwap], [payment({ zat: 930_001n })]).size).toBe(0);
  });

  it('does not take a shielded payment for a deposit', () => {
    expect(matchSwapFunding([marginSwap], [payment({ pool: 'orchard' })]).size).toBe(0);
  });

  it('does not take a payment made before the swap existed', () => {
    const early = payment({ time: marginSwap.createdAt - BLOCK_CLOCK_ALLOWANCE_MS - MINUTE });
    expect(matchSwapFunding([marginSwap], [early]).size).toBe(0);
  });

  it('allows for a block clock that runs behind', () => {
    const behind = payment({ time: marginSwap.createdAt - 5 * MINUTE });
    expect(matchSwapFunding([marginSwap], [behind]).size).toBe(1);
  });

  it('does not take a payment made after the swap had ended', () => {
    const late = payment({ time: marginSwap.updatedAt + BLOCK_CLOCK_ALLOWANCE_MS + MINUTE });
    expect(matchSwapFunding([marginSwap], [late]).size).toBe(0);
    const open = swap({ state: 'PROCESSING', amountOut: null });
    expect(matchSwapFunding([open], [late]).size).toBe(1);
  });

  it('uses each payment once, giving the earlier swap the earlier payment', () => {
    const first = swap({ id: 'swap-a', createdAt: marginSwap.createdAt });
    const second = swap({ id: 'swap-b', createdAt: marginSwap.createdAt + MINUTE, updatedAt: marginSwap.updatedAt + 30 * MINUTE });
    const one = payment({ id: 'out-1', txid: 'tx-1', time: marginSwap.createdAt + 2 * MINUTE });
    const two = payment({ id: 'out-2', txid: 'tx-2', time: marginSwap.createdAt + 3 * MINUTE });

    expect(matchSwapFunding([second, first], [two, one])).toEqual(
      new Map([
        ['swap-a', 'out-1'],
        ['swap-b', 'out-2'],
      ]),
    );
    expect(matchSwapFunding([second, first], [one])).toEqual(new Map([['swap-a', 'out-1']]));
  });

  it('leaves a named deposit to the swap that named it', () => {
    const first = swap({ id: 'swap-a' });
    const second = swap({ id: 'swap-b', createdAt: marginSwap.createdAt + MINUTE, originTxs: ['tx-1'] });
    const one = payment({ id: 'out-1', txid: 'tx-1', time: marginSwap.createdAt + 2 * MINUTE });
    const two = payment({ id: 'out-2', txid: 'tx-2', time: marginSwap.createdAt + 3 * MINUTE });
    const funding = matchSwapFunding([first, second], [one, two]);
    expect([...funding].sort()).toEqual([
      ['swap-a', 'out-2'],
      ['swap-b', 'out-1'],
    ]);
  });

  it('prefers the payment the swap service named as the deposit', () => {
    const one = payment({ id: 'out-1', txid: 'tx-1', time: marginSwap.createdAt + 2 * MINUTE });
    const two = payment({ id: 'out-2', txid: 'tx-2', time: marginSwap.createdAt + 3 * MINUTE });
    expect(matchSwapFunding([swap({ originTxs: ['tx-2'] })], [one, two])).toEqual(new Map([[marginSwap.id, 'out-2']]));
  });
});
