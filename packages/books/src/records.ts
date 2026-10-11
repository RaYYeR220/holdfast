import type { Zat } from '@holdfast/core';

/**
 * The plain records the books are built from. Each mirrors what an adapter or
 * the database already produces, so rows can be passed in as they are.
 */

/** A fee the treasury paid. The scanner knows the transaction; the database row adds the height. */
export interface FeeRecord {
  txid: string;
  zat: Zat;
  height?: number | null;
  /** Block time, ms, when the caller has it; otherwise taken from the transaction's other records. */
  time?: number | null;
}

/** One fill on the hedge venue, as `@holdfast/hyperliquid` returns it. */
export interface HedgeFill {
  time: number;
  coin: string;
  side: 'buy' | 'sell';
  /** The venue's own label, e.g. "Open Short". */
  direction: string;
  size: number;
  px: number;
  /** Negative when the fill earned a rebate. */
  fee: number;
  feeToken: string;
  closedPnlUsd: number;
  oid: string;
  cloid: string | null;
  /** Trade id, unique per fill. */
  tid: string;
  /** Transaction hash on the venue's chain, when the adapter keeps it. */
  hash?: string | null;
}

export interface FundingPayment {
  time: number;
  coin: string;
  /** Dollars credited to the account; negative when the account paid. */
  usd: number;
  size: number;
  fundingRate: number;
}

/** A row of the swaps table, without the stored quote. */
export interface SwapRecord {
  id: string;
  purpose: string;
  originAsset: string;
  destinationAsset: string;
  amountIn: bigint;
  minAmountOut: bigint;
  amountOut: bigint | null;
  depositAddress: string;
  recipient: string;
  state: string;
  originTxs: string[];
  destinationTxs: string[];
  createdAt: number;
  updatedAt: number;
}

export const SWAP_SUCCESS = 'SUCCESS';
const SWAP_FINAL_STATES = [SWAP_SUCCESS, 'REFUNDED', 'FAILED'];
const SWAP_DEPOSITED_STATES = ['PROCESSING', SWAP_SUCCESS, 'REFUNDED', 'INCOMPLETE_DEPOSIT'];

/** True once the swap can no longer change state. */
export function isSwapFinal(swap: Pick<SwapRecord, 'state'>): boolean {
  return SWAP_FINAL_STATES.includes(swap.state);
}

/** Whether the swap service has seen money arrive at the deposit address. */
export function swapSawDeposit(swap: Pick<SwapRecord, 'state' | 'originTxs' | 'amountOut'>): boolean {
  return swap.originTxs.length > 0 || swap.amountOut !== null || SWAP_DEPOSITED_STATES.includes(swap.state);
}

export interface PayoutLineRecord {
  lineNo: number;
  payeeName: string;
  toAddress: string;
  /** Token base units. */
  amount: bigint;
  memo: string;
  tx: string | null;
  logIndex: number | null;
}

export type PayoutChain = 'tempo' | 'solana';

/** A payout run with its lines, as the database holds it. */
export interface PayoutRunRecord {
  id: string;
  chain: PayoutChain;
  /** Token contract or mint the run pays in. */
  token: string;
  status: string;
  total: bigint;
  tx: string | null;
  createdAt: number;
  executedAt: number | null;
  lines: PayoutLineRecord[];
}

export const PAYOUT_PAID = 'paid';
