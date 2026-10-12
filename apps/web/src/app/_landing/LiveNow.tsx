import type { ReactNode } from 'react';
import type { Reading } from '@/server/reading';
import { Skeleton, Timestamp, Unavailable, formatBps, formatNumber } from '@/ui';
import { loadDemo } from '../_lib/demo';

/**
 * The demo treasury as it stands at this request, read the way /demo reads
 * it. Every row either shows what its source said and when, or says that the
 * source could not be read and why.
 */

const SOURCE: Record<string, string> = { zcash: 'Zcash', hyperliquid: 'Hyperliquid', journal: 'the journal', database: 'the database' };
const sourceName = (source: string) => SOURCE[source] ?? source;

function Row<T>({ label, reading, now, figure = false, children }: { label: string; reading: Reading<T>; now: number; figure?: boolean; children: (value: T) => ReactNode }) {
  if (reading.status !== 'ok') {
    return (
      <div className="lp-g lp-g--gap">
        <span className="hf-px">{label}</span>
        <Unavailable reason={reading.reason} source={sourceName(reading.source)} at={reading.readAt} now={now} />
      </div>
    );
  }
  return (
    <div className={figure ? 'lp-g lp-g--figure' : 'lp-g'}>
      {children(reading.value)}
      <span className="lp-g__asof">
        Read from {sourceName(reading.source)}, <Timestamp at={reading.readAt} now={now} />
      </span>
    </div>
  );
}

export function LiveNowLoading() {
  return (
    <div className="lp-now" aria-busy="true">
      <div className="lp-now__head">
        <h3 className="hf-px">Read just now</h3>
        <p>Reading the demo treasury</p>
      </div>
      <div className="lp-g lp-g--gap">
        <Skeleton height={20} label="Reading the treasury" />
      </div>
      <div className="lp-g lp-g--gap">
        <Skeleton height={20} label="Reading the short" />
      </div>
      <div className="lp-g lp-g--gap">
        <Skeleton height={20} width="50%" label="Reading the margin ratio" />
      </div>
    </div>
  );
}

export async function LiveNow() {
  const demo = await loadDemo();
  const now = Date.now();

  if (demo.status !== 'ok') {
    return (
      <div className="lp-now">
        <div className="lp-now__head">
          <h3 className="hf-px">Read just now</h3>
        </div>
        <div className="lp-g lp-g--gap">
          <Unavailable
            reason={demo.status === 'empty' ? 'The database holds no organisation that has chosen to be a public demo.' : `The demo treasury could not be read: ${demo.reason}.`}
            source={sourceName(demo.source)}
            at={demo.at}
            now={now}
          />
        </div>
        <p className="lp-small lp-gnote">What happened to the grant payment is on the left as it was recorded. This panel shows the treasury as it stands when the page is opened, and says so when it cannot.</p>
      </div>
    );
  }

  const { overview, journal } = demo;
  const treasuryZec = overview.treasury.status === 'ok' ? Number(overview.treasury.value.zec) : null;
  return (
    <>
      <div className="lp-now">
        <div className="lp-now__head">
          <h3 className="hf-px">Read just now</h3>
          <p>{overview.org.name}</p>
        </div>
        <Row label="ZEC held" reading={overview.treasury} now={now}>
          {(value) => (
            <>
              <span className="hf-px">ZEC held</span>
              <span className="lp-g__bar hf-pat-unlocked" />
              <span className="lp-g__value hf-px">{value.zec}</span>
            </>
          )}
        </Row>
        <Row label="Short" reading={overview.hedge} now={now}>
          {(value) => {
            const share = treasuryZec === null || treasuryZec <= 0 ? 100 : Math.min(100, (Math.max(0, value.shortZec) / treasuryZec) * 100);
            return (
              <>
                <span className="hf-px">Short</span>
                <span className="lp-g__bar">
                  <i className="hf-pat-locked" style={{ width: `${share.toFixed(1)}%` }} />
                </span>
                <span className="lp-g__value hf-px">{formatNumber(value.shortZec, 2)}</span>
              </>
            );
          }}
        </Row>
        <Row label="Margin ratio" reading={overview.marginRatio} now={now} figure>
          {(value) => (
            <>
              <span className="hf-px">Margin ratio</span>
              <span className="lp-g__value hf-px">{value.bps === null ? 'No short' : formatBps(value.bps)}</span>
            </>
          )}
        </Row>
        <Row label="Funding" reading={overview.funding} now={now} figure>
          {(value) => (
            <>
              <span className="hf-px">Funding</span>
              <span className="lp-g__value hf-px">{formatBps(value.aprBps)}</span>
            </>
          )}
        </Row>
        <p className="lp-small lp-gnote">Funding is the trailing yearly rate paid to shorts. It is not guaranteed; it was negative in June 2026.</p>
      </div>
      <div className="lp-journal">
        <h3 className="hf-px">Controller journal</h3>
        {journal.status !== 'ok' ? (
          <Unavailable reason={journal.reason} source={sourceName(journal.source)} at={journal.at} now={now} />
        ) : journal.value.entries.length === 0 ? (
          <p className="lp-small">No tick has run for this organisation yet.</p>
        ) : (
          <ol>
            {journal.value.entries.slice(0, 3).map((entry) => (
              <li key={entry.seq}>
                <span>{entry.seq}</span>
                <span>{entry.decision.mode}</span>
                <span>{entry.errors.length > 0 ? entry.errors.map((error) => `${error.source}: ${error.message}`).join('; ') : entry.decision.reasons.join('; ') || 'nothing to do'}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </>
  );
}
