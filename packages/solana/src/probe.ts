import {
  fetchEncodedAccount,
  isAddress,
  MAX_SUPPORTED_TRANSACTION_VERSION,
  type Instruction,
  type Signature,
  type TransactionError,
} from '@solana/kit';
import { getTransferCheckedInstruction } from '@solana-program/token';
import { associatedTokenAddress, delegatedAllowance, fetchTokenAccount } from './accounts';
import { MAX_TOKEN_AMOUNT } from './amounts';
import { sendAndConfirm, sleep } from './confirm';
import type { RailContext } from './context';
import { describeTransactionError } from './errors';
import { isMarkerSet } from './marker';
import { fitsOneTransaction, memoInstruction, payoutInstructions, type PayoutPlan } from './payout';
import { identifyRun, type RunInput } from './prepare';
import type { RefusalProbe } from './results';

const ALLOWANCE_PROBE_MEMO = 'holdfast allowance probe';
const READ_BACK_ATTEMPTS = 10;

const unsent = (error: string): RefusalProbe => ({ signature: null, failedOnChain: false, error });

/** The error the node recorded for a landed transaction; null when the node will not show the transaction. */
async function readBackError(
  { rpc, commitment, pollIntervalMs }: RailContext,
  signature: Signature,
): Promise<{ err: TransactionError | null } | null> {
  for (let attempt = 0; attempt < READ_BACK_ATTEMPTS; attempt++) {
    const response = await rpc
      .getTransaction(signature, {
        commitment,
        encoding: 'base64',
        maxSupportedTransactionVersion: MAX_SUPPORTED_TRANSACTION_VERSION,
      })
      .send();
    if (response?.meta) return { err: response.meta.err };
    await sleep(pollIntervalMs);
  }
  return null;
}

/**
 * Send a transaction that the chain is expected to refuse, past preflight so
 * that the refusal is recorded, and report what was recorded. `unrefused`
 * is what to say if the chain let it through after all.
 */
async function sendToBeRefused(
  context: RailContext,
  instructions: readonly Instruction[],
  unrefused: string,
): Promise<RefusalProbe> {
  const broadcast = await context.sign(instructions);
  const outcome = await sendAndConfirm(context.rpc, broadcast, { ...context.following, skipPreflight: true });
  const { signature } = outcome;
  if (outcome.status === 'expired') {
    return { signature, failedOnChain: false, error: 'the probe expired before it landed' };
  }
  if (outcome.status === 'unknown') {
    return { signature, failedOnChain: false, error: `the outcome of the probe is unknown: ${outcome.reason}` };
  }
  const recorded = await readBackError(context, signature);
  if (!recorded) return { signature, failedOnChain: false, error: 'the probe landed but could not be read back' };
  if (recorded.err === null) return { signature, failedOnChain: false, error: unrefused };
  return { signature, failedOnChain: true, error: describeTransactionError(recorded.err, instructions) };
}

/**
 * Send a transfer of one base unit more than the allowance and report what
 * the chain recorded. The transaction is a memo and the transfer and nothing
 * else: it sets no run marker and creates no token account, so the target
 * must already have one.
 */
export async function probeOverAllowance(
  context: RailContext,
  i: { account: string; to: string },
): Promise<RefusalProbe> {
  const { rpc, mint, decimals, commitment } = context;
  const signer = await context.delegate();
  const source = await associatedTokenAddress(i.account, mint);
  const allowance = delegatedAllowance(await fetchTokenAccount(rpc, source, commitment), signer.address);
  if (allowance >= MAX_TOKEN_AMOUNT) return unsent('the allowance is the largest possible amount');
  if (!isAddress(i.to)) return unsent(`"${i.to}" is not a Solana address`);
  const destination = await associatedTokenAddress(i.to, mint);
  if (!(await fetchTokenAccount(rpc, destination, commitment))) {
    return unsent(
      `${i.to} has no token account for this mint and the probe never creates one; ` +
        'aim it at a payee that has been paid before or at the team wallet itself',
    );
  }
  const instructions = [
    memoInstruction(ALLOWANCE_PROBE_MEMO),
    getTransferCheckedInstruction({ source, mint, destination, authority: signer, amount: allowance + 1n, decimals }),
  ];
  return sendToBeRefused(context, instructions, 'the transfer above the allowance was not refused');
}

/**
 * Send a second payout of a run that is already paid and report that the
 * chain refused it.
 *
 * It cannot pay. Nothing is sent unless the run's marker under the service
 * key in use is read back as set, and a marker that is set stays set: the
 * transaction tries to set it again before any transfer, the System program
 * refuses that, and the transaction fails as a whole. It carries no
 * instruction that creates a token account either.
 */
export async function probeRepeatRun(context: RailContext, i: RunInput): Promise<RefusalProbe> {
  const { rpc, mint, decimals, commitment } = context;
  const request = await identifyRun(context, i);
  if (typeof request === 'string') return unsent(request);
  const { runId, signer, source, payees, marker } = request;

  if (!isMarkerSet(await fetchEncodedAccount(rpc, marker.address, { commitment }))) {
    return unsent(`run ${runId} has no run marker under the service key in use, so a repeat of it could pay; nothing was sent`);
  }
  const plan: PayoutPlan = {
    delegate: signer,
    source,
    mint,
    decimals,
    runId,
    marker,
    markerLamports: 1n,
    lineMemos: false,
    transfers: payees.map(({ wallet, tokenAccount, amount, memo }) => ({
      payee: wallet,
      tokenAccount,
      amount,
      memo,
      createTokenAccount: false,
    })),
  };
  if (!fitsOneTransaction(plan)) return unsent(`run ${runId} does not fit in one transaction`);
  return sendToBeRefused(context, payoutInstructions(plan), 'the repeat of a paid run was not refused');
}
