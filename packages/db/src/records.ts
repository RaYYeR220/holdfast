import type { Hex, Policy } from '@holdfast/core';
import type { KEY_KINDS, KEY_STATUSES, PAYOUT_CHAINS, PAYOUT_STATUSES, SWAP_PURPOSES } from './schema';

/**
 * The rows the application reads and writes beside the engine's own: service
 * keys, swaps, payout runs, refusals, auditor links. Amounts are bigint in
 * base units; times are epoch milliseconds.
 */

export type KeyKind = (typeof KEY_KINDS)[number];
export type ServiceKeyStatus = (typeof KEY_STATUSES)[number];
export type SwapPurpose = (typeof SWAP_PURPOSES)[number];
export type PayoutChain = (typeof PAYOUT_CHAINS)[number];
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

/** An organisation's row without the viewing key and without the tick lease. */
export interface OrgRecord {
  id: string;
  name: string;
  createdAt: number;
  /** The organisation's Hyperliquid account. Whoever controls it owns the organisation. */
  hlUser: string;
  birthday: number;
  scannedTo: number | null;
  policy: Policy;
  lockEnabled: boolean;
  nextSeq: number;
  lastDigest: Hex;
  monthlyBurnUsd: number | null;
  publicDemo: boolean;
  tempoAccount: string | null;
  solanaOwner: string | null;
}

export interface NewServiceKey {
  kind: KeyKind;
  /** The public half: an address, or whatever id the chain gives the key. */
  address: string;
  /** The private half, as text. It is stored encrypted and never listed. */
  secret: string;
}

/** A service key as it may be shown: everything but the secret. */
export interface ServiceKey {
  kind: KeyKind;
  address: string;
  status: ServiceKeyStatus;
  createdAt: number;
  revokedAt: number | null;
}

export interface NewSwap {
  purpose: SwapPurpose;
  originAsset: string;
  destinationAsset: string;
  amountIn: bigint;
  minAmountOut: bigint;
  depositAddress: string;
  recipient: string;
  /** The quote as the swap service gave it, kept as evidence. */
  quote: unknown;
  state: string;
}

export interface SwapRow {
  id: string;
  orgId: string;
  purpose: SwapPurpose;
  originAsset: string;
  destinationAsset: string;
  amountIn: bigint;
  minAmountOut: bigint;
  amountOut: bigint | null;
  depositAddress: string;
  recipient: string;
  state: string;
  originTxs: string[];
  destinationTxs: string[];
  createdAt: number;
  updatedAt: number;
}

/** What the swap service last said about a swap. */
export interface SwapSighting {
  state: string;
  originTxs: string[];
  destinationTxs: string[];
  amountOut: bigint | null;
}

export interface NewPayoutLine {
  payeeName: string;
  toAddress: string;
  amount: bigint;
  /** What the transfer will carry on chain; empty for none. */
  memo: string;
  reference: string;
}

export interface NewPayoutRun {
  chain: PayoutChain;
  token: string;
  tokenSymbol: string;
  tokenDecimals: number;
  /** The account the run pays from. */
  account: string;
  notBefore: bigint | null;
  /** The moment the run is created, ms; its UTC month goes into the run id. */
  at: number;
  /** The lines of the run, given the id it was numbered with: on some chains a line's memo has to carry it. */
  lines: (runId: string) => readonly NewPayoutLine[];
}

/** A run that was paid before the database knew of it, recorded as paid. */
export interface PaidPayoutRun {
  id: string;
  chain: PayoutChain;
  token: string;
  tokenSymbol: string;
  tokenDecimals: number;
  account: string;
  notBefore: bigint | null;
  tx: string;
  createdAt: number;
  executedAt: number;
  lines: readonly (NewPayoutLine & { tx: string | null; logIndex: number | null })[];
}

export interface PayoutLineRow {
  lineNo: number;
  payeeName: string;
  toAddress: string;
  amount: bigint;
  memo: string;
  reference: string;
  tx: string | null;
  logIndex: number | null;
  /** True once the line was found on chain as written. */
  reconciled: boolean;
  receiptToken: string | null;
}

export interface PayoutRunRow {
  id: string;
  orgId: string;
  chain: PayoutChain;
  token: string;
  /** Null on runs written before the symbol and decimals were kept. */
  tokenSymbol: string | null;
  tokenDecimals: number | null;
  account: string | null;
  notBefore: bigint | null;
  status: PayoutStatus;
  total: bigint;
  tx: string | null;
  error: string | null;
  createdAt: number;
  executedAt: number | null;
  lines: PayoutLineRow[];
}

/** How an attempt to pay a run ended, as far as it is known. */
export interface PayoutSettlement {
  status: PayoutStatus;
  tx: string | null;
  error: string | null;
  /** When the payment was confirmed, ms; null while it is not. */
  executedAt: number | null;
  /** Lines as they were found on chain. Lines left out keep what they had. */
  lines?: readonly { lineNo: number; tx: string | null; logIndex: number | null; reconciled: boolean }[];
}

export interface NewRefusal {
  chain: string;
  kind: string;
  /** What was asked of the chain or venue. */
  attempted: string;
  /** How it was turned down. */
  outcome: string;
  tx: string | null;
  evidence: unknown;
}

export interface RefusalRow extends NewRefusal {
  id: string;
  createdAt: number;
}

export interface NewAuditLink {
  /** Hash of the bearer token; the token itself is never stored. */
  tokenHash: string;
  label: string;
  scope: unknown;
  expiresAt: number | null;
}

export interface AuditLinkRow extends NewAuditLink {
  orgId: string;
  revokedAt: number | null;
  createdAt: number;
}

const RUN_ID = /^HF-(\d{4})-(\d{2})-(\d{4})$/;
export const MAX_RUNS_PER_MONTH = 9_999;

/** `HF-2026-10-` for a moment in October 2026, UTC. */
export function runIdPrefix(at: number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) throw new RangeError(`not a moment in time: ${at}`);
  const year = date.getUTCFullYear();
  if (year < 1000 || year > 9999) throw new RangeError(`cannot number a run in the year ${year}`);
  return `HF-${year}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-`;
}

/** The id of the `number`-th run of a month: `HF-2026-10-0001`. */
export function runIdOf(at: number, number: number): string {
  if (!Number.isInteger(number) || number < 1 || number > MAX_RUNS_PER_MONTH) {
    throw new RangeError(`a month has room for runs 1 to ${MAX_RUNS_PER_MONTH}, not ${number}`);
  }
  return `${runIdPrefix(at)}${String(number).padStart(4, '0')}`;
}

/** The number a run id carries within its month, or null when it is not a run id. */
export function runNumberOf(runId: string): number | null {
  const match = RUN_ID.exec(runId);
  return match === null ? null : Number(match[3]);
}
