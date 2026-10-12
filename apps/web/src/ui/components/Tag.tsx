import type { ReactNode } from 'react';
import { type State, STATE_LABEL } from '../onebit/patterns';

/** A square of a state's fill. Decorative: the word beside it carries the meaning. */
export function Swatch({ state, className }: { state: State; className?: string }) {
  return <i className={`hf-swatch hf-pat-${state}${className === undefined ? '' : ` ${className}`}`} aria-hidden="true" />;
}

/** The pixel tick: a criterion met. Decorative; say "met" or "passed" in the text. */
export function Tick() {
  return (
    <svg className="hf-tick" viewBox="0 0 7 5" aria-hidden="true">
      <path shapeRendering="crispEdges" d="M5 0h2v1h-2zM4 1h2v1h-2zM0 2h2v1h-2zM3 2h2v1h-2zM1 3h3v1h-3zM2 4h1v1h-1z" />
    </svg>
  );
}

export interface TagProps {
  /** `plain` is a bare label, `boxed` is outlined, `solid` is inverted. */
  variant?: 'plain' | 'boxed' | 'solid';
  className?: string;
  children: ReactNode;
}

/** A short label in the pixel face: a chain, a mode, a kind. */
export function Tag({ variant = 'boxed', className, children }: TagProps) {
  return <span className={['hf-tag', variant === 'plain' ? '' : `hf-tag--${variant}`, className ?? ''].filter(Boolean).join(' ')}>{children}</span>;
}

export interface StateTagProps {
  state: State;
  /** The word shown. Each state has a default; pass one that fits the screen, such as "Lock on" or "Over the limit". */
  label?: string;
  boxed?: boolean;
  className?: string;
}

/**
 * One of the five states as its pattern and its word, together. Use it
 * wherever a screen says that something is locked, unlocked, refused, at a
 * limit, or stale or unavailable.
 */
export function StateTag({ state, label, boxed = false, className }: StateTagProps) {
  return (
    <span className={['hf-tag', boxed ? 'hf-tag--boxed' : '', className ?? ''].filter(Boolean).join(' ')} data-state={state}>
      <Swatch state={state} />
      {label ?? STATE_LABEL[state]}
    </span>
  );
}
