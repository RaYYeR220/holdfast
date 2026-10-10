import { follow, sendAndConfirm, type Broadcast, type SendOutcome } from './confirm';
import type { RailContext } from './context';
import type { PayoutCost } from './cost';
import { describeFailure, describeTransactionError } from './errors';
import { isSameRequest, type Payee } from './payees';
import { payoutInstructions, type PayoutPlan } from './payout';
import { identifyRun, prepareRun, type RunInput, type RunRequest } from './prepare';
import { findRunOnChain, isSameRun, type PaidLine } from './reconcile';
import { refused, type PayoutPreview, type SolanaPayoutResult } from './results';

/** A transaction that was sent for a run, kept until its fate is known. */
interface Attempt {
  broadcast: Broadcast;
  plan: PayoutPlan;
  cost: PayoutCost;
  payees: Payee[];
}

/** A run that is on chain, as far as telling it from another request takes. */
interface PaidRun {
  tx: string;
  transfers: readonly PaidLine[];
  /** Known only when this rail paid the run itself. */
  cost: PayoutCost | null;
}

const REMEMBERED_RUNS = 1_000;

/** What a paid plan looks like when it is read back from the chain. */
function paidLines(plan: PayoutPlan): PaidLine[] {
  return plan.transfers.map(({ tokenAccount, amount, memo }) => ({
    tokenAccount,
    amount,
    memo: plan.lineMemos && memo !== '' ? memo : null,
  }));
}

/**
 * Paying runs so that each run id is paid once. Three things stand between
 * a request and a second payment, each keyed by team token account and run
 * id: the calls still in progress, the transactions sent but not yet
 * settled, and the runs known to be paid. Behind all three is the chain,
 * which is asked before anything is sent.
 */
export function createRunPayer(context: RailContext) {
  const { rpc, mint, commitment, following } = context;

  /** Calls to pay() that have not returned yet. */
  const underway = new Map<string, { payees: Payee[]; result: Promise<SolanaPayoutResult> }>();
  /**
   * Attempts whose outcome was still unknown when pay() returned. A second
   * pay() for the same run follows the transaction already sent instead of
   * sending another while the first can still land.
   */
  const unsettled = new Map<string, Attempt>();
  /**
   * Runs this rail has seen paid. The chain stays the record; remembering
   * only keeps a node that lags behind it from answering "never heard of
   * it" about a run this rail has just paid.
   */
  const paidRuns = new Map<string, PaidRun>();
  const keyOf = (request: RunRequest): string => `${request.source}:${request.runId}`;

  function remember(key: string, paid: PaidRun): PaidRun {
    paidRuns.set(key, paid);
    const [oldest] = paidRuns.keys();
    if (paidRuns.size > REMEMBERED_RUNS && oldest !== undefined) paidRuns.delete(oldest);
    return paid;
  }

  /** The run as paid, from memory or else from the chain. Throws when the chain cannot be asked. */
  async function lookUpPaid(request: RunRequest): Promise<PaidRun | null> {
    const key = keyOf(request);
    const remembered = paidRuns.get(key);
    if (remembered) return remembered;
    const { runId, source, signer } = request;
    const found = await findRunOnChain(rpc, { runId, source, mint, delegate: signer.address }, commitment);
    return found ? remember(key, { tx: found.signature, transfers: found.transfers, cost: null }) : null;
  }

  /** Answer a request for a run that has been paid: with its transaction, or with a refusal if the lines differ. */
  function answerPaid({ runId, payees }: RunRequest, paid: PaidRun): SolanaPayoutResult {
    if (!isSameRun(paid.transfers, payees)) {
      return refused(`run ${runId} was already paid by ${paid.tx} with different lines; nothing was sent`);
    }
    const lineMemos = paid.transfers.some(transfer => transfer.memo !== null);
    return { ok: true, outcome: 'paid', tx: paid.tx, error: null, replayed: true, lineMemos, cost: paid.cost };
  }

  /** Report where an attempt stands, and stop tracking it once that is final. */
  function conclude(key: string, attempt: Attempt, outcome: SendOutcome, replayed: boolean): SolanaPayoutResult {
    const { plan, cost } = attempt;
    const { signature } = outcome;
    if (outcome.status === 'unknown') {
      const error =
        `transaction ${signature} was sent and its outcome is unknown (${outcome.reason}); ` +
        'it may still pay the run';
      return { ok: false, outcome: 'unknown', tx: signature, error, replayed, lineMemos: plan.lineMemos, cost };
    }
    unsettled.delete(key);
    if (outcome.status === 'expired') {
      const error = `transaction ${signature} expired without landing; nothing was paid`;
      return { ok: false, outcome: 'failed', tx: null, error, replayed, lineMemos: false, cost };
    }
    if (outcome.err !== null) {
      const error = describeTransactionError(outcome.err, payoutInstructions(plan));
      return { ok: false, outcome: 'failed', tx: signature, error, replayed, lineMemos: false, cost };
    }
    remember(key, { tx: signature, transfers: paidLines(plan), cost });
    return { ok: true, outcome: 'paid', tx: signature, error: null, replayed, lineMemos: plan.lineMemos, cost };
  }

  /**
   * Settle a run that this call must not send again: one that has been paid,
   * or one an earlier call sent and could not confirm. Returns null when the
   * run is new, or when its earlier attempt is certain to have paid nothing,
   * so that sending is safe.
   */
  async function settleEarlier(request: RunRequest): Promise<SolanaPayoutResult | null> {
    const { runId } = request;
    const key = keyOf(request);
    let paid: PaidRun | null;
    try {
      paid = await lookUpPaid(request);
    } catch (error) {
      // Not knowing is not the same as not paid.
      return refused(`could not check whether run ${runId} was already paid (${describeFailure(error)}); nothing was sent`);
    }
    if (paid) {
      unsettled.delete(key);
      return answerPaid(request, paid);
    }

    const earlier = unsettled.get(key);
    if (!earlier) return null;
    const outcome = await follow(rpc, earlier.broadcast, following);
    if (outcome.status === 'expired' || (outcome.status === 'landed' && outcome.err !== null)) {
      unsettled.delete(key);
      return null;
    }
    if (outcome.status === 'landed') {
      unsettled.delete(key);
      const { plan, cost } = earlier;
      return answerPaid(request, remember(key, { tx: outcome.signature, transfers: paidLines(plan), cost }));
    }
    if (!isSameRequest(earlier.payees, request.payees)) {
      return refused(
        `run ${runId} was already sent as ${outcome.signature} with different lines; nothing was sent for these`,
      );
    }
    return conclude(key, earlier, outcome, true);
  }

  async function payOnce(request: RunRequest): Promise<SolanaPayoutResult> {
    const settled = await settleEarlier(request);
    if (settled) return settled;

    const prepared = await prepareRun(context, request);
    if ('error' in prepared) return refused(prepared.error, prepared.cost);
    const { plan, cost } = prepared;

    const key = keyOf(request);
    const attempt: Attempt = { broadcast: await context.sign(plan), plan, cost, payees: request.payees };
    unsettled.set(key, attempt);
    let outcome: SendOutcome;
    try {
      outcome = await sendAndConfirm(rpc, attempt.broadcast, { ...following, skipPreflight: false });
    } catch (error) {
      unsettled.delete(key);
      return refused(describeFailure(error, payoutInstructions(plan)), cost);
    }
    return conclude(key, attempt, outcome, false);
  }

  return {
    /** Throws only for failures before anything was sent. */
    async pay(i: RunInput): Promise<SolanaPayoutResult> {
      const request = await identifyRun(context, i);
      if (typeof request === 'string') return refused(request);

      // Two calls for one run that overlap would both find it unpaid and both
      // send it, so the second waits for the answer of the first.
      const key = keyOf(request);
      const running = underway.get(key);
      if (running) {
        if (!isSameRequest(running.payees, request.payees)) {
          return refused(`run ${request.runId} is being paid right now with different lines; nothing was sent for these`);
        }
        const first = await running.result;
        return first.outcome === 'refused' ? first : { ...first, replayed: true };
      }
      const result = payOnce(request);
      underway.set(key, { payees: request.payees, result });
      try {
        return await result;
      } finally {
        underway.delete(key);
      }
    },

    async preview(i: RunInput): Promise<PayoutPreview> {
      const turnedDown = (error: string, cost: PayoutCost | null = null): PayoutPreview => ({
        ok: false,
        error,
        paidBy: null,
        lineMemos: false,
        cost,
      });
      const request = await identifyRun(context, i);
      if (typeof request === 'string') return turnedDown(request);

      const paid = await lookUpPaid(request);
      if (paid) {
        const same = isSameRun(paid.transfers, request.payees);
        return {
          ok: same,
          error: same ? null : `run ${request.runId} was already paid by ${paid.tx} with different lines`,
          paidBy: paid.tx,
          lineMemos: paid.transfers.some(transfer => transfer.memo !== null),
          cost: paid.cost,
        };
      }
      const earlier = unsettled.get(keyOf(request));
      if (earlier) {
        const { signature } = earlier.broadcast;
        return turnedDown(`transaction ${signature} was sent for run ${request.runId} and is not settled yet`, earlier.cost);
      }
      const prepared = await prepareRun(context, request);
      if ('error' in prepared) return turnedDown(prepared.error, prepared.cost);
      return { ok: true, error: null, paidBy: null, lineMemos: prepared.plan.lineMemos, cost: prepared.cost };
    },
  };
}
