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
import type { PaidLine } from './reconcile';
import { refused, type PayoutPreview, type SolanaPayoutResult } from './results';
import type { FoundRun } from './search';
import {
  answerTaken,
  previewTaken,
  standingOfPaid,
  standingOfPending,
  standingUnread,
  type PaidRun,
  type Standing,
} from './standing';

/** A transaction that was sent for a run, kept until its fate is known. */
interface Attempt {
  broadcast: Broadcast;
  plan: PayoutPlan;
  cost: PayoutCost;
  payees: Payee[];
}

const REMEMBERED_RUNS = 1_000;
/**
 * Transactions the history is read for before a run is sent whose missing
 * marker already shows it unpaid. History then only has to catch a payment
 * made by hand, so a little is spent on it and a crowded history is left
 * unread rather than allowed to hold the run up.
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

const unproven = (runId: string, reason: string): string =>
  `could not rule out that run ${runId} was already paid: ${reason}`;

/**
 * Paying runs so that each run id is paid once.
 *
 * A payout sets a run marker in the same transaction, and the System
 * program will not set one twice (marker.ts). What follows from a marker,
 * and what does not, is the whole of the logic here.
 *
 * - A marker that is set shows that a payout under the run id landed, and
 *   the chain will let no other land. It does not show what was paid. A run
 *   is answered as paid only when its payment was read from history and paid
 *   the lines asked for; read and different, it is refused; unread, the
 *   answer is `unknown` and nothing is sent.
 * - A marker that is missing shows that the service has not paid the run
 *   only if the run cannot be older than the markers: the rail names a slot,
 *   `markersFrom`, and the run a `notBefore` at or after it. Then history is
 *   read as far as a few transactions go, and failing to read it does not
 *   stop the run. Anyone can crowd that history, which is why.
 * - For any other run a missing marker shows nothing. It may have been paid
 *   before markers existed, and the run is sent only once history proves
 *   that it was not.
 */
export function createRunPayer(context: RailContext) {
  const { rpc, commitment, following } = context;

  /** Calls to pay() that have not returned yet, so that a second one waits instead of sending a doomed copy. */
  const underway = new Map<string, { payees: Payee[]; result: Promise<SolanaPayoutResult> }>();
  /** Attempts whose outcome was still unknown when pay() returned; the next call follows them first. */
  const unsettled = new Map<string, Attempt>();
  /** Payments this rail has made or read, so that it can describe them again without asking. */
  const paidRuns = new Map<string, PaidRun>();
  const keyOf = (request: RunRequest): string => `${request.source}:${request.runId}`;

  function remember(key: string, paid: PaidRun): PaidRun {
    paidRuns.set(key, paid);
    const [oldest] = paidRuns.keys();
    if (paidRuns.size > REMEMBERED_RUNS && oldest !== undefined) paidRuns.delete(oldest);
    return paid;
  }

  /** Whether a missing marker shows that the service has not paid this run; see `markersFrom`. */
  const markerDecides = ({ notBefore }: RunRequest): boolean =>
    context.markersFrom !== null && notBefore !== undefined && notBefore >= context.markersFrom;

  /** Whether the run is marked under this service key or an earlier one, and what its marker address holds. */
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

  /** How a payment read from history stands to a request. */
  function standingOfFound(request: RunRequest, found: FoundRun): Standing {
    if (!found.settled) return standingOfPending(request, found, commitment);
    const { signature, transfers } = found.run;
    return standingOfPaid(request, remember(keyOf(request), { tx: signature, transfers, cost: null }));
  }

  /** How a run whose marker is set stands to a request: that takes reading the payout that set it. */
  async function standingOfMarked(request: RunRequest): Promise<Standing> {
    const history = await readHistory(request);
    if (history.found) return standingOfFound(request, history.found);
    return standingUnread(request, history.error ?? `the history of ${request.source} shows no payment under that run id`);
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
      return answerTaken(await standingOfMarked(request));
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
    if (remembered) return answerTaken(standingOfPaid(request, remembered));

    const markers = await readMarkers(request);
    if (markers.set) {
      unsettled.delete(key);
      return answerTaken(await standingOfMarked(request));
    }

    const earlier = unsettled.get(key);
    const settled = earlier ? await settleUnsettled(request, earlier) : null;
    if (settled) return settled;

    const decided = markerDecides(request);
    const history = await readHistory(request, decided ? INSPECTIONS_BEFORE_PAYING : undefined);
    if (history.found) return answerTaken(standingOfFound(request, history.found));
    if (history.error !== null && !decided) {
      const error = `${unproven(request.runId, history.error)}; nothing was sent`;
      return { ...refused(error), historyError: history.error };
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
      // The simulation found the marker set: a payout of the run landed between the look above and now.
      if (foundMarkerTaken(simulatedCustomError(error))) return answerTaken(await standingOfMarked(request));
      return { ...refused(describeFailure(error, payoutInstructions(plan)), cost), historyError: history.error };
    }
    if (outcome.status === 'landed' && foundMarkerTaken(customErrorOf(outcome.err))) {
      // Another payout of this run landed first. This one failed as a whole: it moved nothing and cost its fee.
      unsettled.delete(key);
      const answer = answerTaken(await standingOfMarked(request), outcome.signature);
      return { ...answer, cost: COST_OF_FAILED_TRANSACTION };
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
      const free = { alreadyPaid: false, spent: false, paidBy: null };
      if (typeof request === 'string') {
        return { ...free, ok: false, error: request, lineMemos: false, cost: null, historyError: null };
      }
      const key = keyOf(request);
      const remembered = paidRuns.get(key);
      if (remembered) return previewTaken(standingOfPaid(request, remembered));
      const markers = await readMarkers(request);
      if (markers.set) return previewTaken(await standingOfMarked(request));

      const decided = markerDecides(request);
      const history = await readHistory(request, decided ? INSPECTIONS_BEFORE_PAYING : undefined);
      if (history.found) return previewTaken(standingOfFound(request, history.found));
      const turnedDown = (error: string, cost: PayoutCost | null): PayoutPreview => ({
        ...free,
        ok: false,
        error,
        lineMemos: false,
        cost,
        historyError: history.error,
      });
      if (history.error !== null && !decided) return turnedDown(unproven(request.runId, history.error), null);

      const earlier = unsettled.get(key);
      if (earlier) {
        const { signature } = earlier.broadcast;
        return turnedDown(`transaction ${signature} was sent for run ${request.runId} and is not settled yet`, earlier.cost);
      }
      const prepared = await prepareRun(context, request, markers.lamports);
      if ('error' in prepared) return turnedDown(prepared.error, prepared.cost);
      const { plan, cost } = prepared;
      return { ...free, ok: true, error: null, lineMemos: plan.lineMemos, cost, historyError: history.error };
    },
  };
}
