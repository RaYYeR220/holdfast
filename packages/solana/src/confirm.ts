import {
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  type Commitment,
  type SendableTransaction,
  type Signature,
  type Transaction,
  type TransactionError,
} from '@solana/kit';
import type { SettledCommitment, SolanaRpc } from './connection';
import { describeFailure, isRejectionByNode } from './errors';

export type SendOutcome =
  /** Processed at the requested commitment; `err` is the chain's verdict on it. */
  | { status: 'landed'; signature: Signature; err: TransactionError | null }
  /** Its blockhash expired without the transaction being seen, so it can no longer land. */
  | { status: 'expired'; signature: Signature }
  /** The node stopped answering before either of the above could be established. */
  | { status: 'unknown'; signature: Signature; reason: string };

export interface SendOptions {
  lastValidBlockHeight: bigint;
  commitment: SettledCommitment;
  skipPreflight?: boolean;
  pollIntervalMs?: number;
  /** Stop asking after this long. A blockhash lives for roughly a minute. */
  deadlineMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_DEADLINE_MS = 120_000;
const REBROADCAST_EVERY_POLLS = 3;

export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function hasSettled(status: Commitment | null, commitment: SettledCommitment): boolean {
  return status === 'finalized' || (commitment === 'confirmed' && status === 'confirmed');
}

async function statusOf(rpc: SolanaRpc, signature: Signature, searchTransactionHistory: boolean) {
  const { value } = await rpc.getSignatureStatuses([signature], { searchTransactionHistory }).send();
  return value[0] ?? null;
}

/**
 * Send a signed transaction and follow it over plain HTTP until its fate is
 * known. Throws only when the node refuses the transaction outright, which
 * includes a failed preflight simulation: nothing was broadcast in that case.
 */
export async function sendAndConfirm(
  rpc: SolanaRpc,
  transaction: SendableTransaction & Transaction,
  options: SendOptions,
): Promise<SendOutcome> {
  const signature = getSignatureFromTransaction(transaction);
  const wire = getBase64EncodedWireTransaction(transaction);
  const { commitment, lastValidBlockHeight } = options;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + (options.deadlineMs ?? DEFAULT_DEADLINE_MS);

  try {
    await rpc
      .sendTransaction(wire, {
        encoding: 'base64',
        skipPreflight: options.skipPreflight ?? false,
        preflightCommitment: commitment,
      })
      .send();
  } catch (error) {
    // A dropped connection says nothing about whether the node forwarded the
    // transaction, so only an explicit refusal ends the attempt here.
    if (isRejectionByNode(error)) throw error;
  }

  let reason = 'the node reported no status';
  for (let poll = 1; Date.now() < deadline; poll++) {
    await sleep(pollIntervalMs);
    try {
      const status = await statusOf(rpc, signature, false);
      if (status && hasSettled(status.confirmationStatus, commitment)) {
        return { status: 'landed', signature, err: status.err };
      }
      if (status) continue;
      const blockHeight = await rpc.getBlockHeight({ commitment: 'confirmed' }).send();
      if (blockHeight > lastValidBlockHeight) {
        if (!(await statusOf(rpc, signature, true))) return { status: 'expired', signature };
        continue;
      }
      if (poll % REBROADCAST_EVERY_POLLS === 0) {
        await rpc.sendTransaction(wire, { encoding: 'base64', skipPreflight: true, maxRetries: 0n }).send();
      }
    } catch (error) {
      reason = describeFailure(error);
    }
  }
  return { status: 'unknown', signature, reason };
}
