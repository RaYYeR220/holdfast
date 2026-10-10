import type { PayoutAllowance, PayoutLine, PayoutRail, PayoutResult } from '@holdfast/core';
import {
  address,
  fetchEncodedAccounts,
  isAddress,
  MAX_SUPPORTED_TRANSACTION_VERSION,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type KeyPairSigner,
  type Signature,
  type TransactionError,
} from '@solana/kit';
import { AccountState } from '@solana-program/token';
import { associatedTokenAddress, delegatedAllowance, fetchTokenAccount, isOwnedByTokenProgram } from './accounts';
import { formatBaseUnits, MAX_TOKEN_AMOUNT } from './amounts';
import { payoutTransactionSize, TRANSACTION_SIZE_LIMIT } from './capacity';
import { sendAndConfirm, sleep, type SendOutcome } from './confirm';
import { connect, loadKeyPairSigner, type RpcSource, type SettledCommitment } from './connection';
import { describeFailure, describeTransactionError } from './errors';
import { validateMemo } from './memo';
import {
  fitsOneTransaction,
  payoutInstructions,
  payoutMessage,
  payoutShape,
  type PayoutPlan,
  type PayoutTransfer,
} from './payout';
import { findRunOnChain, type PayoutRun } from './reconcile';

export interface SolanaPayoutRailConfig extends RpcSource {
  /** Mint of the token being paid out. */
  mint: string;
  decimals: number;
  /**
   * The service key, as bytes or base58. It is the delegate that moves the
   * tokens and the fee payer: it needs SOL for fees and for the rent of any
   * payee token account a run has to create.
   */
  delegateSecretKey: Uint8Array | string;
  /** How settled chain state must be before the rail relies on it. Defaults to `confirmed`. */
  commitment?: SettledCommitment;
  /** How often to ask the node whether a sent transaction has settled, ms. */
  pollIntervalMs?: number;
}

export interface SolanaPayoutResult extends PayoutResult {
  /** Whether each line's memo went on chain. False when only the run memo fit. */
  lineMemos: boolean;
}

export interface AllowanceProbe {
  /** The probe transaction, or null when none was sent. */
  signature: string | null;
  /** True only when the transaction was read back from the chain with an error. */
  failedOnChain: boolean;
  error: string | null;
}

export interface SolanaPayoutRail extends PayoutRail {
  chain: 'solana';
  /** Address of the service key: what the team approves as delegate. */
  delegate(): Promise<string>;
  pay(i: { account: string; lines: PayoutLine[]; runId: string }): Promise<SolanaPayoutResult>;
  /** Rebuild a paid run from chain data alone; null when no such run succeeded. */
  findRun(account: string, runId: string): Promise<PayoutRun | null>;
  /**
   * Send a transfer of one base unit more than the allowance and report that
   * the Token program refused it. The transaction skips preflight so the
   * refusal is recorded on chain. If the team raises the allowance between
   * the read and the send, the transfer succeeds and pays `to`; passing the
   * team's own wallet as `to` makes the probe unable to move anything.
   */
  probeOverAllowance(i: { account: string; to: string }): Promise<AllowanceProbe>;
}

const PROBE_MEMO = 'holdfast allowance probe';
const READ_BACK_ATTEMPTS = 10;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

function refusal(error: string): SolanaPayoutResult {
  return { ok: false, tx: null, error, lineMemos: false };
}

function describeRunProblem(lines: readonly PayoutLine[], runId: string): string | null {
  const runIdProblem = validateMemo(runId);
  if (runIdProblem) return `run id: ${runIdProblem}`;
  if (lines.length === 0) return 'run has no lines';
  for (const [index, line] of lines.entries()) {
    if (line.amount <= 0n || line.amount > MAX_TOKEN_AMOUNT) return `line ${index + 1}: invalid amount ${line.amount}`;
    const memoProblem = line.memo === '' ? null : validateMemo(line.memo);
    if (memoProblem) return `line ${index + 1}: ${memoProblem}`;
  }
  return null;
}

export function createSolanaPayoutRail(config: SolanaPayoutRailConfig): SolanaPayoutRail {
  const rpc = connect(config);
  const mint = address(config.mint);
  const { decimals } = config;
  const commitment = config.commitment ?? 'confirmed';
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const format = (units: bigint): string => formatBaseUnits(units, decimals);

  let loadedKey: Promise<KeyPairSigner> | undefined;
  const delegate = (): Promise<KeyPairSigner> => (loadedKey ??= loadKeyPairSigner(config.delegateSecretKey));

  /** The team's token account and what the service key may still move out of it. */
  async function readSource(account: string) {
    const signer = await delegate();
    const source = await associatedTokenAddress(account, mint);
    const token = await fetchTokenAccount(rpc, source, commitment);
    return { signer, source, token, allowance: delegatedAllowance(token, signer.address) };
  }

  /**
   * Turn payout lines into transfers: derive each payee's token account and
   * find out which of them still have to be created.
   */
  async function resolveTransfers(
    lines: readonly PayoutLine[],
    source: Address,
    allowSource = false,
  ): Promise<PayoutTransfer[] | string> {
    const payees: { line: PayoutLine; wallet: Address; tokenAccount: Address }[] = [];
    for (const [index, line] of lines.entries()) {
      if (!isAddress(line.to)) return `line ${index + 1}: "${line.to}" is not a Solana address`;
      const tokenAccount = await associatedTokenAddress(line.to, mint);
      if (tokenAccount === source && !allowSource) return `line ${index + 1}: the payee is the paying account itself`;
      payees.push({ line, wallet: line.to, tokenAccount });
    }
    const [wallets, tokenAccounts] = await Promise.all([
      fetchEncodedAccounts(rpc, payees.map(payee => payee.wallet), { commitment }),
      fetchEncodedAccounts(rpc, payees.map(payee => payee.tokenAccount), { commitment }),
    ]);

    const created = new Set<Address>();
    const transfers: PayoutTransfer[] = [];
    for (const [index, { line, wallet, tokenAccount }] of payees.entries()) {
      // An address that is itself a token account or a mint could never
      // spend from a token account opened in its name.
      if (isOwnedByTokenProgram(wallets[index])) {
        return `line ${index + 1}: ${wallet} is a token account or mint, not a wallet`;
      }
      const missing = !isOwnedByTokenProgram(tokenAccounts[index]);
      transfers.push({
        payee: wallet,
        tokenAccount,
        amount: line.amount,
        memo: line.memo,
        createTokenAccount: missing && !created.has(tokenAccount),
      });
      if (missing) created.add(tokenAccount);
    }
    return transfers;
  }

  async function send(plan: PayoutPlan, skipPreflight: boolean): Promise<SendOutcome> {
    const { value: lifetime } = await rpc.getLatestBlockhash({ commitment }).send();
    const message = setTransactionMessageLifetimeUsingBlockhash(lifetime, payoutMessage(plan));
    const transaction = await signTransactionMessageWithSigners(message);
    return sendAndConfirm(rpc, transaction, {
      commitment,
      skipPreflight,
      pollIntervalMs,
      lastValidBlockHeight: lifetime.lastValidBlockHeight,
    });
  }

  async function executeRun(i: { account: string; lines: PayoutLine[]; runId: string }): Promise<SolanaPayoutResult> {
    const problem = describeRunProblem(i.lines, i.runId);
    if (problem) return refusal(problem);

    const { signer, source, token, allowance } = await readSource(i.account);
    const total = i.lines.reduce((sum, line) => sum + line.amount, 0n);
    if (total > allowance) {
      return refusal(`exceeds delegated allowance: run needs ${format(total)}, ${format(allowance)} remaining`);
    }
    if (token?.state === AccountState.Frozen) return refusal('the paying token account is frozen');
    if (token && total > token.amount) {
      return refusal(`insufficient token balance: run needs ${format(total)}, account holds ${format(token.amount)}`);
    }

    const transfers = await resolveTransfers(i.lines, source);
    if (typeof transfers === 'string') return refusal(transfers);

    const withoutLineMemos: PayoutPlan = {
      delegate: signer,
      source,
      mint,
      decimals,
      runId: i.runId,
      transfers,
      lineMemos: false,
    };
    const candidates = i.lines.some(line => line.memo !== '')
      ? [{ ...withoutLineMemos, lineMemos: true }, withoutLineMemos]
      : [withoutLineMemos];
    const plan = candidates.find(fitsOneTransaction);
    if (!plan) {
      return refusal(
        `run does not fit in one transaction: ${i.lines.length} lines need about ` +
          `${payoutTransactionSize(payoutShape(withoutLineMemos))} bytes even without line memos, ` +
          `the limit is ${TRANSACTION_SIZE_LIMIT}; split it into smaller runs`,
      );
    }

    const instructions = payoutInstructions(plan);
    let outcome: SendOutcome;
    try {
      outcome = await send(plan, false);
    } catch (error) {
      return refusal(describeFailure(error, instructions));
    }
    switch (outcome.status) {
      case 'landed':
        return outcome.err === null
          ? { ok: true, tx: outcome.signature, error: null, lineMemos: plan.lineMemos }
          : {
              ok: false,
              tx: outcome.signature,
              error: describeTransactionError(outcome.err, instructions),
              lineMemos: false,
            };
      case 'expired':
        return refusal(`transaction ${outcome.signature} expired before it landed; nothing was paid`);
      case 'unknown':
        return refusal(
          `transaction ${outcome.signature} may have been sent and its outcome is unknown (${outcome.reason}); ` +
            'look the run up before paying it again',
        );
    }
  }

  /** The error the node recorded for a landed transaction; null when the node will not show the transaction. */
  async function readBackError(signature: Signature): Promise<{ err: TransactionError | null } | null> {
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

  async function probe(i: { account: string; to: string }): Promise<AllowanceProbe> {
    const unsent = (error: string): AllowanceProbe => ({ signature: null, failedOnChain: false, error });
    const { signer, source, allowance } = await readSource(i.account);
    if (allowance >= MAX_TOKEN_AMOUNT) return unsent('the allowance is the largest possible amount');
    const transfers = await resolveTransfers([{ to: i.to, amount: allowance + 1n, memo: '' }], source, true);
    if (typeof transfers === 'string') return unsent(transfers);

    const plan: PayoutPlan = {
      delegate: signer,
      source,
      mint,
      decimals,
      runId: PROBE_MEMO,
      transfers,
      lineMemos: false,
    };
    const outcome = await send(plan, true);
    const { signature } = outcome;
    if (outcome.status === 'expired') {
      return { signature, failedOnChain: false, error: 'the probe expired before it landed' };
    }
    if (outcome.status === 'unknown') {
      return { signature, failedOnChain: false, error: `the outcome of the probe is unknown: ${outcome.reason}` };
    }
    const recorded = await readBackError(signature);
    if (!recorded) return { signature, failedOnChain: false, error: 'the probe landed but could not be read back' };
    if (recorded.err === null) {
      return { signature, failedOnChain: false, error: 'the transfer above the allowance was not refused' };
    }
    return { signature, failedOnChain: true, error: describeTransactionError(recorded.err, payoutInstructions(plan)) };
  }

  return {
    chain: 'solana',

    async delegate(): Promise<string> {
      return (await delegate()).address;
    },

    async remaining(account: string): Promise<PayoutAllowance> {
      return { remaining: (await readSource(account)).allowance, limit: null, resetsAt: null };
    },

    async pay(i): Promise<SolanaPayoutResult> {
      try {
        return await executeRun(i);
      } catch (error) {
        return refusal(describeFailure(error));
      }
    },

    async findRun(account: string, runId: string): Promise<PayoutRun | null> {
      const signer = await delegate();
      const source = await associatedTokenAddress(account, mint);
      return findRunOnChain(rpc, { runId, source, mint, delegate: signer.address }, commitment);
    },

    async probeOverAllowance(i): Promise<AllowanceProbe> {
      try {
        return await probe(i);
      } catch (error) {
        return { signature: null, failedOnChain: false, error: describeFailure(error) };
      }
    },
  };
}
