import { randomBytes } from 'node:crypto';
import { buildDelegateApproval, buildDelegateRevoke, createSolanaPayoutRail } from './solana-package.js';
import type { SolanaSettings } from '../config';
import type { SolanaPort, SolanaRail } from '../deps';

const SEED_BYTES = 32;
const SECRET_HEX = /^(?:[0-9a-f]{64}|[0-9a-f]{128})$/;

/**
 * A service key as it is stored: the hex of its 32-byte seed, or of the
 * 64-byte keypair the Solana tools write.
 */
export function delegateSecretBytes(secret: string): Uint8Array {
  if (!SECRET_HEX.test(secret)) throw new RangeError('a Solana service key is stored as 64 or 128 hex characters');
  return new Uint8Array(Buffer.from(secret, 'hex'));
}

/**
 * How the chain recorded one transaction, asked of the node directly: the
 * payout rail reads runs, not single transactions.
 */
async function recordedOutcome(rpcUrl: string, signature: string, doFetch: typeof fetch): Promise<{ failed: boolean; error: string | null } | null> {
  const response = await doFetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransaction',
      params: [signature, { commitment: 'finalized', encoding: 'json', maxSupportedTransactionVersion: 0 }],
    }),
  });
  if (!response.ok) throw new Error(`the Solana node answered HTTP ${response.status}`);
  const body = (await response.json()) as { result?: { meta?: { err?: unknown } | null } | null; error?: { message?: unknown } };
  if (body.error !== undefined) throw new Error(`the Solana node refused the request: ${String(body.error.message ?? 'no reason given')}`);
  if (body.result === null || body.result === undefined) return null;
  const meta = body.result.meta;
  if (meta === null || meta === undefined) throw new Error('the Solana node returned the transaction without its outcome');
  const failed = meta.err !== null && meta.err !== undefined;
  return { failed, error: failed ? JSON.stringify(meta.err) : null };
}

/** Solana payouts in one mint on one cluster. Nothing else in the application reaches the Solana package. */
export function solanaPort(settings: SolanaSettings, io: { fetch?: typeof fetch } = {}): SolanaPort {
  const { rpcUrl, mint, decimals } = settings;
  const rails = new Map<string, SolanaRail>();

  const railFor = (delegateSecret: string, previousDelegates: readonly string[] = []): SolanaRail => {
    const known = `${delegateSecret}:${previousDelegates.join(',')}`;
    let rail = rails.get(known);
    if (rail === undefined) {
      rail = createSolanaPayoutRail({
        rpcUrl,
        mint,
        decimals,
        delegateSecretKey: delegateSecretBytes(delegateSecret),
        previousDelegates: [...previousDelegates],
        ...(settings.markersFrom === undefined ? {} : { markersFrom: settings.markersFrom }),
      });
      rails.set(known, rail);
    }
    return rail;
  };

  return {
    cluster: settings.cluster,
    mint,
    decimals,
    tokenSymbol: settings.tokenSymbol,

    async newDelegateKey() {
      const secret = randomBytes(SEED_BYTES).toString('hex');
      // Deriving the address touches no network; a rail made only for that is not kept.
      const address = await createSolanaPayoutRail({ rpcUrl, mint, decimals, delegateSecretKey: delegateSecretBytes(secret) }).delegate();
      return { secret, address };
    },

    rail: railFor,
    buildApproval: (i) => buildDelegateApproval({ rpcUrl, mint, decimals, owner: i.owner, delegate: i.delegate, amount: i.amount }),
    buildRevoke: (i) => buildDelegateRevoke({ rpcUrl, mint, owner: i.owner }),
    recorded: (signature) => recordedOutcome(rpcUrl, signature, io.fetch ?? fetch),
    txUrl: (signature) => `https://explorer.solana.com/tx/${signature}${settings.cluster === 'devnet' ? '?cluster=devnet' : ''}`,
  };
}
