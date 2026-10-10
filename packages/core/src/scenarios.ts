import { type Bar, type BacktestInput, type BacktestResult, backtest } from './backtest';
import { DEFAULT_POLICY, type Policy } from './policy';

/**
 * Scenarios the default policy is graded on, against real Hyperliquid ZEC
 * hourly data. Windows and pass criteria were written down before the first
 * run. When a scenario fails, the policy changes — not the criterion.
 */
export interface Criterion {
  label: string;
  check: (r: BacktestResult, policy: Policy) => boolean;
}

export interface Scenario {
  id: string;
  title: string;
  /** What the window contains, in one line. */
  context: string;
  from: string;
  to: string;
  setup: Pick<BacktestInput, 'topUpDelayHours'> & { lockAt?: string; outages?: { from: string; to: string }[] };
  /** A control is expected to show the lock failing; it guards against a scorecard that cannot fail. */
  control: boolean;
  criteria: Criterion[];
}

export const SCENARIO_DEFAULTS = {
  treasuryZat: 10_000_000_000n, // 100 ZEC
  swapCostBps: 50,
  takerFeeBps: 4.5,
  maintenanceBps: 500,
} as const;

const neverLiquidated: Criterion = { label: 'never liquidated', check: (r) => !r.liquidated };
const drawdownAtMost = (bps: number): Criterion => ({
  label: `locked treasury never more than ${bps / 100}% below its starting value`,
  check: (r) => r.maxDrawdownBps <= bps,
});
const endsFullyCovered: Criterion = { label: 'ends fully hedged', check: (r) => r.coverageEndBps >= 9_900 };

export const SCENARIOS: Scenario[] = [
  {
    id: 'june-crash',
    title: 'June 2026 crash',
    context: 'ZEC falls from about $570 to $247 in days after the Orchard bug.',
    from: '2026-06-01T00:00:00Z',
    to: '2026-06-15T00:00:00Z',
    setup: { topUpDelayHours: null },
    control: false,
    criteria: [
      neverLiquidated,
      { label: 'the unhedged treasury loses at least 30%', check: (r) => r.unhedgedMaxDrawdownBps >= 3_000 },
      drawdownAtMost(300),
      endsFullyCovered,
    ],
  },
  {
    id: 'may-squeeze-unanswered',
    title: 'May 2026 squeeze, treasurer absent',
    context: 'ZEC rises 83% in seven days and nobody tops up margin.',
    from: '2026-04-29T15:00:00Z',
    to: '2026-05-13T15:00:00Z',
    setup: { topUpDelayHours: null },
    control: false,
    criteria: [
      neverLiquidated,
      { label: 'the buy-back ladder fires', check: (r) => r.deRiskEvents > 0 },
      { label: 'margin ratio stays above maintenance', check: (r) => (r.minMarginRatioBps ?? 0) > 500 },
      drawdownAtMost(300),
    ],
  },
  {
    id: 'may-squeeze-answered-6h',
    title: 'May 2026 squeeze, top-ups within 6 hours',
    context: 'Same squeeze; the treasurer approves each top-up request six hours after it is raised.',
    from: '2026-04-29T15:00:00Z',
    to: '2026-05-13T15:00:00Z',
    setup: { topUpDelayHours: 6 },
    control: false,
    criteria: [neverLiquidated, drawdownAtMost(400), endsFullyCovered],
  },
  {
    id: 'squeeze-then-crash-unanswered',
    title: 'Squeeze, then crash, treasurer absent (control)',
    context: 'The May squeeze strips the hedge; the June crash then hits an unprotected treasury.',
    from: '2026-04-29T15:00:00Z',
    to: '2026-06-15T00:00:00Z',
    setup: { topUpDelayHours: null },
    control: true,
    criteria: [
      neverLiquidated,
      { label: 'the lock is NOT expected to hold: drawdown exceeds 15%', check: (r) => r.maxDrawdownBps > 1_500 },
    ],
  },
  {
    id: 'squeeze-then-crash-answered-24h',
    title: 'Squeeze, then crash, top-ups within 24 hours',
    context: 'Same path; the treasurer approves top-ups a day after each request.',
    from: '2026-04-29T15:00:00Z',
    to: '2026-06-15T00:00:00Z',
    setup: { topUpDelayHours: 24 },
    control: false,
    criteria: [neverLiquidated, drawdownAtMost(600), endsFullyCovered],
  },
  {
    id: 'outage-during-crash',
    title: 'Venue unreachable through the worst hour',
    context: 'Twelve hours without venue data, covering the -22.8% hour of June 5.',
    from: '2026-06-01T00:00:00Z',
    to: '2026-06-10T00:00:00Z',
    setup: {
      topUpDelayHours: null,
      outages: [{ from: '2026-06-05T00:00:00Z', to: '2026-06-05T12:00:00Z' }],
    },
    control: false,
    criteria: [
      neverLiquidated,
      { label: 'the controller refuses to act while blind', check: (r) => (r.refusals.STALE_HL ?? 0) > 0 },
      drawdownAtMost(300),
    ],
  },
  {
    id: 'negative-funding',
    title: 'Lock requested while shorts are paying',
    context: 'A lock is requested on June 20, inside a month of negative funding.',
    from: '2026-06-10T00:00:00Z',
    to: '2026-07-20T00:00:00Z',
    setup: { topUpDelayHours: null, lockAt: '2026-06-20T00:00:00Z' },
    control: false,
    criteria: [
      neverLiquidated,
      {
        label: 'no short is opened in an hour whose trailing funding is under the floor',
        check: (r, policy) =>
          r.series.every((pt, k) => {
            const before = r.series[k - 1];
            if (before === undefined || pt.shortLots <= before.shortLots) return true;
            return before.fundingAprBps >= policy.fundingFloorAprBps;
          }),
      },
    ],
  },
  {
    id: 'april-wick',
    title: 'Largest one-hour spike',
    context: 'The +15.5% hour of April 7.',
    from: '2026-04-06T00:00:00Z',
    to: '2026-04-09T00:00:00Z',
    setup: { topUpDelayHours: null },
    control: false,
    criteria: [neverLiquidated, { label: 'no buy-back needed', check: (r) => r.deRiskEvents === 0 }, endsFullyCovered],
  },
  {
    id: 'full-tape-answered-24h',
    title: 'Whole history, top-ups within 24 hours',
    context: 'March to October 2026: $229 to $1,695 and back to $1,227.',
    from: '2026-03-16T03:00:00Z',
    to: '2026-10-10T12:00:00Z',
    setup: { topUpDelayHours: 24 },
    control: false,
    criteria: [neverLiquidated, drawdownAtMost(800)],
  },
];

export interface ScenarioOutcome {
  scenario: Scenario;
  result: BacktestResult;
  checks: { label: string; pass: boolean }[];
  pass: boolean;
}

const ms = (iso: string) => Date.parse(iso);

export function runScenario(s: Scenario, bars: Bar[], policy: Policy = DEFAULT_POLICY): ScenarioOutcome {
  const window = bars.filter((b) => b.t >= ms(s.from) && b.t < ms(s.to));
  const result = backtest({
    bars: window,
    policy,
    ...SCENARIO_DEFAULTS,
    topUpDelayHours: s.setup.topUpDelayHours,
    ...(s.setup.lockAt === undefined ? {} : { lockAt: ms(s.setup.lockAt) }),
    ...(s.setup.outages === undefined
      ? {}
      : { outages: s.setup.outages.map((o) => ({ from: ms(o.from), to: ms(o.to) })) }),
  });
  const checks = s.criteria.map((c) => ({ label: c.label, pass: c.check(result, policy) }));
  return { scenario: s, result, checks, pass: checks.every((c) => c.pass) };
}

export function scorecard(bars: Bar[], policy: Policy = DEFAULT_POLICY): ScenarioOutcome[] {
  return SCENARIOS.map((s) => runScenario(s, bars, policy));
}
