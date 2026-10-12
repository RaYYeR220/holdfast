import type { KeyAuthorization, TxEnvelopeTempo } from 'ox/tempo';
import type { Address, Hex } from 'viem';
import type { Call } from './tip20';

/**
 * Everything the rail asks of the network. The viem-backed implementation
 * talks to a Tempo RPC; tests substitute an in-memory one.
 */
export interface TempoChain {
  /** Rejects unless the RPC serves the configured chain. */
  assertChain(): Promise<void>;
  head(): Promise<ChainHead>;
  keyState(root: Address): Promise<RawKeyState>;
  balanceOf(token: Address, owner: Address): Promise<bigint>;
  /**
   * Next nonce of the rail's lane on `root`. With `atBlock` it is the nonce as
   * of that block and rejects when the answering node does not have the block,
   * so the answer can never be older than the block it names.
   */
  laneNonce(root: Address, atBlock?: bigint): Promise<number>;
  /**
   * Next nonce of `root`'s own sequence, nonce key 0, on which a transaction
   * the root signs itself is numbered. With `atBlock` it is the nonce as of
   * that block and rejects when the answering node does not have the block.
   */
  accountNonce(root: Address, atBlock?: bigint): Promise<number>;
  /**
   * `TransferWithMemo` logs of the payout token sent by `root` with one of
   * `memos`, over the whole of `fromBlock..toBlock`. Resolves only with a
   * complete answer: every part of the range searched, by a node that had
   * reached the last block of that part. Anything less rejects, so that an
   * empty result means the logs are not there.
   */
  memoLogs(query: { root: Address; memos: Hex[]; fromBlock: bigint; toBlock: bigint }): Promise<ChainLog[]>;
  receipt(hash: Hex): Promise<ChainReceipt | null>;
  /** Simulates the calls, fills gas and fees, and signs with the access key and the sponsor. Rejects when the simulation does. */
  signPayout(tx: PayoutTx): Promise<SignedTx>;
  /** Signs without asking the node anything, so a transaction that must fail can still be broadcast. */
  signForced(tx: ForcedTx): Promise<SignedTx>;
  /** Adds the sponsor's signature as fee payer to a revocation the root signed. Asks the node nothing. */
  signRevocation(tx: RevocationTx): Promise<SignedTx>;
  /** Rejects only when the node could not be reached; a refusal by the node is a result. */
  broadcast(serialized: Hex): Promise<BroadcastResult>;
  /** Revert data of an included, failed transaction; null when the RPC does not serve traces. */
  revertData(hash: Hex): Promise<Hex | null>;
}

export interface ChainHead {
  number: bigint;
  /** Block time, unix seconds. */
  timestamp: number;
  baseFeePerGas: bigint;
}

/** The keychain's getters for one key, untouched. A revoked or unknown key reads as the zero key id. */
export interface RawKeyState {
  keyId: Address;
  expiry: bigint;
  enforceLimits: boolean;
  isRevoked: boolean;
  remaining: bigint;
  /** Zero for a one-off limit. */
  periodEnd: bigint;
  isScoped: boolean;
  scopes: readonly RawScope[];
}

export interface RawScope {
  target: Address;
  /** Empty means every selector of the target. */
  selectorRules: readonly { selector: Hex; recipients: readonly Address[] }[];
}

export interface ChainLog {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
  logIndex: number;
  transactionHash: Hex;
  blockNumber: bigint;
}

export interface ChainReceipt {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  gasUsed: bigint;
  logs: ChainLog[];
}

export interface PayoutTx {
  root: Address;
  calls: Call[];
  nonce: number;
  /** Unix seconds; the transaction cannot be included in a block at or after this time. */
  validBefore: number;
  /** A root-signed authorization that provisions the access key in this same transaction. */
  keyAuthorization?: KeyAuthorization.Signed;
}

export interface ForcedTx extends PayoutTx {
  gas: bigint;
  maxFeePerGas: bigint;
}

/** A `revokeKey` the root of an account signed for a fee payer to pay for. */
export interface RevocationTx {
  root: Address;
  /** The key the transaction takes back. */
  accessKey: Address;
  nonce: number;
  /** Unix seconds; the transaction cannot be included in a block at or after this time. */
  validBefore: number;
  /** The transaction with the root's signature and, where the fee payer's goes, the marker that one is to follow. */
  envelope: TxEnvelopeTempo.Signed;
}

export interface SignedTx {
  serialized: Hex;
  hash: Hex;
}

export type BroadcastResult = { accepted: true } | { accepted: false; reason: string };
