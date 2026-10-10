/**
 * Runs every graded scenario against the bundled market data and prints the
 * scorecard.
 *
 *   pnpm --filter @holdfast/core scorecard
 */
import { readFileSync } from 'node:fs';
import type { Bar } from '../src/backtest';
import { scorecard } from '../src/scenarios';

const data = JSON.parse(readFileSync(new URL('../data/zec-1h.json', import.meta.url), 'utf8')) as { bars: Bar[] };
const pct = (bps: number | null) => (bps === null ? 'n/a' : `${(bps / 100).toFixed(1)}%`);

let failed = 0;
for (const o of scorecard(data.bars)) {
  const r = o.result;
  if (!o.pass) failed++;
  console.log(`\n${o.pass ? 'PASS' : 'FAIL'}  ${o.scenario.id}${o.scenario.control ? '  (control)' : ''}`);
  console.log(`      ${o.scenario.context}`);
  for (const c of o.checks) console.log(`      ${c.pass ? '[x]' : '[ ]'} ${c.label}`);
  console.log(
    `      locked: worst ${pct(-r.maxDrawdownBps)}, end ${pct(r.endDriftBps)} | unhedged: worst ${pct(-r.unhedgedMaxDrawdownBps)}` +
      ` | cover: min ${pct(r.minCoverageBps)}, end ${pct(r.coverageEndBps)} | min margin ${pct(r.minMarginRatioBps)}` +
      ` | buy-backs ${r.deRiskEvents}, top-ups ${r.topUps} ($${r.topUpUsd.toFixed(0)})` +
      ` | funding $${r.fundingUsd.toFixed(0)}, fees $${r.feesUsd.toFixed(0)}, swaps $${r.swapCostUsd.toFixed(0)}, slippage $${r.slippageUsd.toFixed(0)}`,
  );
}
console.log(`\n${failed === 0 ? 'All scenarios pass.' : `${failed} scenario(s) fail.`}`);
process.exitCode = failed === 0 ? 0 : 1;
