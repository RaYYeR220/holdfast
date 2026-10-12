import { DataTable, DitherAreaChart, Link, Panel, StateTag, Tag, Unavailable, formatPct } from '@/ui';
import type { BacktestResult } from '../../_lib/backtest';

export interface BacktestViewProps {
  backtest: BacktestResult;
  /** Whether the treasury runs the default policy, which is the one graded. */
  policyIsDefault: boolean;
}

const DAY = 86_400_000;

/**
 * The scorecard of the default policy, compact: each scenario's worst point
 * with the lock and without it, and June replayed as a picture. The landing
 * page holds the full table with every criterion.
 */
export function BacktestView({ backtest, policyIsDefault }: BacktestViewProps) {
  return (
    <Panel title="Backtest scorecard" level={2} aside={<Tag variant="boxed">Default policy</Tag>}>
      {backtest.status !== 'ok' ? (
        <Unavailable reason={backtest.reason} source="the bundled market data" />
      ) : (
        (() => {
          const { scenarios, june } = backtest.data;
          const graded = scenarios.filter((scenario) => !scenario.control);
          const held = graded.filter((scenario) => scenario.pass).length;
          const span = june.to - june.from;
          return (
            <div className="lk-back">
              <div className="lk-back__chart">
                <DitherAreaChart
                  area={{ label: 'Unlocked: the same treasury with no lock', values: june.points.map((point) => 100 + point.unlockedPct), endLabel: `Unlocked ${formatPct(june.unlockedWorstPct)} at worst` }}
                  line={{ label: 'Locked', values: june.points.map((point) => 100 + point.lockedPct), endLabel: `Locked ${formatPct(june.lockedWorstPct)} at worst` }}
                  fillBetween
                  domain={[0, 116]}
                  baseline={100}
                  ticks={[
                    { at: 0, label: 'June 1' },
                    { at: (4 * DAY) / span, label: '5' },
                    { at: (9 * DAY) / span, label: '10' },
                    { at: 1, label: 'June 15' },
                  ]}
                  height={220}
                  label={`One treasury replayed through June 1 to 15, 2026. Unlocked, its dollar value falls ${formatPct(Math.abs(june.unlockedWorstPct))} at worst. Locked, it stays within ${formatPct(Math.abs(june.lockedWorstPct))} of its value on June 1.`}
                  caption="June 1 to 15, 2026, on recorded hourly data. Height is the dollar value of the treasury against its value on June 1; the bottom edge is zero."
                />
              </div>
              <div className="lk-back__table">
                <p>
                  {held} of {graded.length} graded scenarios hold. The windows and the criteria were written before the first run; one more scenario is a control that was written to fail, and does.
                </p>
                <DataTable
                  dense
                  caption="Worst point of the treasury in each scenario, against its value at the start"
                  captionHidden
                  columns={[
                    { key: 'title', header: 'Scenario', rowHeader: true },
                    { key: 'locked', header: 'Locked', numeric: true },
                    { key: 'unlocked', header: 'Unlocked', numeric: true },
                    { key: 'result', header: 'Result' },
                  ]}
                  rows={scenarios.map((scenario) => ({
                    id: scenario.id,
                    cells: {
                      title: <span className="lk-back__name">{scenario.title}</span>,
                      locked: formatPct(scenario.lockedWorstPct, 2),
                      unlocked: formatPct(scenario.unlockedWorstPct, 2),
                      result: scenario.control ? <StateTag state="refused" label="Control" /> : scenario.pass ? <StateTag state="locked" label="Holds" /> : <StateTag state="refused" label="Fails" />,
                    },
                  }))}
                />
                <p className="hf-small">
                  &ldquo;Worst point&rdquo; is the furthest the treasury&rsquo;s dollar value fell below its value at the start of the window. The replay covers price paths on recorded data; it says nothing about liquidity at size.{' '}
                  {policyIsDefault ? 'This treasury runs the default policy, which is the one graded here.' : 'This treasury’s policy differs from the default, so these figures do not grade it.'}
                </p>
                <p>
                  <Link href="/#score" variant="emphasis">
                    The full scorecard, with every criterion
                  </Link>
                </p>
              </div>
            </div>
          );
        })()
      )}
    </Panel>
  );
}
