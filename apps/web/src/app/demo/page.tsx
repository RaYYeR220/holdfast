import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import type { Reading } from '@/server/reading';
import { CopyButton, DataTable, KeyValue, Panel, SectionHeading, Stat, type StatProps, StateTag, Tag, Timestamp, Unavailable, formatBps, formatNumber, formatUsd, shorten } from '@/ui';
import { type Failure, loadDemo } from '../_lib/demo';
import './overview.css';

export const metadata: Metadata = { title: 'Overview' };

/** Names of the sources as a reader knows them. */
const SOURCE: Record<string, string> = {
  zcash: 'Zcash',
  hyperliquid: 'Hyperliquid',
  'zcash+hyperliquid': 'Zcash and Hyperliquid',
  journal: 'the journal',
  database: 'the database',
};
const sourceName = (source: string) => SOURCE[source] ?? source;

type Shown = Pick<StatProps, 'figure' | 'unit' | 'note' | 'state'>;

/**
 * One reading as a stat: its figure with the time it was read and where,
 * or, when the read failed, the reason in the figure's place.
 */
function ReadingStat<T>({ label, reading, failure, now, size, show }: { label: string; reading: Reading<T> | null; failure: Failure | null; now: number; size?: StatProps['size']; show: (value: T) => Shown }) {
  const sized = size === undefined ? {} : { size };
  if (reading === null) {
    const why = failure ?? { source: 'database', reason: 'the demo treasury could not be read', at: now };
    return <Stat label={label} now={now} unavailable={{ reason: why.reason, source: sourceName(why.source), at: why.at }} {...sized} />;
  }
  if (reading.status !== 'ok') {
    return <Stat label={label} now={now} unavailable={{ reason: reading.reason, source: sourceName(reading.source), at: reading.readAt }} {...sized} />;
  }
  return <Stat label={label} now={now} asOf={reading.readAt} source={sourceName(reading.source)} {...show(reading.value)} {...sized} />;
}

/** A bar for a share between nothing and all, with its figure. */
function ShareBar({ label, share, text }: { label: string; share: number; text: string }) {
  const width = `${Math.max(0, Math.min(100, share)).toFixed(1)}%`;
  return (
    <div className="ov-share">
      <span className="hf-px">{label}</span>
      <span className="ov-share__track hf-pat-limit">
        <i className="hf-pat-locked" style={{ width }} />
      </span>
      <span className="hf-px">{text}</span>
    </div>
  );
}

export default async function DemoOverviewPage() {
  const demo = await loadDemo();
  const now = Date.now();
  const overview = demo.status === 'ok' ? demo.overview : null;
  const failure = demo.status === 'ok' ? null : { source: demo.source, reason: demo.reason, at: demo.at };

  const lock: ReactNode =
    overview === null ? <StateTag state="stale" label="Lock unknown" boxed /> : overview.lockEnabled ? <StateTag state="locked" label="Lock on" boxed /> : <StateTag state="unlocked" label="Lock off" boxed />;

  const coverage = overview?.coverage ?? null;
  const journal = demo.status === 'ok' ? demo.journal : null;
  const tick = overview?.lastTick ?? null;

  return (
    <div className="hf-stack">
      <SectionHeading level={1} size="page" title="Overview" lead="What the treasury holds, how much of its dollar value is locked, and when each figure was read. Anyone can read this page. Nobody can change anything from it." />

      <Panel framed title="Locked runway" level={2} aside={lock}>
        <div className="ov-lock">
          <ReadingStat
            label="Dollar value fixed by the short"
            size="large"
            reading={overview?.locked ?? null}
            failure={failure}
            now={now}
            show={(v) => ({ figure: formatUsd(v.usd), note: `${formatNumber(v.zec, 2)} ZEC of the treasury, ${v.lots} ${v.lots === 1 ? 'lot' : 'lots'} of short perpetual.`, state: v.lots > 0 ? 'locked' : 'unlocked' })}
          />
          <div className="ov-lock__side">
            <p className="hf-px">Coverage</p>
            {coverage === null || coverage.status !== 'ok' ? (
              <Unavailable
                reason={coverage === null ? (failure?.reason ?? 'the demo treasury could not be read') : coverage.reason}
                source={sourceName(coverage === null ? (failure?.source ?? 'database') : coverage.source)}
                at={coverage === null ? (failure?.at ?? now) : coverage.readAt}
                now={now}
              />
            ) : (
              <>
                {coverage.value.bps === null ? (
                  <p>The policy calls for no short at this balance, so there is nothing to cover.</p>
                ) : (
                  <ShareBar label="Short" share={coverage.value.bps / 100} text={formatBps(coverage.value.bps)} />
                )}
                <p className="hf-small">
                  The short against what the policy calls for: {coverage.value.targetLots} {coverage.value.targetLots === 1 ? 'lot' : 'lots'}.
                </p>
                <p className="hf-small ov-asof">
                  as of <Timestamp at={coverage.readAt} now={now} />, from {sourceName(coverage.source)}
                </p>
              </>
            )}
          </div>
        </div>
      </Panel>

      <div className="hf-grid hf-grid--4">
        <Panel>
          <ReadingStat label="Treasury" reading={overview?.treasury ?? null} failure={failure} now={now} show={(v) => ({ figure: v.zec, unit: 'ZEC', note: 'Shielded balance, read with the viewing key.' })} />
        </Panel>
        <Panel>
          <ReadingStat
            label="Short"
            reading={overview?.hedge ?? null}
            failure={failure}
            now={now}
            show={(v) => ({ figure: formatNumber(v.shortZec, 2), unit: 'ZEC', note: `${formatUsd(v.notionalUsd)} at a mark of ${formatUsd(v.markPx)}. Account value ${formatUsd(v.accountValueUsd)}.` })}
          />
        </Panel>
        <Panel>
          <ReadingStat
            label="Margin ratio"
            reading={overview?.marginRatio ?? null}
            failure={failure}
            now={now}
            show={(v) => (v.bps === null ? { figure: 'No short', note: 'There is no short to hold margin against.' } : { figure: formatBps(v.bps), note: 'Equity over the notional of the short.' })}
          />
        </Panel>
        <Panel>
          <ReadingStat
            label="Funding"
            reading={overview?.funding ?? null}
            failure={failure}
            now={now}
            show={(v) => ({ figure: formatBps(v.aprBps), unit: 'a year', note: v.aprBps < 0 ? 'Trailing rate. Shorts are paying it.' : 'Trailing rate, paid to shorts. Not guaranteed.' })}
          />
        </Panel>
      </div>

      <div className="hf-grid ov-lower">
        <Panel title="Last tick" level={2} {...(tick !== null && tick.status === 'ok' ? { aside: <Tag variant="solid">{tick.value.mode}</Tag> } : {})}>
          {tick === null || tick.status !== 'ok' ? (
            <Unavailable
              reason={tick === null ? (failure?.reason ?? 'the demo treasury could not be read') : tick.reason}
              source={sourceName(tick === null ? (failure?.source ?? 'database') : tick.source)}
              at={tick === null ? (failure?.at ?? now) : tick.readAt}
              now={now}
            />
          ) : (
            <KeyValue
              items={[
                { label: 'Entry', value: <span className="hf-num">{tick.value.seq}</span> },
                { label: 'Ran', value: <Timestamp at={tick.value.at} now={now} /> },
                {
                  label: 'Digest',
                  value: (
                    <CopyButton value={tick.value.digest} what="digest">
                      {shorten(tick.value.digest, 10, 8)}
                    </CopyButton>
                  ),
                },
              ]}
            />
          )}
        </Panel>

        <Panel title="Controller journal" level={2} flush>
          {journal === null || journal.status !== 'ok' ? (
            <div className="ov-pad">
              <Unavailable
                reason={journal === null ? (failure?.reason ?? 'the demo treasury could not be read') : journal.reason}
                source={sourceName(journal === null ? (failure?.source ?? 'database') : journal.source)}
                at={journal === null ? (failure?.at ?? now) : journal.at}
                now={now}
              />
            </div>
          ) : (
            <div className="ov-pad">
              <DataTable
                dense
                caption="The latest entries of the controller journal, newest first"
                captionHidden
                columns={[
                  { key: 'seq', header: 'Entry', numeric: true },
                  { key: 'mode', header: 'Mode' },
                  { key: 'why', header: 'What it decided', rowHeader: true },
                  { key: 'at', header: 'Ran' },
                ]}
                rows={journal.value.entries.map((entry) => ({
                  id: String(entry.seq),
                  ...(entry.errors.length > 0 ? { state: 'stale' as const, stateLabel: 'Source failed' } : {}),
                  cells: {
                    seq: entry.seq,
                    mode: <Tag variant="plain">{entry.decision.mode}</Tag>,
                    why: entry.errors.length > 0 ? entry.errors.map((error) => `${error.source}: ${error.message}`).join('; ') : entry.decision.reasons.join('; ') || 'Nothing to do.',
                    at: <Timestamp at={entry.at} now={now} show="relative" />,
                  },
                }))}
                empty="No tick has run for this organisation yet."
              />
              {journal.value.chain !== null && (
                <p className="hf-small ov-chain">
                  {journal.value.chain.ok ? (
                    <>
                      <StateTag state="locked" label="Chain intact" /> Entries {journal.value.chain.fromSeq} to {journal.value.chain.toSeq} link digest to digest, checked on the stored entries.
                    </>
                  ) : (
                    <>
                      <StateTag state="refused" label="Chain broken" /> At entry {journal.value.chain.seq}: {journal.value.chain.reason}.
                    </>
                  )}
                </p>
              )}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
