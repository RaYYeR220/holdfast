/**
 * The one-bit raster everything drawn in Holdfast is made of. A picture is a
 * grid of design pixels, each either ink or paper. Tone exists only as the
 * density of an ordered dither on a 4 by 4 grid: 12.5, 25, 50 and 75 percent.
 *
 * Nothing here touches the DOM, so the same drawings are rendered in the
 * browser and on the server.
 */

export type Rgb = readonly [number, number, number];

/** The two inks. They are the only colours any pixel or any text takes. */
export const INK: Rgb = [0x17, 0x26, 0x1f];
export const PAPER: Rgb = [0xe9, 0xe6, 0xd2];
export const INK_HEX = '#17261F';
export const PAPER_HEX = '#E9E6D2';

/** Edge of one design pixel in CSS pixels, before any enlargement. */
export const UNIT = 4;

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5] as const;

/** A tone between 0 and 1 snapped to the densities the dither can print. */
export function quantise(tone: number): number {
  if (tone < 0.0625) return 0;
  if (tone < 0.19) return 0.125;
  if (tone < 0.375) return 0.25;
  if (tone < 0.625) return 0.5;
  if (tone < 0.875) return 0.75;
  return 1;
}

/** Whether the pixel at (x, y) is paper for an already quantised tone. */
export function ditherOn(level: number, x: number, y: number): boolean {
  return level * 16 > (BAYER4[((y & 3) << 2) | (x & 3)] as number) + 0.5;
}

/** Whether the pixel at (x, y) is paper for any tone between 0 and 1. */
export function lit(tone: number, x: number, y: number): boolean {
  return ditherOn(quantise(tone), x, y);
}

export const FOLLOW = 0;
export const FORCE_INK = 1;
export const FORCE_PAPER = 2;
export type Forced = typeof FORCE_INK | typeof FORCE_PAPER;

/**
 * A picture being drawn: a tone for every pixel, and over it pixels forced to
 * ink or to paper. Lines and marks are forced; fills and light are tones.
 */
export class Raster {
  readonly w: number;
  readonly h: number;
  readonly tone: Float32Array;
  readonly forced: Uint8Array;

  constructor(w: number, h: number) {
    this.w = Math.max(1, Math.floor(w));
    this.h = Math.max(1, Math.floor(h));
    this.tone = new Float32Array(this.w * this.h);
    this.forced = new Uint8Array(this.w * this.h);
  }

  private at(x: number, y: number): number {
    return x >= 0 && y >= 0 && x < this.w && y < this.h ? y * this.w + x : -1;
  }

  /** Give one pixel a tone and let the dither decide it. */
  shade(x: number, y: number, tone: number): void {
    const i = this.at(x, y);
    if (i < 0) return;
    this.tone[i] = tone;
    this.forced[i] = FOLLOW;
  }

  /** Force one pixel to ink or to paper. */
  set(x: number, y: number, value: Forced): void {
    const i = this.at(x, y);
    if (i >= 0) this.forced[i] = value;
  }

  forcedAt(x: number, y: number): number {
    const i = this.at(x, y);
    return i < 0 ? FOLLOW : (this.forced[i] as number);
  }

  toneAt(x: number, y: number): number {
    const i = this.at(x, y);
    return i < 0 ? 0 : (this.tone[i] as number);
  }

  rect(x: number, y: number, w: number, h: number, value: Forced): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, value);
  }

  shadeRect(x: number, y: number, w: number, h: number, tone: number): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.shade(x + i, y + j, tone);
  }

  /** A vertical run between two rows, in either order, both included. */
  vline(x: number, y0: number, y1: number, value: Forced): void {
    const from = Math.min(y0, y1);
    const to = Math.max(y0, y1);
    for (let y = from; y <= to; y++) this.set(x, y, value);
  }

  hline(x0: number, x1: number, y: number, value: Forced): void {
    const from = Math.min(x0, x1);
    const to = Math.max(x0, x1);
    for (let x = from; x <= to; x++) this.set(x, y, value);
  }

  line(x0: number, y0: number, x1: number, y1: number, value: Forced): void {
    walkLine(x0, y0, x1, y1, (x, y) => this.set(x, y, value));
  }

  /** Whether a pixel comes out as paper. */
  isPaper(x: number, y: number): boolean {
    const i = this.at(x, y);
    if (i < 0) return false;
    const forced = this.forced[i];
    if (forced === FORCE_PAPER) return true;
    if (forced === FORCE_INK) return false;
    return lit(this.tone[i] as number, x, y);
  }

  /** The finished picture, one byte a pixel: 1 for paper, 0 for ink. */
  bits(): Uint8Array {
    const out = new Uint8Array(this.w * this.h);
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) out[y * this.w + x] = this.isPaper(x, y) ? 1 : 0;
    return out;
  }
}

/** Visit every pixel of a straight line. The third argument counts the steps. */
export function walkLine(x0: number, y0: number, x1: number, y1: number, visit: (x: number, y: number, n: number) => void): void {
  let x = Math.round(x0);
  let y = Math.round(y0);
  const ex = Math.round(x1);
  const ey = Math.round(y1);
  const dx = Math.abs(ex - x);
  const dy = -Math.abs(ey - y);
  const sx = x < ex ? 1 : -1;
  const sy = y < ey ? 1 : -1;
  let error = dx + dy;
  let n = 0;
  for (;;) {
    visit(x, y, n++);
    if (x === ex && y === ey) break;
    const twice = 2 * error;
    if (twice >= dy) {
      error += dy;
      x += sx;
    }
    if (twice <= dx) {
      error += dx;
      y += sy;
    }
  }
}

/* ---------- small deterministic noise ---------- */

/** A repeatable value between 0 and 1 for a lattice point. */
export function hash(x: number, y: number, z = 0): number {
  let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 2147483647)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}

export function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let xf = x - xi;
  let yf = y - yi;
  xf = xf * xf * (3 - 2 * xf);
  yf = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, 7);
  const b = hash(xi + 1, yi, 7);
  const c = hash(xi, yi + 1, 7);
  const d = hash(xi + 1, yi + 1, 7);
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}

export function fbm(x: number, y: number): number {
  return valueNoise(x, y) * 0.55 + valueNoise(x * 2.1 + 11, y * 2.1 + 5) * 0.3 + valueNoise(x * 4.3 + 3, y * 4.3 + 17) * 0.15;
}

export function smoothstep(a: number, b: number, x: number): number {
  let t = (x - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

/* ---------- putting a picture on a canvas ---------- */

/**
 * Write bits into image data as the two inks. `invert` swaps them; `held`
 * knocks out every other pixel, which is how a frozen picture is shown.
 */
export function bitsToImageData(bits: Uint8Array, data: Uint8ClampedArray, w: number, h: number, options: { invert?: boolean; held?: boolean } = {}): void {
  const invert = options.invert === true;
  const held = options.held === true;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let on = bits[i] === 1;
      if (held && ((x + y) & 1) === 0) on = false;
      if (invert) on = !on;
      const colour = on ? PAPER : INK;
      const o = i * 4;
      data[o] = colour[0];
      data[o + 1] = colour[1];
      data[o + 2] = colour[2];
      data[o + 3] = 255;
    }
  }
}
