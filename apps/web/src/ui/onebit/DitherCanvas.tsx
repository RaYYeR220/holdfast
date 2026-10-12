'use client';

import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Raster, UNIT, bitsToImageData } from './raster';

/**
 * A canvas for one-bit drawings made from data. The caller supplies a `draw`
 * function; this component owns everything around it:
 *
 * - The grid. The host element is measured and divided into design pixels of
 *   `unit` CSS pixels. The canvas holds exactly one canvas pixel for each and
 *   is enlarged by CSS with nearest-neighbour scaling, so the backing store
 *   does not grow with the device pixel ratio. `maxCells` caps the grid; a
 *   larger host gets larger design pixels instead of more of them.
 * - Motion. With `fps` set, frames advance only while the canvas is on screen
 *   and the page is visible. Under `prefers-reduced-motion` nothing moves and
 *   `stillFrame` is drawn once, with `still` set so a drawing can compose a
 *   finished picture rather than frame zero of an animation.
 * - Labels. Text on a drawing is real text: `draw` returns where each label
 *   goes in design pixels and the label is set in the pixel face over the
 *   canvas, hidden from assistive technology, which reads `label` instead.
 *
 * Give the host a size with `className` or `style`; the canvas fills it.
 */

export interface DitherGrid {
  /** Size of the drawing in design pixels. */
  w: number;
  h: number;
  /** CSS pixels to a design pixel. */
  unit: number;
  frame: number;
  /** True when motion is reduced: draw the finished picture. */
  still: boolean;
}

export interface DitherLabel {
  text: string;
  /** Position in design pixels. */
  x: number;
  y: number;
  /** Which edge of the label `x` names. Left when omitted. */
  align?: 'left' | 'right' | 'center';
  /** Set the label on a plate of ink so it reads over a busy drawing. On by default. */
  plate?: boolean;
  /** Ink type, for a label that sits on a paper fill. */
  ink?: boolean;
  /** Dropped on narrow drawings. */
  wideOnly?: boolean;
}

export interface DitherPicture {
  bits: Uint8Array | Raster;
  labels?: readonly DitherLabel[];
}

export interface DitherCanvasProps {
  draw: (grid: DitherGrid) => DitherPicture | Uint8Array | Raster;
  /** What the drawing shows, for a reader who cannot see it. Without it the canvas is decorative. */
  label?: string;
  /** Frames a second while visible. Zero, the default, draws once. */
  fps?: number;
  /** The frame drawn first, and the only one drawn when motion is reduced. */
  stillFrame?: number;
  /** CSS pixels to a design pixel. */
  unit?: number;
  /** Cover the host, overflowing by part of a design pixel, instead of fitting inside it. */
  cover?: boolean;
  maxCells?: number;
  /** Swap the two inks. */
  invert?: boolean;
  /** Knock out every other pixel: a picture held still behind something. */
  held?: boolean;
  /** Stop the frames without unmounting. */
  paused?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

const sameLabels = (a: readonly DitherLabel[], b: readonly DitherLabel[]) =>
  a.length === b.length && a.every((label, i) => JSON.stringify(label) === JSON.stringify(b[i]));

export function DitherCanvas(props: DitherCanvasProps) {
  const { draw, label, fps = 0, stillFrame = 0, unit = UNIT, cover = false, maxCells = 180_000, invert = false, held = false, paused = false, className, style, children } = props;
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const labelBox = useRef<HTMLDivElement>(null);
  const [labels, setLabels] = useState<readonly DitherLabel[]>([]);
  const [grid, setGrid] = useState<{ w: number; h: number; unit: number } | null>(null);
  const [reduced, setReduced] = useState(false);
  const frame = useRef(stillFrame);
  const paint = useRef<() => void>(() => undefined);
  const live = useRef({ draw, invert, held, labels });
  live.current = { draw, invert, held, labels };

  // Follow the reader's motion preference.
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const read = () => setReduced(query.matches);
    read();
    query.addEventListener('change', read);
    return () => query.removeEventListener('change', read);
  }, []);

  // Measure the host and keep the grid in step with it.
  useLayoutEffect(() => {
    const element = host.current;
    if (element === null) return;
    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (width === 0 || height === 0) return;
      let size = unit;
      const cells = (u: number) => (cover ? Math.ceil(width / u) * Math.ceil(height / u) : Math.floor(width / u) * Math.floor(height / u));
      while (cells(size) > maxCells) size += 1;
      const w = Math.max(8, cover ? Math.ceil(width / size) : Math.floor(width / size));
      const h = Math.max(8, cover ? Math.ceil(height / size) : Math.floor(height / size));
      setGrid((before) => (before !== null && before.w === w && before.h === h && before.unit === size ? before : { w, h, unit: size }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [unit, cover, maxCells]);

  // Draw on a new grid, a new draw function or new paint options. The bitmap, the box it is shown
  // in and the picture change together, before the browser paints, so no frame shows one without the others.
  useLayoutEffect(() => {
    const element = canvas.current;
    if (element === null || grid === null) return;
    const context = element.getContext('2d');
    if (context === null) return;
    if (element.width !== grid.w) element.width = grid.w;
    if (element.height !== grid.h) element.height = grid.h;
    element.style.width = `${grid.w * grid.unit}px`;
    element.style.height = `${grid.h * grid.unit}px`;
    const image = context.createImageData(grid.w, grid.h);
    paint.current = () => {
      const picture = live.current.draw({ ...grid, frame: frame.current, still: reduced || fps === 0 });
      const made = picture instanceof Uint8Array || picture instanceof Raster ? { bits: picture } : picture;
      const bits = made.bits instanceof Raster ? made.bits.bits() : made.bits;
      if (bits.length !== grid.w * grid.h) return;
      bitsToImageData(bits, image.data, grid.w, grid.h, { invert: live.current.invert, held: live.current.held });
      context.putImageData(image, 0, 0);
      const next = made.labels ?? [];
      if (!sameLabels(next, live.current.labels)) setLabels(next);
    };
    if (reduced) frame.current = stillFrame;
    paint.current();
  }, [grid, draw, fps, stillFrame, reduced, invert, held]);

  // Advance the frames, only while the canvas is on screen and the page is visible.
  useEffect(() => {
    const element = canvas.current;
    if (element === null || grid === null || reduced || fps <= 0 || paused) return;
    let visible = true;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) visible = entry.isIntersecting;
    });
    observer.observe(element);
    const timer = window.setInterval(() => {
      if (!visible || document.hidden) return;
      frame.current += 1;
      paint.current();
    }, 1000 / fps);
    return () => {
      observer.disconnect();
      window.clearInterval(timer);
    };
  }, [grid, fps, reduced, paused]);

  // Centred and right-aligned labels are placed on whole pixels, so the type stays sharp.
  useLayoutEffect(() => {
    const box = labelBox.current;
    if (box === null || grid === null) return;
    for (const element of Array.from(box.children) as HTMLElement[]) {
      const x = Number(element.dataset.x) * grid.unit;
      const align = element.dataset.align;
      const width = element.offsetWidth;
      const limit = grid.w * grid.unit;
      let left = align === 'right' ? x - width : align === 'center' ? Math.round(x - width / 2) : x;
      left = Math.max(0, Math.min(limit - width, left));
      element.style.left = `${left}px`;
    }
  }, [labels, grid]);

  const narrow = grid !== null && grid.w < 120;
  return (
    <div ref={host} className={className === undefined ? 'hf-dither' : `hf-dither ${className}`} style={style}>
      <canvas
        ref={canvas}
        className="hf-dither__canvas"
        {...(label === undefined ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}
      />
      <div ref={labelBox} className="hf-dither__labels" aria-hidden="true">
        {grid !== null &&
          labels
            .filter((item) => !(narrow && item.wideOnly === true))
            .map((item, index) => (
              <span
                key={`${index}:${item.text}`}
                className={`hf-dither__label${item.plate === false ? ' hf-dither__label--bare' : ''}${item.ink === true ? ' hf-dither__label--ink' : ''}`}
                data-x={item.x}
                data-align={item.align ?? 'left'}
                style={{ top: item.y * grid.unit }}
              >
                {item.text}
              </span>
            ))}
      </div>
      {children}
    </div>
  );
}
