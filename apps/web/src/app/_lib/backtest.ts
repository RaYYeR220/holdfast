import { cache } from 'react';
import { scorecardOf, seriesOf } from '@/server/backtest/service';
import { runtime } from '@/server/runtime';

/**
 * The backtest as the pages draw it: the scorecard of the nine scenarios, and
 * the June replay, the control and the whole price history thinned to what a
 * picture can show. Everything is computed on the server from the bundled
 * hourly data, through the same service the /api/backtest routes use.
 */

export interface ScenarioRow {
  id: string;
  title: string;
  context: string;
  /** A control is written to show the lock failing. */
  control: boolean;
  pass: boolean;
  /** Worst point of the locked treasury against its starting value, in percent; zero or negative. */
  lockedWorstPct: number;
  /** The same for the treasury left alone. */
  unlockedWorstPct: number;
  topUps: number;
  buyBacks: number;
  endCoveragePct: number;
  checks: { label: string; pass: boolean }[];
}

export interface ReplayPoint {
  t: number;
  px: number;
  /** Value of the locked treasury against its starting value, in percent. */
  lockedPct: number;
  unlockedPct: number;
  /** Share of the treasury the hedge covers, in percent. */
  coveragePct: number;
}

export interface Replay {
  from: number;
  to: number;
  startPx: number;
  lockedWorstPct: number;
  unlockedWorstPct: number;
  points: ReplayPoint[];
}

export interface Backtest {
  scenarios: ScenarioRow[];
  /** June 1 to 15, every two hours, with the lowest price of the fortnight and its hour. */
  june: Replay & { lowPx: number; lowAt: number };
  /** The control, April 29 to June 15, every six hours. */
  control: Replay & { maxPx: number };
  /** The scenario on the control's path with top-ups approved within a day. */
  answered: ScenarioRow;
  /** One close a day over the whole history, with its first, highest and last price. */
  tape: { points: { t: number; px: number }[]; firstPx: number; highPx: number; lastPx: number };
}

const JUNE = 'june-crash';
const CONTROL = 'squeeze-then-crash-unanswered';
const ANSWERED = 'squeeze-then-crash-answered-24h';

const round2 = (n: number) => Math.round(n * 100) / 100;

async function build(): Promise<Backtest> {
  const deps = runtime();
  const [card, bars] = await Promise.all([scorecardOf(deps), deps.bars()]);

  const scenarios: ScenarioRow[] = card.scenarios.map((s) => ({
    id: s.id,
    title: s.title,
    context: s.context,
    control: s.control,
    pass: s.pass,
    lockedWorstPct: -s.result.maxDrawdownBps / 100,
    unlockedWorstPct: -s.result.unhedgedMaxDrawdownBps / 100,
    topUps: s.result.topUps,
    buyBacks: s.result.deRiskEvents,
    endCoveragePct: Math.round(s.result.coverageEndBps / 100),
    checks: s.checks,
  }));
  const rowOf = (id: string): ScenarioRow => {
    const row = scenarios.find((s) => s.id === id);
    if (row === undefined) throw new Error(`the scorecard has no scenario ${id}`);
    return row;
  };
  const navStartOf = (id: string): number => {
    const scenario = card.scenarios.find((s) => s.id === id);
    if (scenario === undefined) throw new Error(`the scorecard has no scenario ${id}`);
    return scenario.result.navStart;
  };

  const replay = async (id: string, everyHours: number): Promise<Replay> => {
    const series = await seriesOf(deps, id);
    const navStart = navStartOf(id);
    const row = rowOf(id);
    const first = series.points[0];
    const window = bars.filter((bar) => bar.t >= Date.parse(series.from) && bar.t < Date.parse(series.to));
    return {
      from: Date.parse(series.from),
      to: Date.parse(series.to),
      startPx: window[0]?.o ?? first?.px ?? 0,
      lockedWorstPct: row.lockedWorstPct,
      unlockedWorstPct: row.unlockedWorstPct,
      points: series.points
        .filter((_, index) => index % everyHours === 0 || index === series.points.length - 1)
        .map((p) => ({
          t: p.t,
          px: p.px,
          lockedPct: round2((p.nav / navStart - 1) * 100),
          unlockedPct: round2((p.unhedgedNav / navStart - 1) * 100),
          coveragePct: Math.round(p.coverageBps / 100),
        })),
    };
  };

  const [june, control] = await Promise.all([replay(JUNE, 2), replay(CONTROL, 6)]);

  let low = { px: Number.POSITIVE_INFINITY, at: june.from };
  for (const bar of bars) if (bar.t >= june.from && bar.t < june.to && bar.l < low.px) low = { px: bar.l, at: bar.t };

  let highPx = 0;
  for (const bar of bars) highPx = Math.max(highPx, bar.h);
  const firstBar = bars[0];
  const lastBar = bars.at(-1);
  if (firstBar === undefined || lastBar === undefined) throw new Error('the market data is empty');

  return {
    scenarios,
    june: { ...june, lowPx: low.px, lowAt: low.at },
    control: { ...control, maxPx: Math.max(...control.points.map((p) => p.px)) },
    answered: rowOf(ANSWERED),
    tape: {
      points: bars.filter((_, index) => index % 24 === 0).map((bar) => ({ t: bar.t, px: bar.c })),
      firstPx: firstBar.o,
      highPx,
      lastPx: lastBar.c,
    },
  };
}

export type BacktestResult = { status: 'ok'; data: Backtest } | { status: 'unavailable'; reason: string };

/** The backtest, computed once for a request. A failure is returned as a reason, not thrown. */
export const loadBacktest = cache(async (): Promise<BacktestResult> => {
  try {
    return { status: 'ok', data: await build() };
  } catch (error) {
    const deps = runtime();
    return { status: 'unavailable', reason: deps.redact(error instanceof Error ? error.message : String(error)) };
  }
});
