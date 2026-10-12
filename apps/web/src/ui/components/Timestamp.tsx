'use client';

import { useEffect, useState } from 'react';
import { formatAgo, formatUtc } from '../format';

export interface TimestampProps {
  /** The moment, in milliseconds since the epoch. */
  at: number;
  /**
   * The server's clock when it rendered. With it the relative part is right
   * in the first paint; the browser's own clock takes over once the page wakes.
   */
  now?: number;
  /** Which parts to show. Both when omitted. */
  show?: 'both' | 'absolute' | 'relative';
  seconds?: boolean;
  className?: string;
}

/** How far a moment may lie ahead of the clock and still be a reading taken just now: the clock ticks every 15 seconds. */
const TICK_SLACK_MS = 60_000;

/** The clock to measure `at` against: a reading a moment newer than the last tick is not in the future. */
function reference(at: number, clock: number): number {
  return at > clock && at - clock <= TICK_SLACK_MS ? at : clock;
}

/**
 * A moment, absolute and relative: `2026-10-12 14:03 UTC, 3 min ago`. Every
 * figure read from a chain or a venue is shown with one of these.
 */
export function Timestamp({ at, now, show = 'both', seconds = false, className }: TimestampProps) {
  const [clock, setClock] = useState<number | undefined>(now);
  useEffect(() => {
    // A page read again brings a later server clock; neither clock is allowed to run behind the other.
    const read = () => setClock(Math.max(Date.now(), now ?? 0));
    read();
    const timer = window.setInterval(read, 15_000);
    return () => window.clearInterval(timer);
  }, [now]);
  const absolute = formatUtc(at, seconds);
  const relative = clock === undefined ? null : formatAgo(at, reference(at, Math.max(clock, now ?? 0)));
  return (
    <time className={`hf-time${className === undefined ? '' : ` ${className}`}`} dateTime={new Date(at).toISOString()} title={absolute}>
      {show !== 'relative' && (
        <span className="hf-time__abs">
          {absolute}
          {show === 'both' && relative !== null && ','}
        </span>
      )}
      {show === 'both' && relative !== null && ' '}
      {show !== 'absolute' && relative !== null && <span className="hf-time__rel">{relative}</span>}
    </time>
  );
}
