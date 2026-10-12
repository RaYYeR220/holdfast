import type { Bar, PayoutAllowance, PayoutLine, ReferencePrice, TreasuryScanner } from '@holdfast/core';
import type { PgStore } from '@holdfast/db';
import type { ApproveAgentAction, ExchangeReply, HyperliquidVenue, UserSignedRequest, WithdrawRefusalProbe } from '@holdfast/hyperliquid';
import type { OneClick } from '@holdfast/intents';
import type { TempoChain, TempoNetwork, TempoPayoutRail } from '@holdfast/tempo';
import type { UfvkCheck } from '@holdfast/zcash';
import type { Address, Hex } from 'viem';
import type { HoldfastNetwork, SolanaCluster } from './config';
import type { Redactor } from './redact';

/**
 * Everything the services reach outside the process through. The real ones
 * are built from the environment in `runtime.ts`; tests put fakes in their
 * place. A service takes this as its first argument and reads nothing else.
 */
export interface Deps {
  now(): number;
  redact: Redactor;
  /** Every configured value that must not leave the server, for what checks a text before it is sent out. */
  knownSecrets(): readonly string[];
  /** Where an error nobody planned for is written down. It is given text that has been through `redact`. */
  report(message: string): void;
  network: HoldfastNetwork;
  secrets: { session: Uint8Array; tick: string };
  /**
   * The host the application is served on. Sign-in messages must be written
   * for it and state-changing requests must come from it. Null only outside
   * production: the host a request names is then taken at its word.
   */
  publicHost: string | null;
  store: PgStore;
  zcash: ZcashPort;
  hyperliquid: HyperliquidPort;
  reference: ReferencePrice;
  oneClick: Pick<OneClick, 'quote' | 'status'>;
  tempo: TempoPort;
  solana: SolanaPort;
  /** The hourly ZEC history the scenarios are graded on. */
  bars(): Promise<readonly Bar[]>;
}

export interface ZcashPort {
  network: HoldfastNetwork;
  check(ufvk: string): UfvkCheck;
  scanner(): TreasuryScanner;
}

/** The terms of one agent approval. The same terms build the typed data and submit its signature. */
export interface ApprovalTerms {
  agentAddress: string;
  agentName: string;
  /** Millisecond timestamp; it is the replay nonce of the action. */
  nonce: number;
  signatureChainId?: number;
  validUntil?: number;
}

export interface HyperliquidPort {
  network: HoldfastNetwork;
  newAgentKey(): { privateKey: Hex; address: Hex };
  /** Every read works without a key; placing an order needs the agent's. */
  venue(agentPrivateKey?: Hex): HyperliquidVenue;
  approvalRequest(terms: ApprovalTerms): UserSignedRequest<ApproveAgentAction>;
  submitApproval(terms: ApprovalTerms & { user: string; signature: string }): Promise<ExchangeReply>;
  probeWithdrawal(i: { agentPrivateKey: Hex; user: string }): Promise<WithdrawRefusalProbe>;
}

export interface TempoPort {
  network: TempoNetwork;
  chainId: number;
  token: Address;
  tokenSymbol: string;
  decimals: number;
  newAccessKey(): { privateKey: Hex; address: Address };
  /** The rail that pays with this access key; fees are paid by the service's sponsor. */
  rail(accessKeyPrivateKey: Hex): TempoPayoutRail;
  /** Reads of single transactions, which the rail itself does not offer. */
  chain(accessKeyPrivateKey: Hex): Pick<TempoChain, 'receipt' | 'revertData'>;
  txUrl(hash: string): string;
}

export interface SolanaRunInput {
  account: string;
  lines: PayoutLine[];
  runId: string;
  /** A slot before which the run cannot have been paid. */
  notBefore?: bigint;
}

export interface SolanaPayResult {
  ok: boolean;
  tx: string | null;
  error: string | null;
  /**
   * `unknown`: whether the lines are paid could not be settled, and the run must not be treated as unpaid.
   * `failed`: a transaction was sent and certainly paid nothing. `refused`: nothing was paid.
   */
  outcome: 'paid' | 'failed' | 'unknown' | 'refused';
  replayed: boolean;
  lineMemos: boolean;
  historyError: string | null;
}

export interface SolanaPreview {
  ok: boolean;
  error: string | null;
  /** Whether these lines are already paid. It is not true of a run id that is merely spent. */
  alreadyPaid: boolean;
  /** Whether the run id is taken, so that paying would send nothing. */
  spent: boolean;
  paidBy: string | null;
  lineMemos: boolean;
  /** SOL the run would take from the service key, in lamports. */
  cost: { newTokenAccounts: number; rentLamports: bigint; markerLamports: bigint; feeLamports: bigint } | null;
  historyError: string | null;
}

export interface SolanaRunOnChain {
  runId: string;
  signature: string;
  slot: bigint;
  time: number | null;
  total: bigint;
  transfers: { to: string; tokenAccount: string; amount: bigint; memo: string | null }[];
}

export interface SolanaRefusalProbe {
  signature: string | null;
  failedOnChain: boolean;
  error: string | null;
}

/** The part of the Solana payout rail the application uses. */
export interface SolanaRail {
  delegate(): Promise<string>;
  remaining(account: string): Promise<PayoutAllowance>;
  checkpoint(): Promise<bigint>;
  preview(i: SolanaRunInput): Promise<SolanaPreview>;
  pay(i: SolanaRunInput): Promise<SolanaPayResult>;
  /** Null means the chain proves the run was not paid; when that cannot be established this rejects. */
  findRun(account: string, runId: string, options?: { notBefore?: bigint }): Promise<SolanaRunOnChain | null>;
  probeOverAllowance(i: { account: string; to: string }): Promise<SolanaRefusalProbe>;
}

/** A transaction for the team's own wallet to sign, as base64 wire bytes with the signature slot empty. */
export interface SolanaUnsigned<TSummary> {
  transaction: string;
  summary: TSummary;
  lastValidBlockHeight: bigint;
}

export interface SolanaPort {
  cluster: SolanaCluster;
  mint: string;
  decimals: number;
  tokenSymbol: string;
  /** A fresh service key: its secret as it is stored, and the address the team approves as delegate. */
  newDelegateKey(): Promise<{ secret: string; address: string }>;
  /** `previousDelegates` are the addresses of service keys the organisation paid with before this one. */
  rail(delegateSecret: string, previousDelegates?: readonly string[]): SolanaRail;
  buildApproval(i: { owner: string; delegate: string; amount: bigint }): Promise<SolanaUnsigned<{ owner: string; tokenAccount: string; mint: string; delegate: string; amount: string }>>;
  buildRevoke(i: { owner: string }): Promise<SolanaUnsigned<{ owner: string; tokenAccount: string; mint: string }>>;
  /** How the chain recorded a transaction: null when the node does not have it. */
  recorded(signature: string): Promise<{ failed: boolean; error: string | null } | null>;
  txUrl(signature: string): string;
}
