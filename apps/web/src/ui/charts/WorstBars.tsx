import type { CSSProperties } from 'react';
import type { State } from '../onebit/patterns';

export interface WorstBar {
  /** Names the bar: "Locked", "Unlocked". */
  label: string;
  /** The value the bar's length shows. Its sign is ignored for the length. */
  value: number;
  /** The value as text, already formatted: "−0.9%". */
  text: string;
  /** The fill, which says what the bar is of. */
  state: State;
}

export interface WorstBarsProps {
  bars: readonly WorstBar[];
  /** The value a full-width bar stands for. */
  scale: number;
  className?: string;
}

/**
 * Horizontal bars compared on one scale: the worst point of a locked
 * treasury against the same treasury unlocked. Each bar is named, filled with
 * the pattern of its state and followed by its figure, so nothing is read
 * from length or fill alone.
 */
export function WorstBars({ bars, scale, className }: WorstBarsProps) {
  return (
    <div className={`hf-bars${className === undefined ? '' : ` ${className}`}`}>
      {bars.map((bar) => {
        const share = Math.min(100, (Math.abs(bar.value) / scale) * 100);
        // The stylesheet snaps the length to whole design pixels where the browser can.
        const style = { '--share': `${share.toFixed(2)}%` } as CSSProperties;
        return (
          <div className="hf-bars__row" key={bar.label}>
            <span>{bar.label}</span>
            <span className="hf-bars__track">
              <i className={`hf-bars__fill hf-pat-${bar.state}`} data-zero={share === 0} style={style} />
            </span>
            <span className="hf-bars__value">{bar.text}</span>
          </div>
        );
      })}
    </div>
  );
}
