import { FORCE_INK, FORCE_PAPER, Raster, fbm, hash, smoothstep } from './raster';

/**
 * The drawn objects of Holdfast other than the ship: the keys, a length of
 * chain pulled taut, and a ruled page of books. Each is a distance field or a
 * few rectangles, lit from the upper left and left to the dither.
 */

export type KeyKind = 'view' | 'agent' | 'access' | 'delegate' | 'spend';

function sdBox(x: number, y: number, hx: number, hy: number): number {
  const dx = Math.abs(x) - hx;
  const dy = Math.abs(y) - hy;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
}

/** Lengths of the teeth, from the tip inwards. A viewing key has none: it opens nothing. */
const TEETH: Record<KeyKind, readonly number[]> = {
  view: [],
  agent: [8, 5, 7],
  access: [6, 6, 6, 6],
  delegate: [8, 4],
  spend: [7, 4, 8, 5, 6],
};

/** Length and height of a key at scale 1, in design pixels. */
export const KEY_LENGTH = 59;
export const KEY_HEIGHT = 21;

/**
 * Signed distance to a key lying with its bow at the origin and its bit to
 * the right. The bow tells the kinds apart: an eye for the viewing key, a
 * ring for the agent key, a square for the access key, a diamond for the
 * delegate.
 */
export function keyDistance(kind: KeyKind): (x: number, y: number) => number {
  const R = 8;
  const reach = 44;
  const teeth = TEETH[kind];
  return (x, y) => {
    let d: number;
    if (kind === 'access') d = Math.abs(sdBox(x, y, 6, 6) - 1.6) - 2.2;
    else if (kind === 'delegate') d = Math.abs(sdBox((x + y) * 0.7071, (x - y) * 0.7071, 4.8, 4.8) - 1.4) - 2.1;
    else if (kind === 'view') {
      const q = Math.hypot(x, y);
      d = Math.min(Math.abs(q - R) - 2.1, q - 2.7);
    } else d = Math.abs(Math.hypot(x, y) - R) - 2.4;
    const sx = Math.max(R, Math.min(reach, x));
    d = Math.min(d, Math.hypot(x - sx, y) - 2.2);
    d = Math.min(d, sdBox(x - (R + 6.5), y, 1.3, 4.3));
    for (let k = 0; k < teeth.length; k++) {
      const len = teeth[k] as number;
      d = Math.min(d, sdBox(x - (reach - 2 - k * 5), y - (1 + len / 2), 1.6, len / 2));
    }
    if (kind === 'view') d = Math.min(d, Math.hypot(x - reach, y) - 3.4);
    return d;
  };
}

export interface KeyPlateOptions {
  /** The key stopped against a hatched wall, with what flew off it. */
  refused?: boolean;
  /** Varies the scatter of a refused key. */
  seed?: number;
}

/**
 * A key on its plate, as large as the plate allows. The spending key is an
 * outline only: it is the key that is not here.
 */
export function drawKeyPlate(w: number, h: number, kind: KeyKind, options: KeyPlateOptions = {}): Raster {
  const r = new Raster(w, h);
  const refused = options.refused === true;
  const wallMin = refused ? 14 : 0;
  const sc = Math.max(0.6, Math.min(1.4, (h - 5) / KEY_HEIGHT, (w - wallMin - 6) / KEY_LENGTH));
  const reach = 44 * sc;
  const span = KEY_LENGTH * sc;
  const free = w - span - wallMin;
  const x0 = Math.round(free * (refused ? 0.42 : 0.5));
  const ox = x0 + 11 * sc;
  const oy = Math.round(h / 2 - 2.5 * sc);
  const raw = keyDistance(kind);
  const sd = (x: number, y: number) => raw(x / sc, y / sc) * sc;
  const ghost = kind === 'spend';
  const z = new Float32Array(w * h);
  const inside = new Uint8Array(w * h);
  const bevel = 2.3 * sc;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = sd(x + 0.5 - ox, y + 0.5 - oy);
      if (d < 0) {
        const i = y * w + x;
        inside[i] = 1;
        const q = Math.min(-d, bevel) / bevel;
        z[i] = bevel * Math.sqrt(1 - (1 - q) * (1 - q));
      }
    }
  }

  const poolX = ox + reach / 2 - 2;
  const poolY = oy + 2 * sc;
  const Lx = -0.52;
  const Ly = -0.62;
  const Lz = 0.59;
  const zAt = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : (z[y * w + x] as number));
  const insideAt = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && inside[y * w + x] === 1;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (ghost) {
        const edge = !insideAt(x, y) && (insideAt(x - 1, y) || insideAt(x + 1, y) || insideAt(x, y - 1) || insideAt(x, y + 1));
        if (edge && ((x + y) & 1) === 0) r.set(x, y, FORCE_PAPER);
        continue;
      }
      if (insideAt(x, y)) {
        const zx = (zAt(x + 1, y) - zAt(x - 1, y)) * 0.5;
        const zy = (zAt(x, y + 1) - zAt(x, y - 1)) * 0.5;
        const nl = Math.hypot(zx, zy, 1);
        const nx = -zx / nl;
        const ny = -zy / nl;
        const nz = 1 / nl;
        const diffuse = Math.max(0, nx * Lx + ny * Ly + nz * Lz);
        const specular = Math.pow(Math.max(0, nx * -0.35 + ny * -0.42 + nz * 0.84), 22);
        r.shade(x, y, 0.04 + 1.02 * Math.pow(diffuse, 0.9) + 0.7 * specular);
      } else {
        let pool = 0.3 * Math.exp(-Math.pow((x - poolX) / (span * 0.56), 2) - Math.pow((y - poolY) / (h * 0.42), 2));
        // The key's own shadow on the plate.
        if (sd(x + 0.5 - ox - 2.4 * sc, y + 0.5 - oy - 3 * sc) < 0) pool = 0;
        r.shade(x, y, pool + (hash(x, y, 31) - 0.5) * 0.03);
      }
    }
  }

  if (refused) {
    const wallX = Math.round(ox + 48.5 * sc);
    for (let y = 0; y < h; y++) {
      for (let x = wallX; x < w; x++) r.set(x, y, x < wallX + 2 || ((x + y) & 3) === 0 ? FORCE_PAPER : FORCE_INK);
      r.set(wallX - 1, y, FORCE_INK);
    }
    const seed = kind.length * 37 + (options.seed ?? 0);
    for (let n = 0; n < 26; n++) {
      const a = (hash(n, seed, 1) - 0.5) * 2.5;
      const far = 4 + Math.pow(hash(n, seed, 2), 1.3) * 24 * sc;
      const px = Math.round(wallX - 2 - Math.cos(a) * far);
      const py = Math.round(oy + Math.sin(a) * far * 0.8);
      if (px < 1 || py < 1 || py >= h - 1 || insideAt(px, py)) continue;
      r.set(px, py, FORCE_PAPER);
      if (far < 11) r.set(px - 1, py, FORCE_PAPER);
    }
  }
  return r;
}

export interface ChainPlateOptions {
  /** Picks the angle and the scatter; three variants repeat. */
  variant?: number;
  /** Size of the links against the plate. */
  scale?: number;
  /** A level chain with nothing thrown off it. */
  flat?: boolean;
}

/**
 * A chain pulled taut, shaded per pixel: the moment a refusal stops a key.
 * Links alternate between seen flat and seen edge on; water hangs where it
 * was when the moment stopped.
 */
export function drawChainPlate(w: number, h: number, options: ChainPlateOptions = {}): Raster {
  const r = new Raster(w, h);
  const idx = options.variant ?? 0;
  const k = options.scale ?? 1;
  const flat = options.flat === true;
  const tone = new Float32Array(w * h);
  const object = new Uint8Array(w * h);
  const le = 11 * k;
  const RR = 11 * k;
  const th = 4.2 * k;
  const bl = 22 * k;
  const pitch = 36 * k;
  const angle = flat ? 0 : ([-0.34, 0.3, -0.18][idx % 3] as number);
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const cx0 = w * 0.5 + (flat ? 0 : ([6, -8, 0][idx % 3] as number) * k);
  const cy0 = h * 0.5;
  const Lx = -0.52;
  const Ly = -0.62;
  const Lz = 0.59;
  let Hx = Lx;
  let Hy = Ly;
  let Hz = Lz + 1;
  const Hl = Math.hypot(Hx, Hy, Hz);
  Hx /= Hl;
  Hy /= Hl;
  Hz /= Hl;

  type Normal = [number, number, number];
  // A stadium ring seen flat.
  const face = (u: number, v: number): Normal | null => {
    const qx = Math.max(0, Math.abs(u) - le);
    const l = Math.sqrt(qx * qx + v * v);
    const dc = l - RR;
    if (Math.abs(dc) >= th) return null;
    const sign = u < 0 ? -1 : 1;
    const t = dc / th;
    return [l > 0 ? (qx / l) * sign * t : 0, l > 0 ? (v / l) * t : 0, Math.sqrt(1 - t * t)];
  };
  // The same link seen edge on.
  const bar = (u: number, v: number): Normal | null => {
    const qx = Math.max(0, Math.abs(u) - bl);
    const l = Math.sqrt(qx * qx + v * v);
    if (l >= th) return null;
    const sign = u < 0 ? -1 : 1;
    const t = l / th;
    return [l > 0 ? (qx / l) * sign * t : 0, l > 0 ? (v / l) * t : 0, Math.sqrt(1 - t * t)];
  };
  const shade = (n: Normal): number => {
    const nx = n[0] * ca - n[1] * sa;
    const ny = n[0] * sa + n[1] * ca;
    const nz = n[2];
    const diffuse = Math.max(0, nx * Lx + ny * Ly + nz * Lz);
    const specular = Math.pow(Math.max(0, nx * Hx + ny * Hy + nz * Hz), 26);
    const back = Math.max(0, nx * 0.62 + ny * 0.55 + nz * 0.1) * 0.2;
    return 0.03 + 0.98 * Math.pow(diffuse, 0.85) + 0.9 * specular + back;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const dx = x - cx0;
      const dy = y - cy0;
      const u = dx * ca + dy * sa;
      const v = -dx * sa + dy * ca;
      const j = Math.round(u / pitch);
      let t = -1;
      let top = 0;
      // The nearest three links: bars lie over the flat links and throw a short shadow on them.
      for (let q = j - 1; q <= j + 1; q++) {
        const uu = u - q * pitch;
        if (q & 1) {
          const n = bar(uu, v);
          if (n !== null) {
            t = shade(n);
            top = 2;
          }
        } else if (top < 2) {
          const n = face(uu, v);
          if (n !== null) {
            t = shade(n);
            top = 1;
            const sx = x - 2.4 * k;
            const sy = y - 3 * k;
            const su = (sx - cx0) * ca + (sy - cy0) * sa;
            const sv = -(sx - cx0) * sa + (sy - cy0) * ca;
            for (let b = j - 2; b <= j + 2; b++) {
              if (b & 1 && bar(su - b * pitch, sv) !== null) {
                t *= 0.3;
                break;
              }
            }
          }
        }
      }
      if (top > 0) {
        tone[i] = t;
        object[i] = 1;
      } else {
        // Dark water with a few shafts of light.
        tone[i] = 0.15 * smoothstep(0.56, 0.61, fbm((x + 0.5 * y) * 0.05 + idx * 7, 2.2)) * smoothstep(h * 1.2, h * 0.15, y) * smoothstep(th + 5 * k, th + 24 * k, Math.abs(v) - RR);
      }
    }
  }

  const SPRAY = 2;
  if (!flat) {
    const seed = idx * 131 + 7;
    const drops = Math.round((w * h) / 250);
    for (let n = 0; n < drops; n++) {
      const pu = (hash(n, seed, 1) - 0.5) * pitch * 2.6;
      const side = hash(n, seed, 2) < 0.5 ? -1 : 1;
      const far = Math.pow(hash(n, seed, 3), 1.4);
      const pv = side * (RR + th + 3 * k + far * h * 0.34);
      const len = 1 + Math.round((1 - far) * 3.2 * k + hash(n, seed, 4) * 1.5);
      for (let m = 0; m < len; m++) {
        const qv = pv - side * m;
        const px = Math.round(cx0 + pu * ca - qv * sa + pu * 0.25 * far);
        const py = Math.round(cy0 + pu * sa + qv * ca);
        if (px < 1 || py < 1 || px >= w - 1 || py >= h - 1 || object[py * w + px] === 1) continue;
        tone[py * w + px] = SPRAY;
        if (m === 0 && far < 0.45) {
          tone[py * w + px + 1] = SPRAY;
          tone[(py + 1) * w + px] = SPRAY;
          tone[(py + 1) * w + px + 1] = SPRAY;
        }
      }
    }
  }

  const dark = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && object[y * w + x] === 1 && (tone[y * w + x] as number) < 0.3;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const t = tone[i] as number;
      if (t >= SPRAY) {
        r.set(x, y, FORCE_PAPER);
        continue;
      }
      // A paper keyline round every shadowed edge.
      if (object[i] !== 1 && (dark(x - 1, y) || dark(x + 1, y) || dark(x, y - 1) || dark(x, y + 1))) {
        r.set(x, y, FORCE_PAPER);
        continue;
      }
      r.shade(x, y, t + (hash(x, y, idx + 60) - 0.5) * 0.04);
    }
  }
  return r;
}

/** The books: a ruled page with every line ticked. */
export function drawBooksPlate(w: number, h: number): Raster {
  const r = new Raster(w, h);
  const bw = Math.min(w - 10, 28);
  const bh = h - 8;
  const x0 = Math.round((w - bw) / 2);
  const y0 = 4;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) r.shade(x, y, 0.28 * Math.exp(-Math.pow((x - w / 2) / (w * 0.5), 2) - Math.pow((y - h / 2) / (h * 0.5), 2)));
  }
  r.shadeRect(x0 + 2, y0 + 2, bw, bh, 0);
  r.rect(x0, y0, bw, bh, FORCE_PAPER);
  r.rect(x0 + 3, y0 + 3, bw - 6, 2, FORCE_INK);
  for (let j = 0; j < 7; j++) {
    const ry = y0 + 8 + j * 4;
    if (ry > y0 + bh - 3) break;
    r.rect(x0 + 3, ry, bw - 14 - ((j * 5) % 7), 1, FORCE_INK);
    r.set(x0 + bw - 8, ry, FORCE_INK);
    r.set(x0 + bw - 7, ry + 1, FORCE_INK);
    r.set(x0 + bw - 6, ry, FORCE_INK);
    r.set(x0 + bw - 5, ry - 1, FORCE_INK);
    r.set(x0 + bw - 4, ry - 2, FORCE_INK);
  }
  return r;
}
