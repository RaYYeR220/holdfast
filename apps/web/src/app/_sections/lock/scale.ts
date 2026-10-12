import type { Policy } from '@holdfast/core';

/**
 * The margin ratio drawn against the policy: one scale from zero that
 * carries the buy-back floor, the top-up threshold and the target, with the
 * ratio the venue shows now marked on it. Plain figures in basis points; the
 * view turns them into positions and words.
 */

type Levels = Pick<Policy, 'marginTargetBps' | 'topUpWarnBps' | 'deRiskTriggerBps' | 'deRiskRestoreBps'>;

export interface ScaleZone {
  key: 'buyBack' | 'topUp' | 'held';
  fromBps: number;
  toBps: number;
}

export interface ScaleMark {
  key: 'floor' | 'topUp' | 'target';
  bps: number;
  /** Which line under the scale its figure is written on, from 0, so that marks close together do not overprint. */
  row: number;
}

export type Standing =
  /** There is no short, so there is no ratio. */
  | 'none'
  /** Under the floor: the controller buys back part of the short. */
  | 'buyBack'
  /** Under the top-up threshold: the treasurer is asked for margin. */
  | 'topUp'
  /** Between the threshold and the target. */
  | 'belowTarget'
  /** At the target or over it. */
  | 'atTarget';

export interface MarginScale {
  /** The ratio at the right-hand end of the scale. */
  maxBps: number;
  zones: ScaleZone[];
  /** In the order of the scale. */
  marks: ScaleMark[];
  /** Where the ratio stands now; null when there is no short. `clipped` when it lies beyond the end of the scale. */
  pointer: { bps: number; clipped: boolean } | null;
  standing: Standing;
}

/** The end of the scale grows in steps of this much. */
const STEP_BPS = 2_000;
/** Room kept to the right of the target and of the ratio, as a share of each. */
const HEADROOM = 1.2;
/** A ratio further out than this many targets is drawn at the end of the scale, marked as beyond it. */
const MAX_TARGETS = 4;
/** Two figures closer than this share of the scale's length go on separate lines. */
const MIN_GAP_PERCENT = 18;

export function standingOf(levels: Levels, ratioBps: number | null): Standing {
  if (ratioBps === null) return 'none';
  if (ratioBps < levels.deRiskTriggerBps) return 'buyBack';
  if (ratioBps < levels.topUpWarnBps) return 'topUp';
  return ratioBps < levels.marginTargetBps ? 'belowTarget' : 'atTarget';
}

/** A ratio as a position along a scale, in percent of its length, kept inside it. */
export function shareOf(scale: Pick<MarginScale, 'maxBps'>, bps: number): number {
  return Math.max(0, Math.min(100, (bps / scale.maxBps) * 100));
}

export function marginScale(levels: Levels, ratioBps: number | null): MarginScale {
  const { marginTargetBps: target, topUpWarnBps: topUp, deRiskTriggerBps: floor } = levels;
  const reach = Math.max(target * HEADROOM, ratioBps === null ? 0 : Math.min(ratioBps * HEADROOM, target * MAX_TARGETS));
  const maxBps = Math.max(STEP_BPS, Math.ceil(reach / STEP_BPS) * STEP_BPS);
  // A policy may put the threshold under the floor; the top-up zone is then empty and the others meet at the floor.
  const asked = Math.max(topUp, floor);

  const lastOnRow: number[] = [];
  const marks = (
    [
      { key: 'floor', bps: floor },
      { key: 'topUp', bps: topUp },
      { key: 'target', bps: target },
    ] as const
  )
    .toSorted((a, b) => a.bps - b.bps)
    .map((mark): ScaleMark => {
      const at = shareOf({ maxBps }, mark.bps);
      let row = lastOnRow.findIndex((last) => at - last >= MIN_GAP_PERCENT);
      if (row < 0) row = lastOnRow.length;
      lastOnRow[row] = at;
      return { ...mark, row };
    });

  return {
    maxBps,
    zones: [
      { key: 'buyBack', fromBps: 0, toBps: floor },
      { key: 'topUp', fromBps: floor, toBps: asked },
      { key: 'held', fromBps: asked, toBps: maxBps },
    ],
    marks,
    pointer: ratioBps === null ? null : { bps: ratioBps, clipped: ratioBps > maxBps },
    standing: standingOf(levels, ratioBps),
  };
}
