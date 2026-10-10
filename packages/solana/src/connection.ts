import {
  createDefaultRpcTransport,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpcFromTransport,
  getBase58Encoder,
  type KeyPairSigner,
  type Rpc,
  type RpcTransport,
  type SolanaRpcApi,
} from '@solana/kit';

export type SolanaRpc = Rpc<SolanaRpcApi>;

/** Chain state the rail waits for before it treats something as true. */
export type SettledCommitment = 'confirmed' | 'finalized';

export interface RpcSource {
  rpcUrl: string;
  /** Replaces the default HTTP transport, e.g. to add provider headers or to stub the node in tests. */
  transport?: RpcTransport;
}

export function connect(source: RpcSource): SolanaRpc {
  return createSolanaRpcFromTransport(source.transport ?? createDefaultRpcTransport({ url: source.rpcUrl }));
}

/**
 * Accepts the 64-byte keypair the Solana CLI writes (seed followed by public
 * key) or the bare 32-byte seed, as bytes or base58.
 */
export async function loadKeyPairSigner(secretKey: Uint8Array | string): Promise<KeyPairSigner> {
  const bytes = typeof secretKey === 'string' ? getBase58Encoder().encode(secretKey) : secretKey;
  if (bytes.length === 64) return createKeyPairSignerFromBytes(bytes);
  if (bytes.length === 32) return createKeyPairSignerFromPrivateKeyBytes(bytes);
  throw new Error(`secret key must be 64 bytes (seed and public key) or a 32-byte seed, got ${bytes.length} bytes`);
}
