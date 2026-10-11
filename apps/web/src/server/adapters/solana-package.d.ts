import type { SolanaRail, SolanaUnsigned } from '../deps';

/**
 * What the application uses of `@holdfast/solana`, as that package declares
 * it. `pnpm --filter @holdfast/web typecheck:solana` holds this file against
 * the package itself.
 */

export interface RpcSource {
  rpcUrl: string;
}

export interface SolanaPayoutRailConfig extends RpcSource {
  mint: string;
  decimals: number;
  /** The service key, as bytes or base58: a 32-byte seed or a 64-byte keypair. */
  delegateSecretKey: Uint8Array | string;
  /** Addresses of service keys used before the present one, whose run markers still count. */
  previousDelegates?: string[];
  /** The slot from which every payout of this service has set a run marker. */
  markersFrom?: bigint;
}

export function createSolanaPayoutRail(config: SolanaPayoutRailConfig): SolanaRail;

export function buildDelegateApproval(
  request: RpcSource & { owner: string; mint: string; decimals: number; delegate: string; amount: bigint },
): Promise<SolanaUnsigned<{ owner: string; tokenAccount: string; mint: string; delegate: string; amount: string }>>;

export function buildDelegateRevoke(request: RpcSource & { owner: string; mint: string }): Promise<SolanaUnsigned<{ owner: string; tokenAccount: string; mint: string }>>;
