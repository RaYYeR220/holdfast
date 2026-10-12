import type { Advisory, Decision, RefusalCode } from '@holdfast/core';
import { type JournalEntry, tick } from '@holdfast/engine';
import type { Hex } from 'viem';
import { ATTEST_BUDGET_MS, type OrgAttestation, attestOrganisation } from '../attestations/service';
import type { Deps } from '../deps';
import { type SwapRefresh, refreshSwap } from '../funding/service';
import { messageOf } from '../redact';

/** How many organisations are ticked at once. Each holds a database connection or two and a scan stream. */
export const TICK_CONCURRENCY = 4;
/**
 * How long one invocation works before it stops starting things, ms. It sits
 * well inside the 300 seconds the route asks the platform for, so the answer
 * is sent before the platform cuts the request off.
 */
export const TICK_BUDGET_MS = 240_000;
/** Swaps looked at per invocation; the ones not looked at for longest come first. */
export const SWAPS_PER_TICK = 20;
/**
 * How much longer than the time an attestation was given its answer is waited
 * for, ms, and never longer than that time again. Within its time the step
 * answers for itself; this only covers the moment it takes to do so.
 */
const ATTEST_GRACE_MS = 5_000;

export type OrgTick =
  | {
      orgId: string;
      status: 'ran';
      seq: number;
      at: number;
      mode: Decision['mode'];
      refusals: RefusalCode[];
      advisories: Advisory['kind'][];
      order: { side: 'buy' | 'sell'; lots: number; ok: boolean; filledLots: number; error: string | null } | null;
      /** Sources the tick could not read, and why. */
      unread: { source: JournalEntry['errors'][number]['source']; message: string }[];
    }
  /** Another tick holds the organisation; this one left it alone. */
  | { orgId: string; status: 'busy' }
  | { orgId: string; status: 'failed'; error: string }
  /** Not started: the time for this invocation had run out. */
  | { orgId: string; status: 'skipped'; reason: string };

export interface TickReport {
  startedAt: number;
  finishedAt: number;
  orgs: OrgTick[];
  swaps: SwapRefresh[];
  /** What the attestation step did for each organisation whose tick ran; empty where this deployment records no attestations. */
  attestations: OrgAttestation[];
}

export interface TickOptions {
  concurrency?: number;
  budgetMs?: number;
  swapLimit?: number;
  /** The most one organisation's attestation may take, ms. */
  attestBudgetMs?: number;
}

const OUT_OF_TIME = 'the time allowed for this invocation ran out';

/** `work`, or `late` if it has not settled within `ms`. The work itself is not stopped; nothing can stop it. */
async function within<T>(ms: number, work: Promise<T>, late: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(late()), Math.max(0, ms));
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function summary(entry: JournalEntry, deps: Pick<Deps, 'redact'>): OrgTick {
  const { order } = entry;
  return {
    orgId: entry.orgId,
    status: 'ran',
    seq: entry.seq,
    at: entry.at,
    mode: entry.decision.mode,
    refusals: entry.decision.refusals.map((refusal) => refusal.code),
    advisories: entry.advisories.map((advisory) => advisory.kind),
    order:
      order === null
        ? null
        : {
            side: order.side,
            lots: order.lots,
            ok: order.result.ok,
            filledLots: order.result.filledLots,
            error: order.result.error === null ? null : deps.redact(order.result.error),
          },
    unread: entry.errors.map((error) => ({ source: error.source, message: deps.redact(error.message) })),
  };
}

/** One tick of one organisation, with the venue signing as that organisation's agent. Whatever goes wrong stays here. */
async function tickOrg(deps: Deps, orgId: string): Promise<OrgTick> {
  try {
    const agent = await deps.store.activeKey(orgId, 'hl_agent');
    // Without an agent key the venue can still be read; an order the controller asks for is then recorded as not sent.
    const venue = deps.hyperliquid.venue(agent === null ? undefined : (agent.secret as Hex));
    const outcome = await tick(orgId, { store: deps.store, scanner: deps.zcash.scanner(), venue, reference: deps.reference, now: deps.now });
    return outcome.ran ? summary(outcome.entry, deps) : { orgId, status: 'busy' };
  } catch (error) {
    return { orgId, status: 'failed', error: deps.redact(messageOf(error)) };
  }
}

/**
 * Tick every organisation, a few at a time, and then ask the swap service
 * about the swaps that have not settled.
 *
 * An organisation whose tick fails is reported and the rest go on. Once the
 * budget is spent nothing new is started: organisations not reached are
 * reported as skipped, and one still running is reported as failed, since its
 * journal entry was not seen. Its lease on the organisation runs out on its
 * own.
 *
 * Where attestations are recorded, an organisation's attestation step starts
 * once its tick has run. It has its own bounded time and is collected at the
 * end, so it holds up neither the next organisation's tick nor the answer,
 * and nothing it does can change what is reported of the tick.
 */
export async function runTick(deps: Deps, options: TickOptions = {}): Promise<TickReport> {
  const startedAt = deps.now();
  const budgetMs = options.budgetMs ?? TICK_BUDGET_MS;
  const remaining = () => budgetMs - (deps.now() - startedAt);

  let attests = false;
  try {
    attests = deps.attestor !== null;
  } catch (error) {
    // A setting of the attestations that cannot be used switches them off; it does not cost anyone their tick.
    deps.report(`attestations are off: ${deps.redact(messageOf(error))}`);
  }
  const attesting = new Map<string, Promise<OrgAttestation>>();
  const attest = (orgId: string): Promise<OrgAttestation> => {
    const budget = Math.min(options.attestBudgetMs ?? ATTEST_BUDGET_MS, remaining());
    if (budget <= 0) return Promise.resolve({ orgId, status: 'skipped', reason: OUT_OF_TIME });
    const late = (): OrgAttestation => ({ orgId, status: 'unavailable', reason: `${OUT_OF_TIME} before the attestation finished` });
    // The step answers for its own failures. Should it reject all the same, that is an answer too, and it is
    // taken here, where the promise is made, so that it is never left unhandled while the ticks go on.
    const step = attestOrganisation(deps, orgId, { budgetMs: budget }).catch((): OrgAttestation => ({ orgId, status: 'unavailable', reason: 'the attestation step failed' }));
    return within(budget + Math.min(ATTEST_GRACE_MS, budget), step, late);
  };

  const orgIds = await deps.store.listOrgIds();
  const results = new Map<string, OrgTick>();
  const queue = [...orgIds];
  const worker = async () => {
    for (let orgId = queue.shift(); orgId !== undefined; orgId = queue.shift()) {
      const id = orgId;
      if (remaining() <= 0) {
        results.set(id, { orgId: id, status: 'skipped', reason: OUT_OF_TIME });
        continue;
      }
      const outcome = await within(remaining(), tickOrg(deps, id), (): OrgTick => ({ orgId: id, status: 'failed', error: `${OUT_OF_TIME} before the tick finished` }));
      results.set(id, outcome);
      // Started and not waited for here: the next organisation in the queue does not stand behind a chain.
      if (attests && outcome.status === 'ran') attesting.set(id, attest(id));
    }
  };
  const workers = Math.max(1, Math.min(options.concurrency ?? TICK_CONCURRENCY, orgIds.length));
  await Promise.all(Array.from({ length: workers }, worker));

  const swaps: SwapRefresh[] = [];
  try {
    for (const swap of await deps.store.unsettledSwaps(options.swapLimit ?? SWAPS_PER_TICK)) {
      if (remaining() <= 0) break;
      const late = (): SwapRefresh => ({ swapId: swap.id, orgId: swap.orgId, status: 'unavailable', reason: OUT_OF_TIME });
      swaps.push(await within(remaining(), refreshSwap(deps, swap), late));
    }
  } catch (error) {
    // The list of swaps could not be read; the ticks above are still worth reporting.
    deps.report(`swaps were not refreshed: ${deps.redact(messageOf(error))}`);
  }

  const attestations = await Promise.all(orgIds.flatMap((orgId) => attesting.get(orgId) ?? []));

  return { startedAt, finishedAt: deps.now(), orgs: orgIds.map((orgId) => results.get(orgId) ?? { orgId, status: 'skipped', reason: OUT_OF_TIME }), swaps, attestations };
}
