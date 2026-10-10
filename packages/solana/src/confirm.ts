import {
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  type Base64EncodedWireTransaction,
  type Commitment,
  type SendableTransaction,
  type Signature,
  type Transaction,
  type TransactionError,
} from '@solana/kit';
import type { SettledCommitment, SolanaRpc } from './connection';
import { describeFailure, isRejectionByNode } from './errors';

/** A signed transaction on its way to the chain: enough to watch it and to send it again. */
export interface Broadcast {
  signature: Signature;
  wire: Base64EncodedWireTransaction;
  /** Past this block height the transaction can no longer land. */
  lastValidBlockHeight: bigint;
}

export type SendOutcome =
  /** Processed at the requested commitment; `err` is the chain's verdict on it. */
  | { status: 'landed'; signature: Signature; err: TransactionError | null }
  /** Proven dead: its blockhash expired and the chain has no record of it. */
  | { status: 'expired'; signature: Signature }
  /** Neither of the above could be established; it may still land. */
  | { status: 'unknown'; signature: Signature; reason: string };

export interface FollowOptions {
  commitment: SettledCommitment;
  pollIntervalMs?: number;
  /** Stop asking after this long. A blockhash lives for roughly a minute. */
  deadlineMs?: number;
}

export interface SendOptions extends FollowOptions {
  skipPreflight?: boolean;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_DEADLINE_MS = 120_000;
const REBROADCAST_EVERY_POLLS = 3;

export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export function broadcastOf(transaction: SendableTransaction & Transaction, lastValidBlockHeight: bigint): Broadcast {
  return {
    signature: getSignatureFromTransaction(transaction),
    wire: getBase64EncodedWireTransaction(transaction),
    lastValidBlockHeight,
  };
}

function hasSettled(status: Commitment | null, commitment: SettledCommitment): boolean {
  return status === 'finalized' || (commitment === 'confirmed' && status === 'confirmed');
}

/**
 * Whether the transaction is provably dead. Its blockhash must have expired
 * on the confirmed chain, and a node that has itself processed that far must
 * have no record of it. The second half matters behind a load balancer: a
 * lagging node also answers "never seen it" about a transaction that landed.
 */
async function hasExpired(rpc: SolanaRpc, { signature, lastValidBlockHeight }: Broadcast): Promise<boolean> {
  const { absoluteSlot, blockHeight } = await rpc.getEpochInfo({ commitment: 'confirmed' }).send();
  if (blockHeight <= lastValidBlockHeight) return false;
  const { context, value } = await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send();
  return !value[0] && context.slot >= absoluteSlot;
}

/**
 * Watch a broadcast transaction over plain HTTP until its fate is known,
 * sending it again now and then while it could still land. Never throws:
 * when the node cannot be asked, the answer is `unknown`.
 */
export async function follow(rpc: SolanaRpc, broadcast: Broadcast, options: FollowOptions): Promise<SendOutcome> {
  const { signature, wire } = broadcast;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + (options.deadlineMs ?? DEFAULT_DEADLINE_MS);

  let reason = 'the node reported no status';
  for (let poll = 1; ; poll++) {
    try {
      const { value } = await rpc.getSignatureStatuses([signature], { searchTransactionHistory: false }).send();
      const status = value[0] ?? null;
      if (status && hasSettled(status.confirmationStatus, options.commitment)) {
        return { status: 'landed', signature, err: status.err };
      }
      if (!status) {
        if (await hasExpired(rpc, broadcast)) return { status: 'expired', signature };
        if (poll % REBROADCAST_EVERY_POLLS === 0) {
          await rpc.sendTransaction(wire, { encoding: 'base64', skipPreflight: true, maxRetries: 0n }).send();
        }
      }
    } catch (error) {
      reason = describeFailure(error);
    }
    if (Date.now() >= deadline) return { status: 'unknown', signature, reason };
    await sleep(pollIntervalMs);
  }
}

/**
 * Send a signed transaction and follow it until its fate is known. Throws
 * only when the node refuses the transaction outright, which includes a
 * failed preflight simulation: nothing was broadcast in that case.
 */
export async function sendAndConfirm(rpc: SolanaRpc, broadcast: Broadcast, options: SendOptions): Promise<SendOutcome> {
  try {
    await rpc
      .sendTransaction(broadcast.wire, {
        encoding: 'base64',
        skipPreflight: options.skipPreflight ?? false,
        preflightCommitment: options.commitment,
      })
      .send();
  } catch (error) {
    // A dropped connection says nothing about whether the node forwarded the
    // transaction, so only an explicit refusal ends the attempt here.
    if (isRejectionByNode(error)) throw error;
  }
  await sleep(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  return follow(rpc, broadcast, options);
}
