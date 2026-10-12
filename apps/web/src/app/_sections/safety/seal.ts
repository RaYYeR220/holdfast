import { FORCE_INK, FORCE_PAPER, Raster, hash } from '../../../ui/onebit/raster';

/**
 * The attester's object: a seal, where the other four are keys. It opens
 * nothing; it marks a page. A scalloped rim lit from the upper left, as the
 * keys are, round a flat face that carries a tick.
 */

/** Height of a key at scale 1; the seal is sized against it so that it sits on a plate as a key does. */
const KEY_HEIGHT = 21;

/** Distance from a point to the segment between two others. */
function toSegment(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - ax - dx * t, y - ay - dy * t);
}

export function drawSealPlate(w: number, h: number): Raster {
  const r = new Raster(w, h);
  const sc = Math.max(0.6, Math.min(1.4, (h - 5) / KEY_HEIGHT, (w - 6) / 26));
  const R = 9.6 * sc;
  const face = 5.9 * sc;
  const ox = Math.round(w / 2);
  const oy = Math.round(h / 2 - 1.5 * sc);
  const bevel = 2.6 * sc;

  // The rim's edge runs in and out twelve times round the seal.
  const rim = (x: number, y: number) => Math.hypot(x, y) - (R + 0.75 * sc * Math.cos(Math.atan2(y, x) * 12));
  const tick = (x: number, y: number) => Math.min(toSegment(x, y, -3.1 * sc, 0.3 * sc, -1 * sc, 2.4 * sc), toSegment(x, y, -1 * sc, 2.4 * sc, 3.3 * sc, -2.6 * sc));

  const z = new Float32Array(w * h);
  const inside = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = rim(x + 0.5 - ox, y + 0.5 - oy);
      if (d >= 0) continue;
      const i = y * w + x;
      inside[i] = 1;
      // Rounded at the outer edge and again where the rim meets the face.
      const out = Math.min(-d, bevel) / bevel;
      const inner = Math.min(Math.max(0, Math.hypot(x + 0.5 - ox, y + 0.5 - oy) - face), bevel) / bevel;
      const q = Math.min(out, inner);
      z[i] = bevel * Math.sqrt(1 - (1 - q) * (1 - q));
    }
  }
  const zAt = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : (z[y * w + x] as number));
  const Lx = -0.52;
  const Ly = -0.62;
  const Lz = 0.59;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - ox;
      const py = y + 0.5 - oy;
      if (inside[y * w + x] !== 1) {
        let pool = 0.3 * Math.exp(-Math.pow(px / (w * 0.42), 2) - Math.pow((py - 2 * sc) / (h * 0.42), 2));
        // The seal's own shadow on the plate.
        if (rim(px - 2.4 * sc, py - 3 * sc) < 0) pool = 0;
        r.shade(x, y, pool + (hash(x, y, 31) - 0.5) * 0.03);
        continue;
      }
      const centre = Math.hypot(px, py);
      if (centre < face) {
        // The face is flat paper; the tick is cut into it.
        r.set(x, y, tick(px, py) < 0.95 * sc ? FORCE_INK : FORCE_PAPER);
        continue;
      }
      if (centre < face + 1) {
        r.set(x, y, FORCE_INK);
        continue;
      }
      const zx = (zAt(x + 1, y) - zAt(x - 1, y)) * 0.5;
      const zy = (zAt(x, y + 1) - zAt(x, y - 1)) * 0.5;
      const nl = Math.hypot(zx, zy, 1);
      const nx = -zx / nl;
      const ny = -zy / nl;
      const nz = 1 / nl;
      const diffuse = Math.max(0, nx * Lx + ny * Ly + nz * Lz);
      const specular = Math.pow(Math.max(0, nx * -0.35 + ny * -0.42 + nz * 0.84), 22);
      r.shade(x, y, 0.04 + 1.02 * Math.pow(diffuse, 0.9) + 0.7 * specular);
    }
  }
  return r;
}
