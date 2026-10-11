import { DEFAULT_POLICY, type Policy, type PolicyValidation, type ScenarioOutcome, scorecard, validatePolicy } from '@holdfast/core';
import { parseArgs, UsageError } from './args';
import type { Env } from './env';

async function loadPolicy(path: string, env: Env): Promise<PolicyValidation> {
  let text: string;
  try {
    text = await env.readFile(path);
  } catch (e) {
    return { ok: false, errors: [`cannot be read: ${e instanceof Error ? e.message : String(e)}`] };
  }
  try {
    return validatePolicy(JSON.parse(text));
  } catch {
    return { ok: false, errors: ['is not valid JSON'] };
  }
}

/** A level, such as cover or margin: "45.1%". */
const share = (bps: number | null) => (bps === null ? 'n/a' : `${(bps / 100).toFixed(1)}%`);

/** A change against the starting value, signed: "-1.2%". */
function move(bps: number): string {
  const tenths = Math.round(bps / 10);
  return `${tenths > 0 ? '+' : tenths < 0 ? '-' : ''}${(Math.abs(tenths) / 10).toFixed(1)}%`;
}

function usd(value: number): string {
  const whole = Math.round(value);
  return `${whole < 0 ? '-' : ''}$${Math.abs(whole).toLocaleString('en-US')}`;
}

function unhedgedEndDriftBps(o: ScenarioOutcome): number {
  return Math.round(((o.result.unhedgedNavEnd - o.result.navStart) / o.result.navStart) * 10_000);
}

function block(o: ScenarioOutcome): string[] {
  const r = o.result;
  return [
    `${o.pass ? 'PASS' : 'FAIL'}  ${o.scenario.id}${o.scenario.control ? '  (control: the lock is expected not to hold)' : ''}`,
    `      ${o.scenario.title}. ${o.scenario.context}`,
    ...o.checks.map((check) => `      [${check.pass ? 'x' : ' '}] ${check.label}`),
    `      locked     worst ${move(-r.maxDrawdownBps)}, end ${move(r.endDriftBps)}`,
    `      unhedged   worst ${move(-r.unhedgedMaxDrawdownBps)}, end ${move(unhedgedEndDriftBps(o))}`,
    `      cover      min ${share(r.minCoverageBps)}, end ${share(r.coverageEndBps)}`,
    `      margin     min ${share(r.minMarginRatioBps)}${r.liquidated ? ', LIQUIDATED' : ''}`,
    `      buy-backs  ${r.deRiskEvents}, top-ups ${r.topUps} (${usd(r.topUpUsd)})`,
    `      funding    ${usd(r.fundingUsd)}; fees ${usd(r.feesUsd)} venue, ${usd(r.swapCostUsd)} swaps, ${usd(r.slippageUsd)} slippage`,
    '',
  ];
}

function asJson(policy: Policy, outcomes: readonly ScenarioOutcome[], ok: boolean): string {
  return JSON.stringify(
    {
      ok,
      policy,
      scenarios: outcomes.map((o) => {
        const { series: _series, ...figures } = o.result;
        return {
          id: o.scenario.id,
          title: o.scenario.title,
          control: o.scenario.control,
          pass: o.pass,
          checks: o.checks,
          result: { ...figures, unhedgedEndDriftBps: unhedgedEndDriftBps(o) },
        };
      }),
    },
    null,
    2,
  );
}

/**
 * The scenarios that decide the verdict. A control is there to show the lock
 * failing where it should, so that a scorecard which cannot fail would be
 * noticed; it is printed with the rest and is not graded.
 */
export function failedScenarios(outcomes: readonly ScenarioOutcome[]): ScenarioOutcome[] {
  return outcomes.filter((o) => !o.scenario.control && !o.pass);
}

/**
 * `holdfast backtest [--policy <file.json>] [--json]`
 *
 * Grades a policy on the scenarios the default one has to pass.
 */
export async function backtest(argv: readonly string[], env: Env): Promise<number> {
  const args = parseArgs(argv, { flags: ['--json'], options: ['--policy'] });
  const [stray] = args.positionals;
  if (stray !== undefined) throw new UsageError(`backtest takes no argument, got "${stray}"`);

  let policy = DEFAULT_POLICY;
  const policyFile = args.one('--policy');
  if (policyFile !== undefined) {
    const loaded = await loadPolicy(policyFile, env);
    if (!loaded.ok) {
      env.err(`Refusing policy ${policyFile}:`);
      for (const error of loaded.errors) env.err(`  ${error}`);
      return 1;
    }
    policy = loaded.policy;
  }

  const outcomes = scorecard(await env.loadBars(), policy);
  const graded = outcomes.filter((o) => !o.scenario.control);
  const failed = failedScenarios(outcomes);
  const ok = failed.length === 0;

  if (args.has('--json')) {
    env.out(asJson(policy, outcomes, ok));
    return ok ? 0 : 1;
  }

  env.out(`Policy: ${policyFile ?? 'the default'}`);
  env.out('');
  for (const outcome of outcomes) for (const line of block(outcome)) env.out(line);
  env.out(
    ok
      ? `All ${graded.length} graded scenarios pass.`
      : `${failed.length} of ${graded.length} graded scenarios fail: ${failed.map((o) => o.scenario.id).join(', ')}.`,
  );
  return ok ? 0 : 1;
}
