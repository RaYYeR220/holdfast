import type { CSSProperties, ReactNode } from 'react';
import { Swatch } from './Tag';
import { Timestamp } from './Timestamp';

export interface SkeletonProps {
  /** Any CSS size; a line of text when omitted. */
  width?: CSSProperties['width'];
  height?: CSSProperties['height'];
  /** What is loading, for a reader who cannot see the placeholder. */
  label?: string;
  className?: string;
}

/** A placeholder for something that is being read right now. It becomes the value or an `Unavailable`. */
export function Skeleton({ width, height, label = 'Loading', className }: SkeletonProps) {
  return (
    <span className={`hf-skeleton${className === undefined ? '' : ` ${className}`}`} style={{ width, height }} role="status">
      <span className="hf-sr">{label}</span>
    </span>
  );
}

export interface UnavailableProps {
  /** Why the value is missing, as the server said it. */
  reason?: ReactNode;
  /** Which source failed: "hyperliquid", "zcash", "database". */
  source?: string;
  /** When the read was attempted, in milliseconds. */
  at?: number;
  /** The server's clock at render, so the relative time is right before the page wakes. */
  now?: number;
  /** A swatch and the word only, for a table cell or a line of text. */
  inline?: boolean;
  /** The word shown. "Unavailable" when omitted; "Stale" for a value that exists but is too old. */
  word?: string;
  className?: string;
}

/**
 * The designed state of a value that could not be read, or whose reading is
 * too old to show. It stands exactly where the value would, says which source
 * failed and why, and never shows an older or a default number in its place.
 */
export function Unavailable({ reason, source, at, now, inline = false, word = 'Unavailable', className }: UnavailableProps) {
  if (inline) {
    return (
      <span className={`hf-unavailable hf-unavailable--inline${className === undefined ? '' : ` ${className}`}`} data-state="stale">
        <Swatch state="stale" />
        <span className="hf-unavailable__word">{word}</span>
        {reason !== undefined && <span className="hf-sr">: {reason}</span>}
      </span>
    );
  }
  return (
    <div className={`hf-unavailable${className === undefined ? '' : ` ${className}`}`} data-state="stale">
      <div className="hf-unavailable__band" aria-hidden="true" />
      <div className="hf-unavailable__main">
        <p className="hf-unavailable__word">{word}</p>
        {reason !== undefined && <p className="hf-unavailable__reason">{reason}</p>}
        {(source !== undefined || at !== undefined) && (
          <p className="hf-unavailable__meta">
            {source !== undefined && <>Source: {source}</>}
            {source !== undefined && at !== undefined && '. '}
            {at !== undefined && (
              <>
                Tried <Timestamp at={at} {...(now === undefined ? {} : { now })} />
              </>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
