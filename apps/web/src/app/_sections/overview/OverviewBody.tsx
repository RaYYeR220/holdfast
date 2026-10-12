import type { ReactNode } from 'react';
import type { DemoJournal, DemoOverview } from '@/server/demo/service';
import type { Reading } from '@/server/reading';
import { CopyButton, DataTable, KeyValue, Panel, Stat, type StatProps, StateTag, Tag, Timestamp, Unavailable, formatBps, formatNumber, formatUsd, shorten } from '@/ui';
import '../../demo/overview.css';

/**
 * The body of an Overview page: what the treasury holds, how much of its
 * dollar value the short fixes, and when each figure was read. The public
 * demo and the owner's overview both render it, each from its own read of
 * the same figures.
 */

/** A read that failed as a whole, with where and why. */
export interface Failure {
  source: string;
  reason: string;
  at: number;
}

/** Names of the sources as a reader knows them. */
const SOURCE: Record<string, string> = {
  zcash: 'Zcash',
  hyperliquid: 'Hyperliquid',
  'zcash+hyperliquid': 'Zcash and Hyperliquid',
  'zcash+reference': 'Zcash and the reference price',
  reference: 'the reference price',
  hyperevm: 'HyperEVM',
  journal: 'the journal',
  database: 'the database',
  'viewing key': 'the viewing key',
};
export const sourceName = (source: string) => SOURCE[source] ?? source;

type Shown = Pick<StatProps, 'figure' | 'unit' | 'note' | 'state'>;

export interface ReadingStatProps<T> {
  label: string;
  reading: Reading<T> | null;
  /** Why there is no reading at all, when the organisation itself could not be read. */
  failure: Failure | null;
  now: number;
  size?: StatProps['size'];
  show: (value: T) => Shown;
}

/**
 * One reading as a stat: its figure with the time it was read and where,
 * or, when the read failed, the reason in the figure's place.
 */
export function ReadingStat<T>({ label, reading, failure, now, size, show }: ReadingStatProps<T>) {
  const sized = size === undefined ? {} : { size };
  if (reading === null) {
    const why = failure ?? { source: 'database', reason: 'the treasury could not be read', at: now };
    return <Stat label={label} now={now} unavailable={{ reason: why.reason, source: sourceName(why.source), at: why.at }} {...sized} />;
  }
  if (reading.status !== 'ok') {
    return <Stat label={label} now={now} unavailable={{ reason: reading.reason, source: sourceName(reading.source), at: reading.readAt }} {...sized} />;
  }
  return <Stat label={label} now={now} asOf={reading.readAt} source={sourceName(reading.source)} {...show(reading.value)} {...sized} />;
}

/** A bar for a share between nothing and all, with its figure. */
export function ShareBar({ label, share, text }: { label: string; share: number; text: string }) {
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

/** A reading that failed, or the failure of the whole read, in the place its figure would stand. */
export function ReadingGap({ reading, failure, now }: { reading: Exclude<Reading<unknown>, { status: 'ok' }> | null; failure: Failure | null; now: number }) {
  if (reading !== null) return <Unavailable reason={reading.reason} source={sourceName(reading.source)} at={reading.readAt} now={now} />;
  return <Unavailable reason={failure?.reason ?? 'the treasury could not be read'} source={sourceName(failure?.source ?? 'database')} at={failure?.at ?? now} now={now} />;
}

export interface OverviewBodyProps {
  /** Null when the organisation could not be read; every figure then shows `failure`. */
  overview: DemoOverview | null;
  /** The latest entries of the journal, or why they could not be read; null with `overview`. */
  journal: { status: 'ok'; value: DemoJournal } | ({ status: 'unavailable' } & Failure) | null;
  failure: Failure | null;
  now: number;
}

export function OverviewBody({ overview, journal, failure, now }: OverviewBodyProps) {
  const lock: ReactNode =
    overview === null ? <StateTag state="stale" label="Lock unknown" boxed /> : overview.lockEnabled ? <StateTag state="locked" label="Lock on" boxed /> : <StateTag state="unlocked" label="Lock off" boxed />;

  const coverage = overview?.coverage ?? null;
  const tick = overview?.lastTick ?? null;

  return (
    <>
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
              <ReadingGap reading={coverage} failure={failure} now={now} />
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
            <ReadingGap reading={tick} failure={failure} now={now} />
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
                reason={journal === null ? (failure?.reason ?? 'the treasury could not be read') : journal.reason}
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
    </>
  );
}
