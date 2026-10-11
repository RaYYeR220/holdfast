import { fetchEncodedAccounts } from '@solana/kit';
import { follow, sendAndConfirm, type Broadcast, type SendOutcome } from './confirm';
import type { RailContext } from './context';
import { COST_OF_FAILED_TRANSACTION, type PayoutCost } from './cost';
import {
  customErrorOf,
  describeFailure,
  describeTransactionError,
  simulatedCustomError,
  type CustomError,
} from './errors';
import { isMarkerSet, MARKER_INSTRUCTION_INDEX, MARKER_TAKEN_ERROR_CODE } from './marker';
import { isSameRequest, type Payee } from './payees';
import { payoutInstructions, type PayoutPlan } from './payout';
import { identifyRun, prepareRun, type RunInput, type RunRequest } from './prepare';
import { isSameRun, type PaidLine } from './reconcile';
import { refused, type PayoutPreview, type SolanaPayoutResult } from './results';
import type { FoundRun } from './search';

/** A transaction that was sent for a run, kept until its fate is known. */
interface Attempt {
  broadcast: Broadcast;
  plan: PayoutPlan;
  cost: PayoutCost;
  payees: Payee[];
}

/** A payment of a run as read from the chain, as far as telling it from another request takes. */
interface PaidRun {
  tx: string;
  transfers: readonly PaidLine[];
  /** Known only when this rail paid the run itself. */
  cost: PayoutCost | null;
}

const REMEMBERED_RUNS = 1_000;
/**
 * Transactions the history is read for before a run is sent. History only
 * has to catch a payment made without a marker, so a little is spent on it
 * and a crowded history is left unread rather than allowed to hold a run up.
 */
const INSPECTIONS_BEFORE_PAYING = 10;

/** What a paid plan looks like when it is read back from the chain. */
function paidLines(plan: PayoutPlan): PaidLine[] {
  return plan.transfers.map(({ tokenAccount, amount, memo }) => ({
    tokenAccount,
    amount,
    memo: plan.lineMemos && memo !== '' ? memo : null,
  }));
}

/** Whether a transaction failed where it sets its run marker, which only a marker that is already set causes. */
function foundMarkerTaken(error: CustomError | null): boolean {
  return error !== null && error.index === MARKER_INSTRUCTION_INDEX && error.code === MARKER_TAKEN_ERROR_CODE;
}

/**
 * Paying runs so that each run id is paid once.
 *
 * The chain enforces that: a payout sets a run marker in the same
 * transaction, and the System program will not set one twice (marker.ts). So
 * a run is paid if its marker is set, and a payout sent for a paid run fails
 * as a whole. Everything else here saves a wasted transaction or describes a
 * payment; none of it is needed for the run to be paid only once.
 *
 * History is read for two things a marker cannot give: which transaction
 * paid a run and with what lines, and whether a run was paid without a
 * marker, by the team by hand or by a build that did not set markers yet.
 * Anyone can write to that history, so failing to read it never stops a
 * payment; the result then says so in `historyError`.
 */
export function createRunPayer(context: RailContext) {
  const { rpc, commitment, following } = context;

  /** Calls to pay() that have not returned yet, so that a second one waits instead of sending a doomed copy. */
  const underway = new Map<string, { payees: Payee[]; result: Promise<SolanaPayoutResult> }>();
  /** Attempts whose outcome was still unknown when pay() returned; the next call follows them first. */
  const unsettled = new Map<string, Attempt>();
  /** Payments this rail has seen, so that it can describe them again without asking. */
  const paidRuns = new Map<string, PaidRun>();
  const keyOf = (request: RunRequest): string => `${request.source}:${request.runId}`;

  function remember(key: string, paid: PaidRun): PaidRun {
    paidRuns.set(key, paid);
    const [oldest] = paidRuns.keys();
    if (paidRuns.size > REMEMBERED_RUNS && oldest !== undefined) paidRuns.delete(oldest);
    return paid;
  }

  /** Whether the run is marked paid under this service key or an earlier one, and what its marker address holds. */
  async function readMarkers({ marker, earlierMarkers }: RunRequest): Promise<{ set: boolean; lamports: bigint }> {
    const addresses = [marker.address, ...earlierMarkers.map(earlier => earlier.address)];
    const accounts = await fetchEncodedAccounts(rpc, addresses, { commitment });
    const [own] = accounts;
    return { set: accounts.some(isMarkerSet), lamports: own?.exists ? own.lamports : 0n };
  }

  /** Read the history for a payment of the run; an unreadable history is an answer of its own, not an error. */
  async function readHistory(
    { runId, source, notBefore }: RunRequest,
    maxInspections?: number,
  ): Promise<{ found: FoundRun | null; error: string | null }> {
    try {
      return { found: await context.findPaid({ runId, source }, notBefore, maxInspections), error: null };
    } catch (error) {
      return { found: null, error: describeFailure(error) };
    }
  }

  /**
   * Answer a request for a run whose payment is known: with its transaction,
   * or with a refusal if the lines differ. `outrun` is a payout this call
   * sent and the chain turned away, when there was one.
   */
  function answerPaid({ runId, payees }: RunRequest, paid: PaidRun, outrun?: string): SolanaPayoutResult {
    if (!isSameRun(paid.transfers, payees)) {
      const sent = outrun ? `transaction ${outrun} was sent for these, failed, and moved nothing` : 'nothing was sent';
      return refused(`run ${runId} was already paid by ${paid.tx} with different lines; ${sent}`);
    }
    return {
      ok: true,
      outcome: 'paid',
      tx: paid.tx,
      error: null,
      replayed: true,
      lineMemos: paid.transfers.some(transfer => transfer.memo !== null),
      cost: paid.cost,
      historyError: null,
    };
  }

  /** Answer a request for a run whose payment is on chain but has not settled: neither paid nor unpaid yet. */
  function answerPending({ runId, payees }: RunRequest, { run }: FoundRun): SolanaPayoutResult {
    if (!isSameRun(run.transfers, payees)) {
      const error = `run ${runId} is already on chain as ${run.signature} with different lines; nothing was sent for these`;
      return refused(error);
    }
    return {
      ok: false,
      outcome: 'unknown',
      tx: run.signature,
      error: `run ${runId} is on chain as ${run.signature} but has not reached ${commitment} yet`,
      replayed: true,
      lineMemos: run.transfers.some(transfer => transfer.memo !== null),
      cost: null,
      historyError: null,
    };
  }

  /**
   * Answer a request for a run whose marker is set. That it is paid is
   * settled; history is only asked which transaction paid it.
   */
  async function answerMarked(request: RunRequest, outrun?: string): Promise<SolanaPayoutResult> {
    const { runId, source } = request;
    const history = await readHistory(request);
    if (history.found) {
      const { signature, transfers } = history.found.run;
      return answerPaid(request, remember(keyOf(request), { tx: signature, transfers, cost: null }), outrun);
    }
    const reason = history.error ?? `the history of ${source} shows no payment under that run id`;
    return {
      ok: true,
      outcome: 'paid',
      tx: null,
      error: null,
      replayed: true,
      lineMemos: false,
      cost: null,
      historyError: `run ${runId} is marked paid on chain, but its payment could not be read: ${reason}`,
    };
  }

  /** Report where an attempt stands, and stop tracking it once that is final. */
  function conclude(
    key: string,
    { plan, cost }: Attempt,
    outcome: SendOutcome,
    replayed: boolean,
    historyError: string | null,
  ): SolanaPayoutResult {
    const { signature } = outcome;
    const base = { replayed, cost, historyError };
    if (outcome.status === 'unknown') {
      const error =
        `transaction ${signature} was sent and its outcome is unknown (${outcome.reason}); ` +
        'it may still pay the run';
      return { ...base, ok: false, outcome: 'unknown', tx: signature, error, lineMemos: plan.lineMemos };
    }
    unsettled.delete(key);
    if (outcome.status === 'expired') {
      const error = `transaction ${signature} expired without landing; nothing was paid`;
      return { ...base, ok: false, outcome: 'failed', tx: null, error, lineMemos: false };
    }
    if (outcome.err !== null) {
      const error = describeTransactionError(outcome.err, payoutInstructions(plan));
      return { ...base, ok: false, outcome: 'failed', tx: signature, error, lineMemos: false };
    }
    remember(key, { tx: signature, transfers: paidLines(plan), cost });
    return { ...base, ok: true, outcome: 'paid', tx: signature, error: null, lineMemos: plan.lineMemos };
  }

  /**
   * Follow a transaction an earlier call sent and could not confirm. Returns
   * null when it is certain to have paid nothing, so that sending is safe.
   */
  async function settleUnsettled(request: RunRequest, earlier: Attempt): Promise<SolanaPayoutResult | null> {
    const key = keyOf(request);
    const outcome = await follow(rpc, earlier.broadcast, following);
    if (outcome.status === 'landed' && foundMarkerTaken(customErrorOf(outcome.err))) {
      unsettled.delete(key);
      return answerMarked(request);
    }
    if (outcome.status === 'expired' || (outcome.status === 'landed' && outcome.err !== null)) {
      unsettled.delete(key);
      return null;
    }
    if (!isSameRequest(earlier.payees, request.payees)) {
      const { runId } = request;
      return refused(`run ${runId} was already sent as ${outcome.signature} with different lines; nothing was sent for these`);
    }
    return conclude(key, earlier, outcome, true, null);
  }

  async function payOnce(request: RunRequest): Promise<SolanaPayoutResult> {
    const key = keyOf(request);
    const remembered = paidRuns.get(key);
    if (remembered) return answerPaid(request, remembered);

    const markers = await readMarkers(request);
    if (markers.set) {
      unsettled.delete(key);
      return answerMarked(request);
    }

    const earlier = unsettled.get(key);
    const settled = earlier ? await settleUnsettled(request, earlier) : null;
    if (settled) return settled;

    const history = await readHistory(request, INSPECTIONS_BEFORE_PAYING);
    if (history.found) {
      if (!history.found.settled) return answerPending(request, history.found);
      const { signature, transfers } = history.found.run;
      return answerPaid(request, remember(key, { tx: signature, transfers, cost: null }));
    }

    const prepared = await prepareRun(context, request, markers.lamports);
    if ('error' in prepared) return { ...refused(prepared.error, prepared.cost), historyError: history.error };
    const { plan, cost } = prepared;

    const broadcast = await context.sign(payoutInstructions(plan));
    const attempt: Attempt = { broadcast, plan, cost, payees: request.payees };
    unsettled.set(key, attempt);
    let outcome: SendOutcome;
    try {
      outcome = await sendAndConfirm(rpc, attempt.broadcast, { ...following, skipPreflight: false });
    } catch (error) {
      unsettled.delete(key);
      // The simulation found the marker set: the run was paid between the look above and now.
      if (foundMarkerTaken(simulatedCustomError(error))) return answerMarked(request);
      return { ...refused(describeFailure(error, payoutInstructions(plan)), cost), historyError: history.error };
    }
    if (outcome.status === 'landed' && foundMarkerTaken(customErrorOf(outcome.err))) {
      // Another payout of this run landed first. This one failed as a whole: it moved nothing and cost its fee.
      unsettled.delete(key);
      return { ...(await answerMarked(request, outcome.signature)), cost: COST_OF_FAILED_TRANSACTION };
    }
    return conclude(key, attempt, outcome, false, history.error);
  }

  return {
    /** Throws only for failures before anything was sent. */
    async pay(i: RunInput): Promise<SolanaPayoutResult> {
      const request = await identifyRun(context, i);
      if (typeof request === 'string') return refused(request);

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
      const request = await identifyRun(context, i);
      if (typeof request === 'string') {
        return { ok: false, error: request, alreadyPaid: false, paidBy: null, lineMemos: false, cost: null, historyError: null };
      }
      const key = keyOf(request);
      /** A paid run is only ever turned down for having been paid with other lines. */
      const paid = (result: SolanaPayoutResult): PayoutPreview => {
        const paidBy = result.tx ?? paidRuns.get(key)?.tx ?? null;
        return {
          ok: result.ok,
          error: result.ok ? null : `run ${request.runId} was already paid by ${paidBy} with different lines`,
          alreadyPaid: true,
          paidBy,
          lineMemos: result.lineMemos,
          cost: result.cost,
          historyError: result.historyError,
        };
      };

      const remembered = paidRuns.get(key);
      if (remembered) return paid(answerPaid(request, remembered));
      const markers = await readMarkers(request);
      if (markers.set) return paid(await answerMarked(request));

      const history = await readHistory(request, INSPECTIONS_BEFORE_PAYING);
      const turnedDown = (error: string, cost: PayoutCost | null): PayoutPreview => ({
        ok: false,
        error,
        alreadyPaid: false,
        paidBy: null,
        lineMemos: false,
        cost,
        historyError: history.error,
      });
      if (history.found) {
        if (!history.found.settled) {
          const pending = answerPending(request, history.found);
          return { ...turnedDown(pending.error ?? '', null), paidBy: history.found.run.signature };
        }
        const { signature, transfers } = history.found.run;
        return paid(answerPaid(request, remember(key, { tx: signature, transfers, cost: null })));
      }
      const earlier = unsettled.get(key);
      if (earlier) {
        const { signature } = earlier.broadcast;
        return turnedDown(`transaction ${signature} was sent for run ${request.runId} and is not settled yet`, earlier.cost);
      }
      const prepared = await prepareRun(context, request, markers.lamports);
      if ('error' in prepared) return turnedDown(prepared.error, prepared.cost);
      return {
        ok: true,
        error: null,
        alreadyPaid: false,
        paidBy: null,
        lineMemos: prepared.plan.lineMemos,
        cost: prepared.cost,
        historyError: history.error,
      };
    },
  };
}
