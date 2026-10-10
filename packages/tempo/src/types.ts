import type { PayoutLine, PayoutRail, PayoutResult } from '@holdfast/core';
import type { Address, Hex } from 'viem';
import type { AccessKeyPolicyInput } from './authorization';
import type { TempoNetwork } from './networks';

export interface TempoRailConfig {
  network: TempoNetwork;
  /** Defaults to the network's public RPC. */
  rpcUrl?: string;
  /** TIP-20 stablecoin the payouts are made in. */
  token: Address;
  /** P-256 private key of the access key the treasurer authorized. */
  accessKeyPrivateKey: Hex;
  /** secp256k1 private key of the account that pays every fee. */
  sponsorPrivateKey: Hex;
  /** Token the sponsor pays fees in; defaults to `token`. */
  feeToken?: Address;
  /** Nonce lane reserved for this rail on the paying account; defaults to `DEFAULT_NONCE_KEY`. */
  nonceKey?: bigint;
  /** How many blocks back `findRun` searches; defaults to `DEFAULT_LOOKBACK_BLOCKS`. */
  lookbackBlocks?: bigint;
}

export interface KeyScope {
  /** True when the key carries no call scope at all and may call anything. */
  unrestricted: boolean;
  /** Function selectors the key may call on the payout token; null when every function of the token is allowed. */
  selectors: Hex[] | null;
  /** Addresses `transferWithMemo` may pay; null when any recipient is allowed, empty when none is. */
  recipients: Address[] | null;
  /** Contracts other than the payout token the key may call; empty for a payout-only key. */
  otherTargets: Address[];
}

/** What the Account Keychain says about the rail's access key on one account. Times are in ms. */
export interface KeyStatus {
  accessKey: Address;
  /**
   * Live on this account and bounded the way the rail requires: a spending
   * limit, and a call scope of `transferWithMemo` on the payout token and
   * nothing else. The rail pays with no other kind of key.
   */
  authorized: boolean;
  /** Known to the keychain for this account, not revoked and not expired, whatever it is allowed to do. */
  live: boolean;
  /** How a live key is broader or other than the bounded payout key the rail accepts; empty when it is not. */
  mismatch: string[];
  revoked: boolean;
  /** Null when the key is unknown to the keychain or has no expiry. */
  expiresAt: number | null;
  /** False when the key was authorized without spending limits. */
  limited: boolean;
  /** What the key may still spend of the payout token; zero unless authorized. */
  remaining: bigint;
  /** When a periodic limit refills; null for a one-off limit. */
  periodEnd: number | null;
  scope: KeyScope;
}

export type PreflightResult = { ok: true } | { ok: false; problems: string[] };

export interface PaidLine {
  to: Address;
  amount: bigint;
  memo: string;
  logIndex: number;
}

export interface RunOnChain {
  tx: Hex;
  blockNumber: bigint;
  lines: PaidLine[];
  /** Further transactions carrying this run's memos. Anything here means lines of the run were paid more than once. */
  otherTxs: Hex[];
}

export interface TempoPayoutResult extends PayoutResult {
  /** Hash of the transaction this result is about; null when nothing reached the chain. */
  tx: Hex | null;
  /** True when exactly this run was found on chain, so nothing was sent. */
  alreadyPaid: boolean;
  gasUsed: bigint | null;
}

export interface ProbeResult {
  tx: Hex | null;
  includedOnChain: boolean;
  /** True only when the receipt on chain says the transaction failed. */
  reverted: boolean;
  /** Name of the decoded revert; null when the RPC does not serve traces or nothing reverted. */
  reason: string | null;
  returnData: Hex | null;
  /** Gas the failed transaction still consumed; the sponsor paid for it. */
  gasUsed: bigint | null;
  /** Why the probe produced no receipt, when it did not. */
  error: string | null;
}

export interface FindRunOptions {
  /** How many blocks back to search; defaults to the rail's `lookbackBlocks`. */
  lookbackBlocks?: bigint;
}

export interface TempoPayoutRail extends PayoutRail {
  chain: 'tempo';
  /** Address of the access key, the key id the treasurer authorizes. */
  accessKeyAddress: Address;
  /** Account that pays fees and has to hold the fee token. */
  sponsorAddress: Address;
  /** One transaction for the whole run. Never rejects, and never pays a run id twice. */
  pay(i: { account: string; lines: PayoutLine[]; runId: string }): Promise<TempoPayoutResult>;
  keyStatus(account: string): Promise<KeyStatus>;
  /** Everything that can be known before sending. With a run id, each memo must also be `<runId>/<line>`, as `pay` requires. */
  preflight(i: { account: string; lines: PayoutLine[]; runId?: string }): Promise<PreflightResult>;
  /** The transaction that paid a run, found through the memo topics of the token's events. */
  findRun(account: string, runId: string, options?: FindRunOptions): Promise<RunOnChain | null>;
  /** Lands a transfer no spending limit can cover, to an allowed payee, and reports how the chain refused it. It cannot move funds. */
  probeOverLimit(i: { account: string; to: string }): Promise<ProbeResult>;
  /** Lands a plain `transfer` of one base unit, which a payout key is not scoped for, and reports how the chain refused it. */
  probeOutOfScope(i: { account: string; to: string }): Promise<ProbeResult>;
  /** Provisions the access key from a root-signed authorization; the sponsor pays. */
  submitAuthorization(i: SubmitAuthorizationInput): Promise<TempoPayoutResult>;
}

export interface SubmitAuthorizationInput {
  /** The account whose root signed the authorization. */
  account: string;
  /** Output of `serializeSignedAuthorization`. */
  signedWire: Hex;
  /**
   * The terms the treasurer was asked to sign: the same object that was given
   * to `buildAccessKeyAuthorization`. The authorization is submitted only if
   * it grants exactly these terms, to this rail's key, for `account`.
   */
  expected: AccessKeyPolicyInput;
  /** A payout to make in the same transaction that provisions the key. */
  firstRun?: { lines: PayoutLine[]; runId: string };
}
