import { address, fetchEncodedAccount, isSome, type Address, type MaybeEncodedAccount } from '@solana/kit';
import {
  decodeToken,
  findAssociatedTokenPda,
  getTokenSize,
  TOKEN_PROGRAM_ADDRESS,
  type Token,
} from '@solana-program/token';
import type { SettledCommitment, SolanaRpc } from './connection';

/**
 * The associated token account of `owner` for `mint` under the original
 * Token program. The address is derived, not looked up: it is the same
 * whether or not the account has been created yet.
 */
export async function associatedTokenAddress(owner: string, mint: string): Promise<Address> {
  const [tokenAccount] = await findAssociatedTokenPda({
    owner: address(owner),
    mint: address(mint),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  return tokenAccount;
}

export function isOwnedByTokenProgram(account: MaybeEncodedAccount | undefined): boolean {
  return account !== undefined && account.exists && account.programAddress === TOKEN_PROGRAM_ADDRESS;
}

/** The token account at `tokenAccount`, or null when there is none there. */
export async function fetchTokenAccount(
  rpc: SolanaRpc,
  tokenAccount: Address,
  commitment: SettledCommitment,
): Promise<Token | null> {
  const account = await fetchEncodedAccount(rpc, tokenAccount, { commitment });
  // Anyone can send lamports to an address before its token account exists,
  // which leaves a System-owned account there that must not be decoded.
  if (!account.exists || !isOwnedByTokenProgram(account) || account.data.length !== getTokenSize()) return null;
  return decodeToken(account).data;
}

/** What `delegate` may still move out of a token account: nothing unless it is the account's delegate. */
export function delegatedAllowance(token: Token | null, delegate: Address): bigint {
  if (!token || !isSome(token.delegate) || token.delegate.value !== delegate) return 0n;
  return token.delegatedAmount;
}
