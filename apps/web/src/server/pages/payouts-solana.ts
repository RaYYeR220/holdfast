import type { SolanaCluster, SolanaSettings } from '../config';
import { associatedTokenAddress, runMarker, runMarkerSeed } from './payouts-solana-package.js';

/**
 * What the payouts pages read from Solana beside the payout rail: the SOL an
 * address holds and whether an account carries data. The rail reads
 * allowances and runs; it has no read of either of these.
 */

/** The program every wallet and every run marker belongs to. */
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';

export interface SolanaAccountSeen {
  /** The program the account belongs to. */
  owner: string;
  lamports: bigint;
  /** How many bytes of data the account carries. */
  dataLength: number;
}

export interface SolanaReads {
  /** The SOL an address holds, in lamports. */
  lamports(address: string): Promise<bigint>;
  /** The account at an address, or null when the chain has none there. */
  account(address: string): Promise<SolanaAccountSeen | null>;
  /** The token account of a wallet for a mint. Derived, not looked up. */
  tokenAccountOf(owner: string, mint: string): Promise<string>;
  /** The address of the marker a payout of `runId` sets under a service key. Derived, not looked up. */
  markerOf(run: { delegate: string; owner: string; mint: string; runId: string }): Promise<string>;
}

/**
 * Where an address of a cluster can be looked at, as what its link has before
 * the address and after it; the same explorer the server links transactions on.
 */
export function solanaAddressLinks(cluster: SolanaCluster): { before: string; after: string } {
  return { before: 'https://explorer.solana.com/address/', after: cluster === 'devnet' ? '?cluster=devnet' : '' };
}

/**
 * Whether an account is a run marker that has been set: an account of the
 * System program that carries data. Lamports alone do not make one, since
 * anybody can send those.
 */
export function isMarkerSet(account: SolanaAccountSeen | null): boolean {
  return account !== null && account.owner === SYSTEM_PROGRAM && account.dataLength > 0;
}

interface RpcAnswer<T> {
  result?: { value?: T } | null;
  error?: { message?: unknown };
}

/** The reads against a node of the configured cluster. A failed read rejects; nothing stands in for its answer. */
export function solanaReads(settings: Pick<SolanaSettings, 'rpcUrl'>, io: { fetch?: typeof fetch } = {}): SolanaReads {
  const ask = async <T>(method: string, params: unknown[]): Promise<T | null> => {
    const response = await (io.fetch ?? fetch)(settings.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!response.ok) throw new Error(`the Solana node answered HTTP ${response.status}`);
    const body = (await response.json()) as RpcAnswer<T>;
    if (body.error !== undefined) throw new Error(`the Solana node refused the request: ${String(body.error.message ?? 'no reason given')}`);
    if (body.result === null || body.result === undefined) throw new Error('the Solana node answered without a result');
    return body.result.value ?? null;
  };

  return {
    async lamports(address) {
      const value = await ask<number>('getBalance', [address, { commitment: 'confirmed' }]);
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('the Solana node answered without a balance');
      return BigInt(value);
    },

    async account(address) {
      const value = await ask<{ owner?: unknown; lamports?: unknown; data?: unknown }>('getAccountInfo', [address, { commitment: 'confirmed', encoding: 'base64' }]);
      if (value === null) return null;
      const data = Array.isArray(value.data) ? value.data[0] : undefined;
      if (typeof value.owner !== 'string' || typeof value.lamports !== 'number' || typeof data !== 'string') throw new Error('the Solana node answered with an account that cannot be read');
      return { owner: value.owner, lamports: BigInt(value.lamports), dataLength: Buffer.from(data, 'base64').length };
    },

    tokenAccountOf: (owner, mint) => associatedTokenAddress(owner, mint),

    async markerOf({ delegate, owner, mint, runId }) {
      return (await runMarker(delegate, await runMarkerSeed(owner, mint, runId))).address;
    },
  };
}
