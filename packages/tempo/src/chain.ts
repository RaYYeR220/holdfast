import type { KeyAuthorization } from 'ox/tempo';
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
  /** Next nonce of the rail's lane on `root`. */
  laneNonce(root: Address): Promise<number>;
  /** `TransferWithMemo` logs of the payout token sent by `root` with one of `memos`. */
  memoLogs(query: { root: Address; memos: Hex[]; fromBlock: bigint; toBlock: bigint }): Promise<ChainLog[]>;
  receipt(hash: Hex): Promise<ChainReceipt | null>;
  /** Simulates the calls, fills gas and fees, and signs with the access key and the sponsor. Rejects when the simulation does. */
  signPayout(tx: PayoutTx): Promise<SignedTx>;
  /** Signs without asking the node anything, so a transaction that must fail can still be broadcast. */
  signForced(tx: ForcedTx): Promise<SignedTx>;
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

export interface SignedTx {
  serialized: Hex;
  hash: Hex;
}

export type BroadcastResult = { accepted: true } | { accepted: false; reason: string };
