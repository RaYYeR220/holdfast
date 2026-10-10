import type { PayoutAllowance, PayoutRail } from '@holdfast/core';
import { associatedTokenAddress, delegatedAllowance, fetchTokenAccount } from './accounts';
import { createRailContext, type SolanaPayoutRailConfig } from './context';
import { describeFailure } from './errors';
import type { RunInput } from './prepare';
import { probeOverAllowance } from './probe';
import { findRunOnChain, type PayoutRun } from './reconcile';
import { refused, type AllowanceProbe, type PayoutPreview, type SolanaPayoutResult } from './results';
import { createRunPayer } from './runs';

export interface SolanaPayoutRail extends PayoutRail {
  chain: 'solana';
  /** Address of the service key: what the team approves as delegate. */
  delegate(): Promise<string>;
  /**
   * Pay a run once. A run id that has been paid with the same lines is
   * answered with the transaction that paid it; with different lines it is
   * refused. Read `outcome`, not only `ok`: an `unknown` run may yet be paid.
   * Never throws.
   */
  pay(i: RunInput): Promise<SolanaPayoutResult>;
  /**
   * Everything pay() checks before it sends, without sending: whether the
   * run would go ahead, and what it would cost the service key in rent for
   * new payee token accounts and in fees. Never throws.
   */
  preview(i: RunInput): Promise<PayoutPreview>;
  /** Rebuild a paid run from chain data alone; null when no such run succeeded. */
  findRun(account: string, runId: string): Promise<PayoutRun | null>;
  /**
   * Send a transfer of one base unit more than the allowance and report that
   * the Token program refused it. The transaction skips preflight so the
   * refusal is recorded on chain. If the team raises the allowance between
   * the read and the send, the transfer succeeds and pays `to`; passing the
   * team's own wallet as `to` makes the probe unable to move anything. `to`
   * must already hold a token account: the probe never creates one.
   */
  probeOverAllowance(i: { account: string; to: string }): Promise<AllowanceProbe>;
}

export function createSolanaPayoutRail(config: SolanaPayoutRailConfig): SolanaPayoutRail {
  const context = createRailContext(config);
  const { rpc, mint, commitment } = context;
  const runs = createRunPayer(context);

  return {
    chain: 'solana',

    async delegate(): Promise<string> {
      return (await context.delegate()).address;
    },

    async remaining(account: string): Promise<PayoutAllowance> {
      const signer = await context.delegate();
      const token = await fetchTokenAccount(rpc, await associatedTokenAddress(account, mint), commitment);
      return { remaining: delegatedAllowance(token, signer.address), limit: null, resetsAt: null };
    },

    async pay(i): Promise<SolanaPayoutResult> {
      try {
        return await runs.pay(i);
      } catch (error) {
        return refused(describeFailure(error));
      }
    },

    async preview(i): Promise<PayoutPreview> {
      try {
        return await runs.preview(i);
      } catch (error) {
        return { ok: false, error: describeFailure(error), paidBy: null, lineMemos: false, cost: null };
      }
    },

    async findRun(account: string, runId: string): Promise<PayoutRun | null> {
      const signer = await context.delegate();
      const source = await associatedTokenAddress(account, mint);
      return findRunOnChain(rpc, { runId, source, mint, delegate: signer.address }, commitment);
    },

    async probeOverAllowance(i): Promise<AllowanceProbe> {
      try {
        return await probeOverAllowance(context, i);
      } catch (error) {
        return { signature: null, failedOnChain: false, error: describeFailure(error) };
      }
    },
  };
}
