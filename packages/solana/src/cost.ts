import { getTokenSize } from '@solana-program/token';
import type { SolanaRpc } from './connection';
import { MARKER_SPACE } from './marker';

/** What the fee payer is charged per signature. A payout run carries one. */
export const SIGNATURE_FEE_LAMPORTS = 5_000n;

/** The SOL a run takes out of the service key, in lamports. */
export interface PayoutCost {
  /** Payee token accounts the run creates. */
  newTokenAccounts: number;
  /**
   * Rent deposited into those accounts. It is not a fee: it stays in the
   * payee's token account, and the payee gets it by closing the account.
   */
  rentLamports: bigint;
  /**
   * Rent of the run marker, which is never recovered: the marker stays on
   * chain for good. It is the rent-exempt minimum of a one-byte account,
   * 897,840 lamports at the rate Solana launched with and 655,320 on devnet
   * when this was written; the rail asks the node. Less when somebody has
   * already sent lamports to the marker's address, and then at least 1.
   */
  markerLamports: bigint;
  feeLamports: bigint;
}

/** What a transaction that failed on chain took from its fee payer: the fee, everything else being undone. */
export const COST_OF_FAILED_TRANSACTION: PayoutCost = {
  newTokenAccounts: 0,
  rentLamports: 0n,
  markerLamports: 0n,
  feeLamports: SIGNATURE_FEE_LAMPORTS,
};

export interface RentRates {
  /** Rent-exempt minimum of a token account. */
  tokenAccount: bigint;
  /** Rent-exempt minimum of a run marker. */
  marker: bigint;
  /** Rent-exempt minimum of an account without data, which is what the service key is. */
  wallet: bigint;
}

export async function fetchRentRates(rpc: SolanaRpc): Promise<RentRates> {
  const [tokenAccount, marker, wallet] = await Promise.all([
    rpc.getMinimumBalanceForRentExemption(BigInt(getTokenSize())).send(),
    rpc.getMinimumBalanceForRentExemption(BigInt(MARKER_SPACE)).send(),
    rpc.getMinimumBalanceForRentExemption(0n).send(),
  ]);
  return { tokenAccount, marker, wallet };
}

export function payoutCost(newTokenAccounts: number, markerLamports: bigint, rates: RentRates): PayoutCost {
  return {
    newTokenAccounts,
    rentLamports: BigInt(newTokenAccounts) * rates.tokenAccount,
    markerLamports,
    feeLamports: SIGNATURE_FEE_LAMPORTS,
  };
}

/** Everything a run takes out of the service key. */
export function totalLamports(cost: PayoutCost): bigint {
  return cost.rentLamports + cost.markerLamports + cost.feeLamports;
}

/**
 * How many lamports the service key is short for a run, or 0 when it can pay.
 * The key has to keep its own rent-exempt minimum: a transaction that would
 * leave its fee payer with less, other than with nothing at all, is rejected
 * as `InsufficientFundsForRent`.
 */
export function lamportsShort(balance: bigint, cost: PayoutCost, rates: RentRates): bigint {
  const needed = totalLamports(cost) + rates.wallet;
  return needed > balance ? needed - balance : 0n;
}
