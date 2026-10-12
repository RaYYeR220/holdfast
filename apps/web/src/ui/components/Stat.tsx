import type { ReactNode } from 'react';
import type { State } from '../onebit/patterns';
import { Swatch } from './Tag';
import { Timestamp } from './Timestamp';
import { Unavailable } from './Unavailable';

export interface StatProps {
  /** What the figure is, in a few words. */
  label: ReactNode;
  /** The figure, already formatted. Leave it out and pass `unavailable` when the read failed. */
  figure?: ReactNode;
  /** A unit set small after the figure: "ZEC", "USDC". */
  unit?: ReactNode;
  /** When the figure was read, in milliseconds. Shown as "as of". */
  asOf?: number;
  /** The server's clock at render; see `Timestamp`. */
  now?: number;
  /** Where the figure was read from. */
  source?: string;
  /** A state shown as its swatch before the label. */
  state?: State;
  /** One line under the figure, in the serif. */
  note?: ReactNode;
  /** The read failed: shown in place of the figure, with the reason. */
  unavailable?: { reason: ReactNode; source?: string; at?: number };
  size?: 'small' | 'medium' | 'large';
  className?: string;
}

/**
 * One figure with its label and the time it was read. A figure that could
 * not be read is an `Unavailable` in the same place, never a blank or a zero.
 */
export function Stat({ label, figure, unit, asOf, now, source, state, note, unavailable, size = 'medium', className }: StatProps) {
  const name = ['hf-stat', size === 'medium' ? '' : `hf-stat--${size}`, className ?? ''].filter(Boolean).join(' ');
  const clock = now === undefined ? {} : { now };
  return (
    <div className={name} {...(unavailable !== undefined ? { 'data-state': 'stale' } : state !== undefined ? { 'data-state': state } : {})}>
      <p className="hf-stat__label">
        {state !== undefined && unavailable === undefined && <Swatch state={state} />}
        {label}
      </p>
      {unavailable !== undefined ? (
        <Unavailable
          className="hf-stat__gap"
          reason={unavailable.reason}
          {...(unavailable.source === undefined ? {} : { source: unavailable.source })}
          {...(unavailable.at === undefined ? {} : { at: unavailable.at })}
          {...clock}
        />
      ) : (
        <>
          <p className="hf-stat__figure">
            {figure}
            {unit !== undefined && <span className="hf-stat__unit">{unit}</span>}
          </p>
          {note !== undefined && <p className="hf-stat__note">{note}</p>}
          {asOf !== undefined && (
            <p className="hf-stat__asof">
              as of <Timestamp at={asOf} {...clock} />
              {source !== undefined && <>, from {source}</>}
            </p>
          )}
        </>
      )}
    </div>
  );
}
