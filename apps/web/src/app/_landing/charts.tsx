'use client';

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { DitherCanvas, type DitherGrid, type DitherLabel, type DitherPicture, FORCE_INK, FORCE_PAPER, Raster, Toggle, formatPct, formatUsd } from '@/ui';
import { type Cloud, type Kelp, type Rock, type Scene, buildScene } from '@/ui/onebit/scene';
import type { Backtest } from '../_lib/backtest';

/**
 * The landing page's pictures of the backtest, each drawn from the series
 * the server computed: June replayed with the lock on and off, the control
 * where the lock fails, the whole price history, and the ground the anchor
 * holds at the foot of the page.
 */

const DAY = 86_400_000;

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/* =====================================================================
   June, replayed with the lock on or off
   ===================================================================== */

export interface JuneReplayProps {
  june: Backtest['june'];
  /** The notes beside the picture; they do not change with the lever. */
  children?: ReactNode;
}

const REPLAY_STEPS = 22;
const REPLAY_STEP_MS = 62;

export function JuneReplay({ june, children }: JuneReplayProps) {
  const [on, setOn] = useState(true);
  const [progress, setProgress] = useState(1);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearInterval(timer.current), []);

  const flip = (next: boolean) => {
    setOn(next);
    window.clearInterval(timer.current);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setProgress(1);
      return;
    }
    let step = 0;
    setProgress(0);
    timer.current = window.setInterval(() => {
      step += 1;
      setProgress(step / REPLAY_STEPS);
      if (step >= REPLAY_STEPS) window.clearInterval(timer.current);
    }, REPLAY_STEP_MS);
  };

  const draw = useCallback(
    ({ w, h }: DitherGrid): DitherPicture => {
      const r = new Raster(w, h);
      const s = june.points;
      const n = s.length;
      const t0 = june.from;
      const t1 = s[n - 1]?.t ?? june.to;
      const pl = 2;
      const pr = 2;
      const pt = 5;
      const pb = 12;
      const pw = w - pl - pr;
      const ph = h - pt - pb;
      const TOP = 16;
      const BOTTOM = -100;
      const Y = (p: number) => pt + Math.round(((TOP - p) / (TOP - BOTTOM)) * (ph - 1));
      const col = (t: number) => clamp(Math.round(((t - t0) / (t1 - t0)) * (pw - 1)), 0, pw - 1);
      const yb = pt + ph - 1;
      const y0 = Y(0);
      const done = progress >= 1;
      const cut = Math.round((pw - 1) * progress);
      const ys: number[] = [];
      let before: number | null = null;

      for (let i = 0; i < pw; i++) {
        const x = pl + i;
        const f = pw <= 1 ? 0 : (i / (pw - 1)) * (n - 1);
        const a = Math.floor(f);
        const b = Math.min(n - 1, a + 1);
        const pa = s[a];
        const pb2 = s[b];
        if (pa === undefined || pb2 === undefined) continue;
        const up = pa.unlockedPct + (pb2.unlockedPct - pa.unlockedPct) * (f - a);
        const lp = pa.lockedPct + (pb2.lockedPct - pa.lockedPct) * (f - a);
        const yu = Y(up);
        const yl = Y(lp);
        ys.push(yu);
        if (i > cut) {
          // Not replayed yet.
          for (let y = yu; y <= yb; y++) r.shade(x, y, 0.125);
          before = yu;
          continue;
        }
        // What an unlocked treasury is worth.
        for (let y = yu; y <= yb; y++) r.shade(x, y, 0.5);
        const from = before === null ? yu : Math.min(before, yu);
        const to = before === null ? yu : Math.max(before, yu);
        if (on) {
          if (yu > yl + 2) {
            // What the lock holds.
            for (let y = yl + 2; y < yu; y++) r.set(x, y, FORCE_PAPER);
            r.vline(x, Math.max(yl + 2, from), to, FORCE_INK);
          } else r.vline(x, from, to, FORCE_PAPER);
          if (yu < yl) {
            r.set(x, yl - 1, FORCE_INK);
            r.set(x, yl + 2, FORCE_INK);
          }
          r.set(x, yl, FORCE_PAPER);
          r.set(x, yl + 1, FORCE_PAPER);
        } else {
          r.vline(x, from, to, FORCE_PAPER);
          if ((x & 1) === 0 && y0 < from - 1) r.set(x, y0, FORCE_PAPER);
        }
        before = yu;
      }

      // The low of the fortnight, drawn as a wick.
      const wi = col(june.lowAt + 2 * 3_600_000);
      const wx = pl + wi;
      const wy = Y((june.lowPx / june.startPx - 1) * 100);
      if (wi <= cut) {
        for (let y = (ys[wi] ?? wy) + 1; y <= wy; y++) {
          r.set(wx - 1, y, FORCE_INK);
          r.set(wx, y, FORCE_PAPER);
          r.set(wx + 1, y, FORCE_INK);
        }
        r.rect(wx - 2, wy + 1, 5, 1, FORCE_INK);
        r.rect(wx - 1, wy, 3, 1, FORCE_PAPER);
      }
      // Days.
      r.rect(pl, yb + 2, pw, 1, FORCE_PAPER);
      for (let day = 0; day <= 14; day++) r.rect(pl + col(t0 + day * DAY), yb + 3, 1, day === 0 || day === 4 || day === 9 || day === 14 ? 3 : 1, FORCE_PAPER);
      if (!done) for (let y = pt - 3; y <= yb; y++) if (y & 1) r.set(pl + cut, y, FORCE_PAPER);

      const small = w < 120;
      const labels: DitherLabel[] = [
        { text: 'June 1', x: pl, y: yb + 7, plate: false },
        { text: '5', x: pl + col(t0 + 4 * DAY), y: yb + 7, plate: false, align: 'center' },
        { text: '10', x: pl + col(t0 + 9 * DAY), y: yb + 7, plate: false, align: 'center' },
        { text: 'June 15', x: pl + pw, y: yb + 7, plate: false, align: 'right' },
        { text: `${formatUsd(june.startPx, 0)}, June 1`, x: pl + 1, y: y0 + 5 },
      ];
      if (done) labels.push({ text: on ? `Locked ${formatPct(june.lockedWorstPct)}` : 'Value on June 1', x: pl + pw, y: y0 - 9, align: 'right' });
      let trough = 0;
      for (let i = 1; i < n; i++) if ((s[i]?.unlockedPct ?? 0) < (s[trough]?.unlockedPct ?? 0)) trough = i;
      const tc = Math.round((trough / (n - 1)) * (pw - 1));
      if (tc <= cut) labels.push({ text: `Unlocked ${formatPct(june.unlockedWorstPct)}`, x: pl + tc + 5, y: (ys[tc] ?? yb) + 4 });
      if (wi <= cut) labels.push({ text: `${formatUsd(june.lowPx, 0)}${small ? '' : ' low'}`, x: wx - 3, y: wy - 4, align: 'right' });
      if (!small && done) {
        const ci = Math.round((pw - 1) * 0.72);
        labels.push({ text: on ? 'Held by the lock' : 'Lost with the price', x: pl + ci, y: Math.round((y0 + (ys[ci] ?? y0)) / 2 - 2), align: 'center', plate: false, ink: on });
      }

      return { bits: r, labels };
    },
    [june, on, progress],
  );

  // The figure counts down with the replay: the worst point reached so far.
  const upTo = Math.round((june.points.length - 1) * progress);
  const reachedSoFar = Math.min(0, ...june.points.slice(0, upTo + 1).map((p) => (on ? p.lockedPct : p.unlockedPct)));
  const figure = progress >= 1 ? (on ? june.lockedWorstPct : june.unlockedWorstPct) : reachedSoFar;
  return (
    <div className="lp-replay">
      <figure>
        <div className="lp-pic lp-framed lp-june">
          <DitherCanvas
            draw={draw}
            label={`One treasury replayed through June 1 to 15, 2026. Unlocked, its dollar value follows the ZEC price down, ${formatPct(Math.abs(june.unlockedWorstPct))} at worst. Locked, it stays within ${formatPct(Math.abs(june.lockedWorstPct))} of its June 1 value.`}
          />
        </div>
        <figcaption>One treasury, replayed through June 1&ndash;15 on real hourly data and drawn every two hours. Height is its dollar value; the bottom edge is zero.</figcaption>
      </figure>
      <div className="lp-panel">
        <Toggle label="Lock runway" checked={on} onChange={flip} />
        <p className="lp-fig hf-px" aria-live="polite">
          {formatPct(figure)}
        </p>
        <p className="lp-figcap">Worst point with the lock {on ? 'on' : 'off'}, against the value on June 1.</p>
        {children}
      </div>
    </div>
  );
}

/* =====================================================================
   The control: price, coverage, and the treasury that was meant to be locked
   ===================================================================== */

export function ControlChart({ control }: { control: Backtest['control'] }) {
  const draw = useCallback(
    ({ w, h }: DitherGrid): DitherPicture => {
      const r = new Raster(w, h);
      const s = control.points;
      const n = s.length;
      const first = s[0];
      const last = s[n - 1];
      if (first === undefined || last === undefined) return { bits: r };
      const t0 = first.t;
      const t1 = last.t;
      const pl = 2;
      const pr = 2;
      const pw = w - pl - pr;
      // Three strips, sized to the plate: price, coverage, the locked treasury.
      const unit = Math.max(0.6, (h - 12) / 128);
      const A = { y: Math.round(9 * unit), h: Math.round(30 * unit) };
      const B = { y: Math.round(50 * unit), h: Math.round(24 * unit) };
      const C = { y: Math.round(86 * unit), h: Math.round(40 * unit) };
      const priceTop = control.maxPx * 1.12;
      const col = (t: number) => clamp(Math.round(((t - t0) / (t1 - t0)) * (pw - 1)), 0, pw - 1);
      const zero = C.y + Math.round((20 / 64) * (C.h - 1));
      let beforeA: number | null = null;
      let beforeC: number | null = null;

      for (let i = 0; i < pw; i++) {
        const x = pl + i;
        const f = pw <= 1 ? 0 : (i / (pw - 1)) * (n - 1);
        const a = Math.floor(f);
        const b = Math.min(n - 1, a + 1);
        const pa = s[a];
        const pb = s[b];
        const near = s[Math.round(f)];
        if (pa === undefined || pb === undefined || near === undefined) continue;
        const px = pa.px + (pb.px - pa.px) * (f - a);
        const lp = pa.lockedPct + (pb.lockedPct - pa.lockedPct) * (f - a);
        const ya = A.y + A.h - 1 - Math.round((px / priceTop) * (A.h - 1));
        for (let y = ya; y < A.y + A.h; y++) r.shade(x, y, 0.5);
        r.vline(x, beforeA ?? ya, ya, FORCE_PAPER);
        beforeA = ya;
        const covered = Math.max(2, Math.round((near.coveragePct / 100) * (B.h - 1)));
        for (let y = B.y + B.h - covered; y < B.y + B.h; y++) r.set(x, y, FORCE_PAPER);
        if ((x & 1) === 0) r.set(x, B.y, FORCE_PAPER);
        const yl = C.y + Math.round(((20 - lp) / 64) * (C.h - 1));
        if ((x & 1) === 0) r.set(x, zero, FORCE_PAPER);
        if (yl > zero + 1) for (let y = zero + 1; y < yl; y++) r.shade(x, y, 0.5);
        r.vline(x, beforeC ?? yl, yl, FORCE_PAPER);
        beforeC = yl;
      }
      for (let y = B.y; y < B.y + B.h; y += 2) r.set(pl + pw - 1, y, FORCE_PAPER);
      const axis = C.y + C.h + 2;
      r.rect(pl, axis, pw, 1, FORCE_PAPER);
      const may1 = Date.UTC(2026, 4, 1);
      const june1 = Date.UTC(2026, 5, 1);
      for (let t = may1; t <= t1; t += 7 * DAY) r.rect(pl + col(t), axis + 1, 1, 1, FORCE_PAPER);
      for (const x of [pl + col(may1), pl + col(june1), pl, pl + pw - 1]) r.rect(x, axis + 1, 1, 3, FORCE_PAPER);
      // The day the crash arrives, carried through all three strips.
      const crash = pl + col(Date.UTC(2026, 5, 5));
      for (let y = A.y; y < C.y + C.h; y += 3) if (r.forcedAt(crash, y) === 0) r.set(crash, y, FORCE_PAPER);

      const labels: DitherLabel[] = [
        { text: `ZEC doubles: ${formatUsd(first.px, 0)} to ${formatUsd(control.maxPx, 0)}`, x: pl, y: Math.max(0, A.y - 8), plate: false },
        { text: `Hedge bought back: ${first.coveragePct}% to ${last.coveragePct}%`, x: pl, y: B.y - 8, plate: false },
        { text: `Locked treasury: ${formatPct(control.lockedWorstPct)}${w < 120 ? '' : ' at worst'}`, x: pl, y: C.y - 8, plate: false },
        { text: 'April 29', x: pl, y: axis + 5, plate: false },
        { text: 'June 1', x: pl + col(june1), y: axis + 5, plate: false, align: 'center' },
        { text: 'June 15', x: pl + pw, y: axis + 5, plate: false, align: 'right' },
      ];
      return { bits: r, labels };
    },
    [control],
  );
  const first = control.points[0];
  const last = control.points.at(-1);
  return (
    <DitherCanvas
      draw={draw}
      label={`The control scenario, April 29 to June 15, 2026. ZEC doubles, the hedge is bought back from ${first?.coveragePct ?? 100} percent coverage to ${last?.coveragePct ?? 0} percent, and the locked treasury then falls ${formatPct(Math.abs(control.lockedWorstPct))} with the June crash.`}
    />
  );
}

/* =====================================================================
   The whole tape, March to October
   ===================================================================== */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function TapeChart({ tape, soldAt }: { tape: Backtest['tape']; soldAt: number }) {
  const draw = useCallback(
    ({ w, h }: DitherGrid): DitherPicture => {
      const r = new Raster(w, h);
      const t = tape.points;
      const n = t.length;
      const first = t[0];
      const last = t[n - 1];
      if (first === undefined || last === undefined) return { bits: r };
      const t0 = first.t;
      const t1 = last.t;
      const pl = 2;
      const pr = 3;
      const pt = 11;
      const pb = 12;
      const pw = w - pl - pr;
      const ph = h - pt - pb;
      const top = Math.ceil(tape.highPx / 100) * 100;
      const yb = pt + ph - 1;
      const col = (time: number) => clamp(Math.round(((time - t0) / (t1 - t0)) * (pw - 1)), 0, pw - 1);
      const ys: number[] = [];
      let peak = 0;
      for (let i = 0; i < n; i++) if ((t[i]?.px ?? 0) > (t[peak]?.px ?? 0)) peak = i;
      let before: number | null = null;
      for (let i = 0; i < pw; i++) {
        const x = pl + i;
        const f = pw <= 1 ? 0 : (i / (pw - 1)) * (n - 1);
        const a = Math.floor(f);
        const pa = t[a];
        const pb2 = t[Math.min(n - 1, a + 1)];
        if (pa === undefined || pb2 === undefined) continue;
        const yv = yb - Math.round(((pa.px + (pb2.px - pa.px) * (f - a)) / top) * (ph - 1));
        ys.push(yv);
        for (let y = yv; y <= yb; y++) r.shade(x, y, 0.5);
        r.vline(x, before ?? yv, yv, FORCE_PAPER);
        before = yv;
      }
      r.rect(pl, yb + 2, pw, 1, FORCE_PAPER);
      const small = w < 120;
      const labels: DitherLabel[] = [];
      const start = new Date(t0);
      for (let month = start.getUTCMonth() + 1; ; month++) {
        const at = Date.UTC(start.getUTCFullYear(), month, 1);
        if (at > t1) break;
        const x = pl + col(at);
        r.rect(x, yb + 3, 1, 3, FORCE_PAPER);
        const name = MONTHS[month % 12] ?? '';
        if (small && month % 2 === 1) continue;
        labels.push({ text: small ? name.slice(0, 3) : name, x, y: yb + 7, plate: false, align: x > w * 0.9 ? 'right' : 'center' });
      }
      // Where the demo treasury's short was sold: the last point.
      const lx = pl + pw - 1;
      const ly = ys[pw - 1] ?? yb;
      for (let y = ly - 9; y <= ly + 1; y++) {
        r.set(lx, y, FORCE_PAPER);
        r.set(lx - 1, y, FORCE_INK);
      }
      r.rect(lx - 2, ly - 1, 5, 3, FORCE_PAPER);
      r.rect(lx + 3, ly - 1, 1, 3, FORCE_INK);

      const pc = col(t[peak]?.t ?? t1);
      labels.push({ text: `${formatUsd(tape.firstPx, 0)} in ${MONTHS[start.getUTCMonth()] ?? ''}`, x: pl + 1, y: Math.max(1, (ys[0] ?? yb) - 12) });
      labels.push({ text: formatUsd(tape.highPx, 0), x: pl + pc + 6, y: Math.max(0, (ys[pc] ?? pt) - 9), align: 'right' });
      labels.push({ text: `Short sold at ${formatUsd(soldAt)}`, x: lx - 3, y: ly + 5, align: 'right' });
      return { bits: r, labels };
    },
    [tape, soldAt],
  );
  return (
    <DitherCanvas
      draw={draw}
      label={`ZEC daily closes from March to October 2026, from about ${formatUsd(tape.firstPx, 0)} to a high of ${formatUsd(tape.highPx, 0)} and back to ${formatUsd(tape.lastPx, 0)}. The demo treasury's short was sold at the right-hand end, at ${formatUsd(soldAt)}.`}
    />
  );
}

/* =====================================================================
   The ground the anchor holds
   ===================================================================== */

export function FootBed() {
  const scene = useRef<{ key: string; scene: Scene } | null>(null);
  const draw = useCallback((grid: DitherGrid) => {
    const key = `${grid.w}x${grid.h}`;
    if (scene.current === null || scene.current.key !== key) {
      const W = grid.w;
      const H = grid.h;
      const compact = W * grid.unit <= 760;
      const edge = Math.round(W * (compact ? 0.16 : 0.94));
      const middle = Math.round(W * (compact ? 0.52 : 0.6));
      const rocks: Rock[] = compact ? [[edge, 8, 5], [middle, 6, 3]] : [[edge, 10, 8], [middle, 7, 4], [Math.round(W * 0.3), 5, 2]];
      const kelp: Kelp[] = compact
        ? [[edge - 3, 34], [edge + 3, 22], [edge + 6, 12], [middle, 14]]
        : [[edge - 5, 46], [edge + 2, 32], [edge + 7, 18], [middle - 2, 20], [middle + 3, 12], [Math.round(W * 0.3), 9]];
      const clouds: Cloud[] = [];
      scene.current = {
        key,
        scene: buildScene({
          kind: 'bed',
          w: W,
          h: H,
          waterline: -60,
          compact,
          k: 1,
          ox: Math.round(W * 0.8),
          moon: { x: Math.round(W * 0.8), y: 0, r: 20 },
          clouds,
          rocks,
          kelp,
          anchor: { x: compact ? W - 13 : Math.round(W * 0.775), length: compact ? 26 : 34, mirrored: compact },
          chainCurve: compact ? 1.2 : 1.9,
          calmX: Math.round(W * (compact ? 0.35 : 0.5)),
          quiet: [],
          keyScale: 0,
        }),
      };
    }
    return scene.current.scene.render(grid.frame, -1);
  }, []);
  return <DitherCanvas draw={draw} fps={8} cover className="lp-foot__bed" />;
}
