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

/**
 * A moment, absolute and relative: `2026-10-12 14:03 UTC, 3 min ago`. Every
 * figure read from a chain or a venue is shown with one of these.
 */
export function Timestamp({ at, now, show = 'both', seconds = false, className }: TimestampProps) {
  const [clock, setClock] = useState<number | undefined>(now);
  useEffect(() => {
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const absolute = formatUtc(at, seconds);
  const relative = clock === undefined ? null : formatAgo(at, clock);
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
