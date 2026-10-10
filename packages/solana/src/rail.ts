import type { PayoutAllowance, PayoutRail } from '@holdfast/core';
import { associatedTokenAddress, delegatedAllowance, fetchTokenAccount } from './accounts';
import { createRailContext, type SolanaPayoutRailConfig } from './context';
import { describeFailure } from './errors';
import type { RunInput } from './prepare';
import { probeOverAllowance } from './probe';
import type { PayoutRun } from './reconcile';
import { refused, type AllowanceProbe, type PayoutPreview, type SolanaPayoutResult } from './results';
import { createRunPayer } from './runs';
import { UnprovenAbsence } from './search';

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
  /**
   * A slot that is safely in the past. Record it when a run is created and
   * pass it to pay() and findRun() as `notBefore`: the run cannot have been
   * paid before it, so the search for a payment may stop there.
   */
  checkpoint(): Promise<bigint>;
  /**
   * Rebuild a paid run from chain data alone. Null means the chain proves no
   * such run was paid. When that cannot be established, or the run has not
   * reached the commitment of the rail yet, this throws instead.
   */
  findRun(account: string, runId: string, options?: { notBefore?: bigint }): Promise<PayoutRun | null>;
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

    async checkpoint(): Promise<bigint> {
      // Whatever is sent from now on lands after the slot the chain has already finalized.
      return rpc.getSlot({ commitment: 'finalized' }).send();
    },

    async findRun(account, runId, options = {}): Promise<PayoutRun | null> {
      const source = await associatedTokenAddress(account, mint);
      const found = await context.findPaid({ runId, source }, options.notBefore);
      if (found && !found.settled) {
        const { signature } = found.run;
        throw new UnprovenAbsence(`run ${runId} is on chain as ${signature} but has not reached ${commitment} yet`);
      }
      return found?.run ?? null;
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
