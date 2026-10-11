import { type BacktestPoint, DEFAULT_POLICY, type Policy, type ScenarioOutcome, scorecard } from '@holdfast/core';
import type { Deps } from '../deps';
import { notFound, unavailable } from '../errors';
import { messageOf } from '../redact';

type BacktestDeps = Pick<Deps, 'bars' | 'redact'>;

/**
 * The graded scenarios are replayed over the bundled market data once for
 * each set of dependencies, which in a running server means once per
 * process. A replay that failed is not remembered.
 */
const replays = new WeakMap<BacktestDeps, Promise<ScenarioOutcome[]>>();

async function outcomes(deps: BacktestDeps): Promise<ScenarioOutcome[]> {
  let replay = replays.get(deps);
  if (replay === undefined) {
    replay = deps.bars().then((bars) => scorecard([...bars], DEFAULT_POLICY));
    replays.set(deps, replay);
  }
  try {
    return await replay;
  } catch (error) {
    if (replays.get(deps) === replay) replays.delete(deps);
    throw unavailable('the market data', deps.redact(messageOf(error)));
  }
}

export interface ScenarioCard {
  id: string;
  title: string;
  context: string;
  from: string;
  to: string;
  /** A control is expected to show the lock failing; it is shown and not graded. */
  control: boolean;
  pass: boolean;
  checks: { label: string; pass: boolean }[];
  result: Omit<ScenarioOutcome['result'], 'series'> & { unhedgedEndDriftBps: number };
}

export interface Scorecard {
  policy: Policy;
  /** True when every graded scenario passes. */
  ok: boolean;
  scenarios: ScenarioCard[];
}

/** How the default policy fares on each scenario it is graded on, without the hour-by-hour series. */
export async function scorecardOf(deps: BacktestDeps): Promise<Scorecard> {
  const all = await outcomes(deps);
  return {
    policy: DEFAULT_POLICY,
    ok: all.every((outcome) => outcome.scenario.control || outcome.pass),
    scenarios: all.map((outcome) => {
      const { series: _series, ...figures } = outcome.result;
      const { scenario } = outcome;
      return {
        id: scenario.id,
        title: scenario.title,
        context: scenario.context,
        from: scenario.from,
        to: scenario.to,
        control: scenario.control,
        pass: outcome.pass,
        checks: outcome.checks,
        result: { ...figures, unhedgedEndDriftBps: Math.round(((figures.unhedgedNavEnd - figures.navStart) / figures.navStart) * 10_000) },
      };
    }),
  };
}

/** One scenario hour by hour, for charts. An id that names no scenario is not found. */
export async function seriesOf(deps: BacktestDeps, scenarioId: string): Promise<{ id: string; title: string; from: string; to: string; points: BacktestPoint[] }> {
  const outcome = (await outcomes(deps)).find((candidate) => candidate.scenario.id === scenarioId);
  if (outcome === undefined) throw notFound();
  const { scenario } = outcome;
  return { id: scenario.id, title: scenario.title, from: scenario.from, to: scenario.to, points: outcome.result.series };
}
