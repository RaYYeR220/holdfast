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
import { sendAndConfirm, type SendOutcome } from '../src/confirm';
import type { SolanaRpc } from '../src/connection';
import { describeTransactionError } from '../src/errors';

function requireSuccess(outcome: SendOutcome, instructions: readonly Instruction[] = []): Signature {
  if (outcome.status !== 'landed') throw new Error(`transaction ${outcome.signature} did not land: ${outcome.status}`);
  if (outcome.err !== null) {
    throw new Error(`transaction ${outcome.signature} failed: ${describeTransactionError(outcome.err, instructions)}`);
  }
  return outcome.signature;
}

/** Sign with the fee payer and every signer the instructions carry, send, and wait for confirmation. */
export async function submit(rpc: SolanaRpc, feePayer: KeyPairSigner, instructions: Instruction[]): Promise<Signature> {
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayerSigner(feePayer, m),
    m => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    m => appendTransactionMessageInstructions(instructions, m),
  );
  const transaction = await signTransactionMessageWithSigners(message);
  const outcome = await sendAndConfirm(rpc, transaction, {
    commitment: 'confirmed',
    lastValidBlockHeight: lifetime.lastValidBlockHeight,
  });
  return requireSuccess(outcome, instructions);
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
  const outcome = await sendAndConfirm(rpc, signed, {
    commitment: 'confirmed',
    lastValidBlockHeight: unsigned.lastValidBlockHeight,
  });
  return requireSuccess(outcome);
}
