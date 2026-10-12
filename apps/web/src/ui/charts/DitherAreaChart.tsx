'use client';

import { type ReactNode, useCallback } from 'react';
import { DitherCanvas, type DitherGrid, type DitherLabel, type DitherPicture } from '../onebit/DitherCanvas';
import { FORCE_INK, FORCE_PAPER, Raster } from '../onebit/raster';

export interface ChartSeries {
  /** Names the series in the legend. */
  label: string;
  values: readonly number[];
  /** Text set at the right-hand end of the series, already formatted: "−47.4%". */
  endLabel?: string;
}

export interface DitherAreaChartProps {
  /** The series that moves, drawn as an area in the checker of an unlocked thing. */
  area: ChartSeries;
  /** The series that is held, drawn as a solid line. Both series span the same period. */
  line?: ChartSeries;
  /** Fill solid between the line and the area where the area is below the line: what the line holds. */
  fillBetween?: boolean;
  /** Values at the bottom and at the top of the plate. Taken from the data, with zero included, when omitted. */
  domain?: readonly [number, number];
  /** A dotted level across the plate, such as the starting value. */
  baseline?: number;
  /** Marks along the bottom edge: a position from 0 to 1 and its text. */
  ticks?: readonly { at: number; label: string }[];
  /** Show only the first part of the period, from 0 to 1; the rest is left in sparse dots. For a replay. */
  progress?: number;
  /** What the chart shows, with its key figures, for a reader who cannot see it. */
  label: string;
  caption?: ReactNode;
  /** Height of the plate in CSS pixels. */
  height?: number;
  className?: string;
}

const lerp = (values: readonly number[], f: number): number => {
  if (values.length === 0) return 0;
  const a = Math.floor(f);
  const b = Math.min(values.length - 1, a + 1);
  const va = values[Math.max(0, Math.min(values.length - 1, a))] as number;
  const vb = values[b] as number;
  return va + (vb - va) * (f - a);
};

/**
 * Two series over one period as a one-bit picture: an area in the checker and
 * a solid line over it. The series are told apart by fill and by the labels
 * at their ends, and the legend under the plate names both.
 */
export function DitherAreaChart({ area, line, fillBetween = false, domain, baseline, ticks, progress = 1, label, caption, height = 240, className }: DitherAreaChartProps) {
  const draw = useCallback(
    ({ w, h }: DitherGrid): DitherPicture => {
      const r = new Raster(w, h);
      const padLeft = 2;
      const padRight = 2;
      const padTop = 5;
      const padBottom = ticks === undefined ? 4 : 12;
      const pw = w - padLeft - padRight;
      const ph = h - padTop - padBottom;
      const all = [...area.values, ...(line?.values ?? []), ...(baseline === undefined ? [] : [baseline])];
      const low = domain?.[0] ?? Math.min(0, ...all);
      const high = domain?.[1] ?? Math.max(0, ...all);
      const span = high - low || 1;
      const Y = (v: number) => padTop + Math.round(((high - v) / span) * (ph - 1));
      const bottom = padTop + ph - 1;
      const cut = Math.round((pw - 1) * Math.max(0, Math.min(1, progress)));
      const labels: DitherLabel[] = [];

      let before: number | null = null;
      let lastArea = bottom;
      let lastLine = bottom;
      for (let i = 0; i < pw; i++) {
        const x = padLeft + i;
        const t = pw <= 1 ? 0 : i / (pw - 1);
        const ya = Math.min(bottom, Math.max(padTop, Y(lerp(area.values, t * (area.values.length - 1)))));
        if (i > cut) {
          for (let y = ya; y <= bottom; y++) r.shade(x, y, 0.125);
          before = ya;
          continue;
        }
        for (let y = ya; y <= bottom; y++) r.shade(x, y, 0.5);
        const from = before === null ? ya : Math.min(before, ya);
        const to = before === null ? ya : Math.max(before, ya);
        if (line !== undefined) {
          const yl = Math.min(bottom, Math.max(padTop, Y(lerp(line.values, t * (line.values.length - 1)))));
          if (fillBetween && ya > yl + 2) {
            for (let y = yl + 2; y < ya; y++) r.set(x, y, FORCE_PAPER);
            r.vline(x, Math.max(yl + 2, from), to, FORCE_INK);
          } else r.vline(x, from, to, FORCE_PAPER);
          if (ya < yl) {
            r.set(x, yl - 1, FORCE_INK);
            r.set(x, yl + 2, FORCE_INK);
          }
          r.set(x, yl, FORCE_PAPER);
          r.set(x, yl + 1, FORCE_PAPER);
          lastLine = yl;
        } else r.vline(x, from, to, FORCE_PAPER);
        before = ya;
        lastArea = ya;
      }

      if (baseline !== undefined) {
        const yb = Y(baseline);
        for (let x = padLeft; x < padLeft + pw; x += 2) if (r.forcedAt(x, yb) === 0) r.set(x, yb, FORCE_PAPER);
      }
      if (progress < 1) for (let y = padTop - 3; y <= bottom; y++) if (y & 1) r.set(padLeft + cut, y, FORCE_PAPER);

      r.rect(padLeft, bottom + 2, pw, 1, FORCE_PAPER);
      for (const tick of ticks ?? []) {
        const x = padLeft + Math.round(Math.max(0, Math.min(1, tick.at)) * (pw - 1));
        r.rect(x, bottom + 3, 1, 3, FORCE_PAPER);
        labels.push({ text: tick.label, x, y: bottom + 7, align: tick.at > 0.9 ? 'right' : tick.at < 0.1 ? 'left' : 'center', plate: false });
      }

      if (progress >= 1) {
        const apart = Math.abs(lastArea - lastLine) >= 8;
        if (line?.endLabel !== undefined) labels.push({ text: line.endLabel, x: padLeft + pw, y: Math.max(1, lastLine - 9), align: 'right' });
        if (area.endLabel !== undefined && (line?.endLabel === undefined || apart)) {
          labels.push({ text: area.endLabel, x: padLeft + pw, y: Math.min(bottom - 8, Math.max(1, lastArea + (lastArea > lastLine ? 4 : -9))), align: 'right' });
        }
      }
      return { bits: r, labels };
    },
    [area, line, fillBetween, domain, baseline, ticks, progress],
  );

  return (
    <figure className={`hf-chart${className === undefined ? '' : ` ${className}`}`}>
      <div className="hf-plate hf-plate--framed">
        <DitherCanvas draw={draw} label={label} className="hf-chart__plate" style={{ height }} />
      </div>
      <p className="hf-chart__legend" aria-hidden="true">
        {line !== undefined && (
          <span>
            <i className="hf-swatch hf-pat-locked" />
            {line.label}
          </span>
        )}
        <span>
          <i className="hf-swatch hf-pat-unlocked" />
          {area.label}
        </span>
      </p>
      {caption !== undefined && <figcaption className="hf-chart__caption">{caption}</figcaption>}
    </figure>
  );
}
