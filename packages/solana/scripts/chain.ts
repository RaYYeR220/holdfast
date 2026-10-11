import {
  appendTransactionMessageInstructions,
  assertIsSendableTransaction,
  createTransactionMessage,
  getBase64Encoder,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
  signTransactionMessageWithSigners,
  type Instruction,
  type KeyPairSigner,
  type Signature,
} from '@solana/kit';
import type { UnsignedTransaction } from '../src/approval';
import { broadcastOf, sendAndConfirm, type SendOutcome } from '../src/confirm';
import type { SolanaRpc } from '../src/connection';
import { describeTransactionError } from '../src/errors';

/** A transaction that landed and was refused by the chain. */
export interface RefusedOnChain {
  signature: Signature;
  /** The error the chain recorded, in the words of `describeTransactionError`. */
  error: string;
}

function requireSuccess(outcome: SendOutcome, instructions: readonly Instruction[] = []): Signature {
  if (outcome.status !== 'landed') throw new Error(`transaction ${outcome.signature} did not land: ${outcome.status}`);
  if (outcome.err !== null) {
    throw new Error(`transaction ${outcome.signature} failed: ${describeTransactionError(outcome.err, instructions)}`);
  }
  return outcome.signature;
}

async function send(
  rpc: SolanaRpc,
  feePayer: KeyPairSigner,
  instructions: readonly Instruction[],
  skipPreflight: boolean,
): Promise<SendOutcome> {
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayerSigner(feePayer, m),
    m => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    m => appendTransactionMessageInstructions(instructions, m),
  );
  const transaction = await signTransactionMessageWithSigners(message);
  const broadcast = broadcastOf(transaction, lifetime.lastValidBlockHeight);
  return sendAndConfirm(rpc, broadcast, { commitment: 'confirmed', skipPreflight });
}

/** Sign with the fee payer and every signer the instructions carry, send, and wait for confirmation. */
export async function submit(rpc: SolanaRpc, feePayer: KeyPairSigner, instructions: Instruction[]): Promise<Signature> {
  return requireSuccess(await send(rpc, feePayer, instructions, false), instructions);
}

/**
 * Send a transaction that the chain should refuse, past preflight so that
 * the refusal is recorded on chain rather than given by one node. Throws if
 * the transaction went through.
 */
export async function submitToBeRefused(
  rpc: SolanaRpc,
  feePayer: KeyPairSigner,
  instructions: readonly Instruction[],
): Promise<RefusedOnChain> {
  const outcome = await send(rpc, feePayer, instructions, true);
  if (outcome.status !== 'landed') throw new Error(`transaction ${outcome.signature} did not land: ${outcome.status}`);
  if (outcome.err === null) throw new Error(`transaction ${outcome.signature} was not refused`);
  return { signature: outcome.signature, error: describeTransactionError(outcome.err, instructions) };
}

/**
 * What a browser wallet does with a transaction the service built: decode
 * the wire bytes, add the wallet's signature, and send it.
 */
export async function signAndSendAsWallet(
  rpc: SolanaRpc,
  wallet: KeyPairSigner,
  unsigned: UnsignedTransaction<unknown>,
): Promise<Signature> {
  const decoded = getTransactionDecoder().decode(getBase64Encoder().encode(unsigned.transaction));
  const signed = await signTransaction([wallet.keyPair], decoded);
  assertIsSendableTransaction(signed);
  const broadcast = broadcastOf(signed, unsigned.lastValidBlockHeight);
  const outcome = await sendAndConfirm(rpc, broadcast, { commitment: 'confirmed' });
  return requireSuccess(outcome);
}
