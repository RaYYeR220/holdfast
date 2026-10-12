import { FORCE_INK, FORCE_PAPER, type Raster, ditherOn } from './raster';

/**
 * The fills of the one-bit vocabulary as functions of a design pixel, for
 * drawing on a raster. The same fills exist as CSS classes in
 * `styles/patterns.css`; the two are kept pixel for pixel alike.
 */

export type Tone = 'none' | 't12' | 't25' | 't50' | 't75' | 'solid';

const LEVEL: Record<Tone, number> = { none: 0, t12: 0.125, t25: 0.25, t50: 0.5, t75: 0.75, solid: 1 };

/** Whether a pixel of a flat tone is paper. */
export function toneBit(tone: Tone, x: number, y: number): boolean {
  return ditherOn(LEVEL[tone], x, y);
}

/**
 * The five states every product screen distinguishes. Each has a fill and a
 * word; neither is ever replaced by a colour.
 */
export type State = 'locked' | 'unlocked' | 'refused' | 'limit' | 'stale';

export const STATES: readonly State[] = ['locked', 'unlocked', 'refused', 'limit', 'stale'];

export const STATE_LABEL: Record<State, string> = {
  locked: 'Locked',
  unlocked: 'Unlocked',
  refused: 'Refused',
  limit: 'Limit',
  stale: 'Unavailable',
};

/** What each fill looks like, for a legend or a text alternative. */
export const STATE_PATTERN: Record<State, string> = {
  locked: 'solid',
  unlocked: 'checker',
  refused: 'stair hatch',
  limit: 'dotted outline',
  stale: 'sparse dots',
};

/**
 * Whether a pixel of a state's fill is paper. `w` and `h` are the size of the
 * filled box; only the dotted outline of `limit` needs them.
 */
export function stateBit(state: State, x: number, y: number, w = 0, h = 0): boolean {
  switch (state) {
    case 'locked':
      return true;
    case 'unlocked':
      return ((x + y) & 1) === 0;
    case 'refused':
      return ((x + y) & 3) === 3;
    case 'limit':
      if (y === 0 || y === h - 1) return (x & 1) === 0;
      if (x === 0 || x === w - 1) return (y & 1) === 0;
      return false;
    case 'stale':
      return ditherOn(0.125, x, y);
  }
}

/** Fill a box of a raster with a state's fill. */
export function fillState(raster: Raster, state: State, x: number, y: number, w: number, h: number): void {
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) raster.set(x + i, y + j, stateBit(state, i, j, w, h) ? FORCE_PAPER : FORCE_INK);
  }
}
