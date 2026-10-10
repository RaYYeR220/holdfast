import { getTokenSize } from '@solana-program/token';
import type { SolanaRpc } from './connection';

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
  feeLamports: bigint;
}

export interface RentRates {
  /** Rent-exempt minimum of a token account. */
  tokenAccount: bigint;
  /** Rent-exempt minimum of an account without data, which is what the service key is. */
  wallet: bigint;
}

export async function fetchRentRates(rpc: SolanaRpc): Promise<RentRates> {
  const [tokenAccount, wallet] = await Promise.all([
    rpc.getMinimumBalanceForRentExemption(BigInt(getTokenSize())).send(),
    rpc.getMinimumBalanceForRentExemption(0n).send(),
  ]);
  return { tokenAccount, wallet };
}

export function payoutCost(newTokenAccounts: number, rates: RentRates): PayoutCost {
  return {
    newTokenAccounts,
    rentLamports: BigInt(newTokenAccounts) * rates.tokenAccount,
    feeLamports: SIGNATURE_FEE_LAMPORTS,
  };
}

/**
 * How many lamports the service key is short for a run, or 0 when it can pay.
 * The key has to keep its own rent-exempt minimum: a transaction that would
 * leave its fee payer with less, other than with nothing at all, is rejected
 * as `InsufficientFundsForRent`.
 */
export function lamportsShort(balance: bigint, cost: PayoutCost, rates: RentRates): bigint {
  const needed = cost.rentLamports + cost.feeLamports + rates.wallet;
  return needed > balance ? needed - balance : 0n;
}
