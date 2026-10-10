import { isAddress, MAX_SUPPORTED_TRANSACTION_VERSION, type Signature, type TransactionError } from '@solana/kit';
import { associatedTokenAddress, delegatedAllowance, fetchTokenAccount } from './accounts';
import { MAX_TOKEN_AMOUNT } from './amounts';
import { sendAndConfirm, sleep } from './confirm';
import type { RailContext } from './context';
import { describeTransactionError } from './errors';
import { payoutInstructions, type PayoutPlan } from './payout';
import type { AllowanceProbe } from './results';

const PROBE_MEMO = 'holdfast allowance probe';
const READ_BACK_ATTEMPTS = 10;

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
 * Send a transfer of one base unit more than the allowance, past preflight,
 * and report what the chain recorded. The transaction is a memo and the
 * transfer and nothing else: it never creates a token account, so the target
 * must already have one.
 */
export async function probeOverAllowance(
  context: RailContext,
  i: { account: string; to: string },
): Promise<AllowanceProbe> {
  const { rpc, mint, decimals, commitment } = context;
  const unsent = (error: string): AllowanceProbe => ({ signature: null, failedOnChain: false, error });

  const signer = await context.delegate();
  const source = await associatedTokenAddress(i.account, mint);
  const allowance = delegatedAllowance(await fetchTokenAccount(rpc, source, commitment), signer.address);
  if (allowance >= MAX_TOKEN_AMOUNT) return unsent('the allowance is the largest possible amount');
  if (!isAddress(i.to)) return unsent(`"${i.to}" is not a Solana address`);
  const tokenAccount = await associatedTokenAddress(i.to, mint);
  if (!(await fetchTokenAccount(rpc, tokenAccount, commitment))) {
    return unsent(
      `${i.to} has no token account for this mint and the probe never creates one; ` +
        'aim it at a payee that has been paid before or at the team wallet itself',
    );
  }

  const plan: PayoutPlan = {
    delegate: signer,
    source,
    mint,
    decimals,
    runId: PROBE_MEMO,
    lineMemos: false,
    transfers: [{ payee: i.to, tokenAccount, amount: allowance + 1n, memo: '', createTokenAccount: false }],
  };
  const outcome = await sendAndConfirm(rpc, await context.sign(plan), { ...context.following, skipPreflight: true });
  const { signature } = outcome;
  if (outcome.status === 'expired') {
    return { signature, failedOnChain: false, error: 'the probe expired before it landed' };
  }
  if (outcome.status === 'unknown') {
    return { signature, failedOnChain: false, error: `the outcome of the probe is unknown: ${outcome.reason}` };
  }
  const recorded = await readBackError(context, signature);
  if (!recorded) return { signature, failedOnChain: false, error: 'the probe landed but could not be read back' };
  if (recorded.err === null) {
    return { signature, failedOnChain: false, error: 'the transfer above the allowance was not refused' };
  }
  return { signature, failedOnChain: true, error: describeTransactionError(recorded.err, payoutInstructions(plan)) };
}
