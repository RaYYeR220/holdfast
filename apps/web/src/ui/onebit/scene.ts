import { type KeyKind, keyDistance } from './objects';
import { ditherOn, fbm, hash, quantise, smoothstep, valueNoise, walkLine } from './raster';

/**
 * The picture Holdfast is named for: a ship held by a chain to an anchor in
 * the ground. One builder draws the ship at anchor and the bare seabed the
 * anchor holds. It is given a layout in design pixels and returns frames as
 * bits; it measures nothing itself, so it runs in the browser and on the
 * server alike.
 */

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A bar of cloud: column, row, half length, half thickness, tone. */
export type Cloud = readonly [number, number, number, number, number];
/** A rock on the bed: column, half width, height. */
export type Rock = readonly [number, number, number];
/** A frond of weed: column, height. */
export type Kelp = readonly [number, number];

export interface SceneLayout {
  kind: 'ship' | 'bed';
  w: number;
  h: number;
  /** Row of the waterline. A bed scene is all under water and has none. */
  waterline: number;
  /** A narrow screen: a short straight chain and a mirrored anchor. */
  compact: boolean;
  /** Scale of the ship, and the column of its middle. */
  k: number;
  ox: number;
  moon: { x: number; y: number; r: number };
  clouds: readonly Cloud[];
  rocks: readonly Rock[];
  kelp: readonly Kelp[];
  anchor: { x: number; length: number; mirrored: boolean };
  /** Where the chain starts when no ship is drawn. */
  chainFrom?: { x: number; y: number };
  /** How late the chain leaves the vertical: 1 is a straight line. */
  chainCurve: number;
  /** Left of this column the water and the ground stay dark, for text. */
  calmX: number;
  /** Boxes that text stands on. Sky and water clear inside them. */
  quiet: readonly Rect[];
  /** Hang the three keys on the chain, each at this scale. Zero hangs none. */
  keyScale: number;
}

export interface ChainLink {
  x: number;
  y: number;
  /** Which third of the chain the link is in, from the ship down. */
  section: number;
}

export interface HangingKey {
  section: number;
  kind: KeyKind;
  /** Centre of the bow. */
  bowX: number;
  bowY: number;
  /** Column of the link the key hangs from. */
  hookX: number;
  /** Bounding box of the key, in design pixels. */
  box: Rect;
}

export interface Scene {
  layout: SceneLayout;
  links: readonly ChainLink[];
  keys: readonly HangingKey[];
  /** One frame as bits, 1 for paper. `hot` is the chain section to fill, or -1. */
  render(frame: number, hot: number): Uint8Array;
}

const INK = 1;
const T12 = 2;
const T25 = 3;
const T50 = 4;
const T75 = 5;
const PAP = 6;
const LEVEL = [0, 0, 0.125, 0.25, 0.5, 0.75, 1] as const;

/* Chain links as small bitmaps: seen flat and seen edge on, in three directions. */
const FLAT_V = ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'];
const EDGE_V = ['.#.', '###', '###', '###', '###', '###', '.#.'];
const FLAT_H = ['.#######.', '#.......#', '#.......#', '#.......#', '.#######.'];
const EDGE_H = ['.#####.', '#######', '.#####.'];
const FLAT_D = ['.##.....', '#..#....', '#...#...', '.#...#..', '..#...#.', '...#...#', '....#..#', '.....##.'];
const EDGE_D = ['##....', '.##...', '..##..', '...##.', '....##'];

const mirror = (rows: readonly string[]) => rows.map((row) => row.split('').reverse().join(''));
const filled = (rows: readonly string[]) =>
  rows.map((row) => {
    const a = row.indexOf('#');
    const b = row.lastIndexOf('#');
    let out = '';
    for (let i = 0; i < row.length; i++) out += a >= 0 && i >= a && i <= b ? '#' : '.';
    return out;
  });

const KEY_OF_SECTION: readonly KeyKind[] = ['view', 'agent', 'access'];

interface Link extends ChainLink {
  face: boolean;
  dir: 'v' | 'h' | 'd';
  sign: number;
}

export function buildScene(layout: SceneLayout): Scene {
  const W = Math.max(8, Math.floor(layout.w));
  const H = Math.max(8, Math.floor(layout.h));
  const WL = layout.waterline;
  const { k, ox, compact, calmX } = layout;
  const ship = layout.kind === 'ship';

  const tone = new Float32Array(W * H);
  const calm = new Float32Array(W * H).fill(1);
  const still = new Uint8Array(W * H);
  const frameLevels = new Uint8Array(W * H);
  const out = new Uint8Array(W * H);
  let L = still;

  const P = (x: number, y: number, v: number) => {
    x |= 0;
    y |= 0;
    if (x >= 0 && y >= 0 && x < W && y < H) L[y * W + x] = v;
  };
  const levelAt = (x: number, y: number) => (x >= 0 && y >= 0 && x < W && y < H ? (L[y * W + x] as number) : 0);
  const line = walkLine;
  const Ln = (x0: number, y0: number, x1: number, y1: number, v: number) => line(x0, y0, x1, y1, (x, y) => P(x, y, v));

  function poly(points: readonly (readonly [number, number])[], v: number): void {
    let minY = 1e9;
    let maxY = -1e9;
    for (const p of points) {
      minY = Math.min(minY, p[1]);
      maxY = Math.max(maxY, p[1]);
    }
    for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
      const xs: number[] = [];
      const yc = y + 0.5;
      for (let i = 0; i < points.length; i++) {
        const a = points[i] as readonly [number, number];
        const b = points[(i + 1) % points.length] as readonly [number, number];
        if ((a[1] <= yc && b[1] > yc) || (b[1] <= yc && a[1] > yc)) xs.push(a[0] + ((yc - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        for (let x = Math.round(xs[i] as number); x < Math.round(xs[i + 1] as number); x++) P(x, y, v);
      }
    }
  }

  const bright = (x: number, y: number) => {
    x |= 0;
    y |= 0;
    return x >= 0 && y >= 0 && x < W && y < H && (tone[y * W + x] as number) > 0.3;
  };
  // A line that is ink where the ground is light and a dotted paper line where it is dark.
  const rig = (x0: number, y0: number, x1: number, y1: number, dotted = false) =>
    line(x0, y0, x1, y1, (x, y) => {
      if (bright(x, y)) P(x, y, INK);
      else if (!dotted || ((x + y) & 1) === 0) P(x, y, dotted ? PAP : T75);
    });

  /* ----- where the text stands, nothing is drawn behind it ----- */
  function buildCalm(): void {
    for (const box of layout.quiet) {
      const reach = 16;
      for (let y = Math.max(0, Math.floor(box.y0 - reach)); y < Math.min(H, Math.ceil(box.y1 + reach)); y++) {
        for (let x = Math.max(0, Math.floor(box.x0 - reach)); x < Math.min(W, Math.ceil(box.x1 + reach)); x++) {
          const dx = Math.max(box.x0 - x, 0, x - box.x1);
          const dy = Math.max(box.y0 - y, 0, y - box.y1);
          const free = smoothstep(1, reach, Math.hypot(dx, dy * 1.6));
          const i = y * W + x;
          if (free < (calm[i] as number)) calm[i] = free;
        }
      }
    }
  }

  /* ----- sky, moon and water as a field of tone ----- */
  function buildTone(): void {
    if (!ship) {
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const depth = y / H;
          const shaft = fbm((x - 0.3 * y) * 0.075 + 4.7, 0.5);
          tone[y * W + x] = smoothstep(0.5, 0.6, shaft) * 0.36 * (1 - depth * 0.75) * smoothstep(calmX - 26, calmX + 14, x) * smoothstep(-2, 10, y) * (calm[y * W + x] as number);
        }
      }
      return;
    }
    const { x: mx, y: my, r: mr } = layout.moon;
    const shaftSpread = compact ? 30 : Math.max(86, W * 0.26);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        let t = 0;
        if (y < WL) {
          const d = Math.hypot(x - mx, y - my);
          // The halo is the four dither densities, in rings.
          t = d < mr ? 1 : d < mr * 1.22 ? 0.75 : d < mr * 1.6 ? 0.5 : d < mr * 2.2 ? 0.25 : d < mr * 3.0 ? 0.125 : 0;
          // Long low bars of cloud, lit from the moon side.
          for (let c = 0; c < layout.clouds.length; c++) {
            const cloud = layout.clouds[c] as Cloud;
            const ux = (x - cloud[0]) / cloud[2];
            const uy = (y - cloud[1] + 1.2 * Math.sin(x * 0.07 + c * 2.1)) / cloud[3];
            if (ux * ux + uy * uy < 1) {
              const lit = cloud[4] * (1 - 0.55 * ux * ux) * (uy < 0.1 ? 1 : 0.5);
              if (d > mr * 1.08 && lit > t) t = lit;
            }
          }
          // Glow along the horizon, so the hull has something to stand against.
          const glow = 0.62 * Math.exp(-Math.pow((x - mx) / (mr * 3.4), 2)) * smoothstep(WL - 9, WL - 1, y);
          if (glow > t) t = glow;
          if (d > mr) t *= calm[i] as number;
        } else if (y > WL) {
          const dp = y - WL - 1;
          const depth = dp / (H - WL);
          const base = 0.6 * Math.exp(-dp / (compact ? 2.4 : 3.2));
          // Moon shafts falling under the ship.
          const sx = x - 0.3 * dp;
          const near = Math.exp(-Math.pow((sx - ox) / shaftSpread, 2));
          let shaft = smoothstep(0.5, 0.6, fbm(sx * 0.075 + 9.3, 0.5)) * near * (0.38 * Math.exp(-depth * 2.1));
          shaft *= 1 - 0.8 * Math.exp(-Math.pow((x - ox + 2) / (38 * k), 4)) * Math.exp(-dp / 22);
          shaft *= smoothstep(calmX - 26, calmX + 14, x);
          t = (base + shaft) * (calm[i] as number);
        }
        tone[i] = t;
      }
    }
  }

  /* ----- the ship ----- */
  let hawseX = 0;
  let hawseY = 0;
  function drawShip(): void {
    const X = (v: number) => ox + v * k;
    const Y = (v: number) => WL + v * k;
    const sheer = (x: number) => -8 - 0.0024 * (x + 3) * (x + 3) - (x < -30 ? 3 : 0) - (x > 30 ? 2 : 0);
    const hull: [number, number][] = [];
    hull.push([-53, -10.5], [-52, sheer(-52)]);
    for (let x = -50; x <= -30.5; x += 2) hull.push([x, sheer(x)]);
    hull.push([-30.01, sheer(-30.01)], [-29.99, sheer(-29.99)]);
    for (let x = -28; x <= 30; x += 2) hull.push([x, sheer(x)]);
    hull.push([30.01, sheer(30.01)]);
    for (let x = 32; x <= 46; x += 2) hull.push([x, sheer(x)]);
    hull.push([48.5, sheer(46) + 0.5], [47.5, -9], [45, -4], [42.5, 0], [40.5, 4], [35, 7.5], [22, 9.2], [-30, 9.2], [-42, 8], [-47, 5], [-49.5, 0], [-50.5, -5]);
    poly(
      hull.map((p) => [X(p[0]), Y(p[1])] as const),
      INK,
    );
    // Rudder.
    Ln(X(-51), Y(1), X(-50), Y(8.5), INK);
    Ln(X(-52), Y(2), X(-51), Y(8.5), INK);
    // Hull lines seen by moonlight.
    for (let px = Math.round(X(-50)); px <= Math.round(X(46)); px++) {
      const m = (px - ox) / k;
      const top = Math.round(Y(sheer(m)));
      if (!bright(px, top - 1)) P(px, top, PAP);
      if (m > -49.5 && m < 45) {
        const wale = Math.round(Y(sheer(m) + 3));
        P(px, wale, PAP);
        P(px, wale + 1, PAP);
        if (k > 0.8) {
          P(px, wale + 2, PAP);
          const port = ((Math.round(m) % 6) + 6) % 6;
          if (port < 2 && m > -44 && m < 40) P(px, wale + 1, INK);
        }
      }
    }
    // Boot-top just above the water.
    for (let px = Math.round(X(-49)); px <= Math.round(X(42)); px++) if ((px & 1) === 0) P(px, WL - 1, T75);
    // Stern lantern and gallery.
    P(X(-52.5), Y(sheer(-52) - 3), INK);
    P(X(-52.5), Y(sheer(-52) - 4.6), PAP);
    P(X(-52.5) - 1, Y(sheer(-52) - 4.6), PAP);
    P(X(-50), Y(-10), PAP);
    P(X(-47.5), Y(-10), PAP);

    const masts = [
      { x: 26, deck: sheer(26), plat: -36, top: -66, yards: [[-33, 14], [-46, 10], [-58, 7]] },
      { x: -4, deck: sheer(-4), plat: -40, top: -74, yards: [[-37, 16], [-52, 12], [-65, 8]] },
      { x: -33, deck: sheer(-33), plat: -32, top: -56, yards: [[-29, 11], [-42, 8]] },
    ] as const;
    const fine = k > 0.8;
    rig(X(26), Y(-36), X(60), Y(-21));
    rig(X(26), Y(-66), X(75), Y(-26));
    if (fine) rig(X(26), Y(-52), X(69), Y(-24));
    rig(X(-4), Y(-74), X(26), Y(-56));
    if (fine) {
      rig(X(-4), Y(-40), X(24), Y(sheer(24) - 1));
      rig(X(-4), Y(-60), X(26), Y(-36));
      rig(X(-33), Y(-32), X(-7), Y(sheer(-7) - 1));
    }
    rig(X(-33), Y(-56), X(-4), Y(-40));
    for (const m of masts) {
      rig(X(m.x), Y(m.plat) + 1, X(m.x - 7.5), Y(sheer(m.x - 7.5)));
      rig(X(m.x) + 1, Y(m.plat) + 1, X(m.x + 7), Y(sheer(m.x + 7)));
      if (fine) {
        rig(X(m.x), Y(m.plat) + 1, X(m.x - 4), Y(sheer(m.x - 4)), true);
        rig(X(m.x) + 1, Y(m.plat) + 1, X(m.x + 4), Y(sheer(m.x + 4)), true);
        rig(X(m.x), Y(m.top + 5), X(m.x - 12), Y(sheer(m.x - 12)), true);
      }
    }
    for (const m of masts) {
      const mx0 = Math.round(X(m.x));
      const y0 = Math.round(Y(m.deck));
      const yp = Math.round(Y(m.plat));
      const yt = Math.round(Y(m.top));
      for (let y = yt; y <= y0; y++) {
        const wide = y >= yp;
        if (bright(mx0, y)) {
          P(mx0, y, INK);
          if (wide) P(mx0 + 1, y, INK);
        } else {
          P(mx0, y, PAP);
          if (wide) P(mx0 + 1, y, INK);
        }
      }
      const tw = Math.max(2, Math.round(2.6 * k));
      for (let i = -tw; i <= tw + 1; i++) P(mx0 + i, yp, bright(mx0 + i, yp) ? INK : PAP);
      // Yards with furled canvas.
      for (const yard of m.yards) {
        const yy = Math.round(Y(yard[0]));
        const hw = Math.round(yard[1] * k);
        for (let i = -hw; i <= hw + 1; i++) {
          const xx = mx0 + i;
          const knot = Math.abs(i) % 4 === 0;
          if (bright(xx, yy)) {
            P(xx, yy, INK);
            P(xx, yy + 1, knot || i === -hw || i === hw + 1 ? INK : PAP);
            P(xx, yy + 2, INK);
          } else {
            P(xx, yy, INK);
            P(xx, yy + 1, knot ? INK : PAP);
            P(xx, yy + 2, INK);
          }
        }
      }
      P(mx0, yt - 1, bright(mx0, yt - 1) ? INK : PAP);
    }
    // Pennant at the main truck.
    const main = masts[1];
    const px0 = Math.round(X(main.x));
    const py0 = Math.round(Y(main.top)) - 1;
    for (let i = 1; i <= Math.round(6 * k); i++) P(px0 - i, py0 + (i > 3 ? 1 : 0), bright(px0 - i, py0) ? INK : PAP);
    // Spanker gaff and boom on the mizzen.
    rig(X(-33), Y(-24), X(-50), Y(-31));
    rig(X(-33), Y(-16.5), X(-55), Y(-18));
    line(X(-34), Y(-23), X(-50), Y(-30), (x, y, n) => {
      if (n > 1 && n % 3 !== 0) P(x, y + 1, bright(x, y + 1) ? INK : PAP);
    });
    // Bowsprit and jib-boom.
    line(X(42), Y(-14.5), X(75), Y(-26), (x, y, n) => {
      P(x, y - 1, INK);
      P(x, y, PAP);
      P(x, y + 1, INK);
      if (n < 14 * k) {
        P(x, y + 1, PAP);
        P(x, y + 2, INK);
      }
    });
    rig(X(58), Y(-20), X(58), Y(-12.5));
    rig(X(58), Y(-12.5), X(46.5), Y(-8), true);
    rig(X(58), Y(-12.5), X(74), Y(-25.5), true);
    // The hawse, where the chain leaves the bow.
    hawseX = Math.round(X(44.5));
    hawseY = Math.round(Y(-6.5));
    P(hawseX, hawseY, PAP);
  }

  /* ----- seabed, rock, anchor ----- */
  const bedY = (x: number) =>
    H - (compact ? 9 : 11) - Math.round(2.4 * Math.sin(x * 0.047 + 1.3) + 2.2 * valueNoise(x * 0.09, 3.3) + (compact ? 0 : 3.5 * smoothstep(W * 0.55, W * 0.95, x)));

  function drawBed(): void {
    for (let x = 0; x < W; x++) {
      const y0 = bedY(x);
      const lit = smoothstep(calmX - 30, calmX + 20, x);
      for (let y = y0; y < H; y++) {
        const d = y - y0;
        let v: number;
        if (d === 0) v = hash(x, 3, 1) < 0.55 + 0.35 * lit ? PAP : T50;
        else if (d < 2) v = lit > 0.5 ? T50 : T25;
        else if (d < 4) v = T25;
        else if (d < 8) v = hash(x, y, 2) < 0.5 ? T25 : T12;
        else v = hash(x, y, 5) < 0.3 ? T12 : INK;
        if (lit < 0.5 && d > 1) v = d < 3 ? T12 : INK;
        P(x, y, v);
      }
    }
    for (const rock of layout.rocks) {
      const [cx, hw, hh] = rock;
      const by = bedY(cx) + 2;
      for (let i = -hw; i <= hw; i++) {
        const top = Math.round(hh * Math.pow(Math.max(0, 1 - (i * i) / (hw * hw)), 0.62));
        for (let j = 0; j <= top; j++) {
          let v = INK;
          if (j === top && i < hw * 0.55) v = PAP;
          else if (i < -hw * 0.25 && j > top * 0.45) v = T50;
          else if (j >= top - 2 && i < hw * 0.75) v = T25;
          else if (i > hw * 0.3 && ((i + j) & 3) === 0) v = T12;
          P(cx + i, by - j, v);
        }
        P(cx + i, by - top - 1, INK);
      }
    }
  }

  function blob(x: number, y: number, r: number, v: number): void {
    x = Math.round(x);
    y = Math.round(y);
    if (r <= 1) {
      P(x, y, v);
      return;
    }
    if (r === 2) {
      P(x, y, v);
      P(x + 1, y, v);
      P(x, y + 1, v);
      P(x + 1, y + 1, v);
      return;
    }
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) P(x + i, y + j, v);
  }
  function stroke(points: readonly (readonly [number, number])[], r: number, v: number): void {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1] as readonly [number, number];
      const b = points[i] as readonly [number, number];
      line(a[0], a[1], b[0], b[1], (x, y) => {
        if (y < bedY(x)) blob(x, y, r, v);
      });
    }
  }

  let ringX = 0;
  let ringY = 0;
  function drawAnchor(): void {
    // An admiralty anchor leaning on its crown: ring up toward the chain, one fluke in the ground.
    const m = layout.anchor.mirrored ? -1 : 1;
    const len = layout.anchor.length;
    const ax = layout.anchor.x;
    const ay = bedY(ax + m * Math.round(len * 0.45)) - Math.round(len * 0.883) - 1;
    const lean = (50 * Math.PI) / 180;
    const sx = Math.cos(lean);
    const sy = Math.sin(lean);
    const px = -sy;
    const py = sx;
    const ar = len * 0.5;
    const pt = (u: number, v: number): [number, number] => [ax + m * (u * sx + v * px), ay + (u * sy + v * py)];
    const arc: [number, number][] = [];
    for (let a = -72; a <= 72; a += 4) {
      const r = (a * Math.PI) / 180;
      arc.push(pt(len - ar + ar * Math.cos(r), ar * Math.sin(r)));
    }
    const shank = [pt(3, 0), pt(len, 0)];
    const stock = [pt(7, -len * 0.3), pt(7, len * 0.3)];
    const all = (r: number, v: number, dx: number, dy: number) => {
      const shift = (p: readonly [number, number]): [number, number] => [p[0] + dx, p[1] + dy];
      stroke(arc.map(shift), r, v);
      stroke(shank.map(shift), r, v);
      stroke(stock.map(shift), r, v);
    };
    all(3, INK, 0, 0);
    all(3, INK, 1, 0);
    all(3, INK, 0, 1);
    all(3, INK, 1, 1);
    stroke(arc, 2, PAP);
    stroke(shank, 2, PAP);
    stroke(stock, 2, PAP);
    for (const end of stock) blob(end[0], end[1], 3, PAP);
    // Palms: a flat triangular blade inside each arm tip.
    for (const side of [0, 1]) {
      const tip = arc[side === 1 ? arc.length - 1 : 0] as [number, number];
      const back = arc[side === 1 ? arc.length - 4 : 3] as [number, number];
      let dx = back[0] - tip[0];
      let dy = back[1] - tip[1];
      const l = Math.hypot(dx, dy) || 1;
      dx /= l;
      dy /= l;
      const turn = m * (side === 1 ? -1 : 1);
      const nx = -dy * turn;
      const ny = dx * turn;
      const blade: [number, number][] = [
        [tip[0] - dx * 3 + 0.5, tip[1] - dy * 3 + 0.5],
        [tip[0] + dx * 5.5 + nx * 5 + 0.5, tip[1] + dy * 5.5 + ny * 5 + 0.5],
        [tip[0] + dx * 8 - nx * 0.5 + 0.5, tip[1] + dy * 8 - ny * 0.5 + 0.5],
      ];
      const keep = L;
      const mask = new Uint8Array(W * H);
      L = mask;
      poly(blade, 1);
      L = keep;
      const masked = (x: number, y: number) => mask[y * W + x] === 1;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (masked(x, y) && y < bedY(x)) P(x, y, PAP);
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          if (!masked(x, y) && (masked(x - 1, y) || masked(x + 1, y) || masked(x, y - 1) || masked(x, y + 1)) && levelAt(x, y) !== PAP && y < bedY(x)) P(x, y, INK);
        }
      }
    }
    // Ring.
    const ring = pt(0, 0);
    const cx = Math.round(ring[0]);
    const cy = Math.round(ring[1]);
    const outer = [[-1, -3], [0, -3], [1, -3], [-2, -2], [2, -2], [-3, -1], [3, -1], [-3, 0], [3, 0], [-3, 1], [3, 1], [-2, 2], [2, 2], [-1, 3], [0, 3], [1, 3]] as const;
    const inner = [[-1, -2], [0, -2], [1, -2], [-2, -1], [2, -1], [-2, 0], [2, 0], [-2, 1], [2, 1], [-1, 2], [0, 2], [1, 2], [-1, -1], [0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]] as const;
    for (const o of outer) P(cx + o[0], cy + o[1], PAP);
    for (const o of inner) if (levelAt(cx + o[0], cy + o[1]) !== PAP) P(cx + o[0], cy + o[1], INK);
    ringX = cx;
    ringY = cy - 3;
    // Re-lay the ground over the buried arm.
    for (let x = Math.round(ax - 30); x <= Math.round(ax + 30); x++) P(x, bedY(x), hash(x, 3, 1) < 0.9 ? PAP : T50);
  }

  /* ----- chain ----- */
  let links: Link[] = [];
  function buildChain(): void {
    const x0 = hawseX;
    const y0 = hawseY;
    const points: [number, number][] = [];
    const steps = 160;
    // Out of the hawse, down through the surface, a long catenary to the bed.
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      points.push([x0 + (ringX - x0) * Math.pow(t, layout.chainCurve), y0 + (ringY - y0) * t]);
    }
    const pitch = 6;
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1] as [number, number];
      const b = points[i] as [number, number];
      total += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    links = [];
    let done = 0;
    let next = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1] as [number, number];
      const b = points[i] as [number, number];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const segment = Math.hypot(dx, dy);
      while (done + segment >= next) {
        const u = segment === 0 ? 0 : (next - done) / segment;
        const s = total === 0 ? 0 : next / total;
        const slope = Math.atan2(Math.abs(dy), Math.abs(dx));
        links.push({
          x: a[0] + dx * u,
          y: a[1] + dy * u,
          section: s < 0.34 ? 0 : s < 0.67 ? 1 : 2,
          face: links.length % 2 === 0,
          dir: slope > 1.12 ? 'v' : slope < 0.42 ? 'h' : 'd',
          sign: dx * dy >= 0 ? 1 : -1,
        });
        next += pitch;
      }
      done += segment;
    }
  }

  function drawChain(hot: number): void {
    for (const link of links) {
      let rows: readonly string[];
      if (link.dir === 'v') rows = link.face ? FLAT_V : EDGE_V;
      else if (link.dir === 'h') rows = link.face ? FLAT_H : EDGE_H;
      else {
        rows = link.face ? FLAT_D : EDGE_D;
        if (link.sign < 0) rows = mirror(rows);
      }
      if (link.section === hot && link.face) rows = filled(rows);
      const w = (rows[0] as string).length;
      const h = rows.length;
      const left = Math.round(link.x) - (w >> 1);
      const top = Math.round(link.y) - (h >> 1);
      // A one-pixel ink keyline so the links separate from lit water.
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          if ((rows[j] as string).charAt(i) !== '#') continue;
          if (levelAt(left + i - 1, top + j) !== PAP) P(left + i - 1, top + j, INK);
          if (levelAt(left + i + 1, top + j) !== PAP) P(left + i + 1, top + j, INK);
        }
      }
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if ((rows[j] as string).charAt(i) === '#') P(left + i, top + j, PAP);
    }
  }

  /* ----- the three keys, hung on the chain with their bits toward the text ----- */
  let keys: HangingKey[] = [];
  function placeKeys(): void {
    keys = [];
    const s = layout.keyScale;
    if (s <= 0 || links.length === 0) return;
    // Three keys spaced evenly down the chain, clear of the surface and of the anchor's ring.
    const top = Math.max(WL, hawseY) + 15;
    const bottom = ringY - 7;
    const targets = [0, 1, 2].map((i) => Math.round(top + ((bottom - top) * i) / 2));
    const nearest = (y: number) => {
      let best = 0;
      for (let i = 1; i < targets.length; i++) if (Math.abs(y - (targets[i] as number)) < Math.abs(y - (targets[best] as number))) best = i;
      return best;
    };
    // Each stretch of chain belongs to the key that hangs from it.
    for (const link of links) link.section = nearest(link.y);
    const reach = Math.round(10.4 * s);
    // Where the chain crosses a row, between the two links either side of it.
    const chainAt = (y: number) => {
      for (let i = 1; i < links.length; i++) {
        const a = links[i - 1] as Link;
        const b = links[i] as Link;
        if (y >= a.y && y <= b.y && b.y > a.y) return a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y);
      }
      return (links[y < (links[0] as Link).y ? 0 : links.length - 1] as Link).x;
    };
    targets.forEach((target, section) => {
      const hookX = Math.round(chainAt(target));
      const bowX = hookX - reach - 6;
      const bowY = target;
      keys.push({
        section,
        kind: KEY_OF_SECTION[section] as KeyKind,
        bowX,
        bowY,
        hookX,
        box: { x0: Math.round(bowX - 48.5 * s), y0: Math.round(bowY - 11 * s), x1: bowX + reach, y1: Math.round(bowY + 11 * s) },
      });
    });
  }
  function drawKeys(): void {
    const s = layout.keyScale;
    for (const key of keys) {
      const distance = keyDistance(key.kind);
      const { bowX, bowY } = key;
      const sd = (x: number, y: number) => distance((bowX - x) / s, (y - bowY) / s) * s;
      // The shackle that hangs the key from its link.
      for (let x = key.box.x1 - 1; x <= key.hookX - 2; x++) {
        if (levelAt(x, bowY - 1) !== PAP) P(x, bowY - 1, INK);
        P(x, bowY, PAP);
        P(x, bowY + 1, PAP);
        if (levelAt(x, bowY + 2) !== PAP) P(x, bowY + 2, INK);
      }
      for (let y = key.box.y0 - 2; y <= key.box.y1 + 2; y++) {
        for (let x = key.box.x0 - 2; x <= key.box.x1 + 2; x++) {
          const d = sd(x + 0.5, y + 0.5);
          if (d < 0) P(x, y, PAP);
          else if (d < 1.3 && levelAt(x, y) !== PAP) P(x, y, INK);
        }
      }
    }
  }

  /* ----- weed on the bed, swaying ----- */
  function drawKelp(frame: number): void {
    layout.kelp.forEach((frond, index) => {
      const [x0, height] = frond;
      const by = bedY(x0);
      for (let j = 0; j < height; j++) {
        const sway = Math.sin(j * 0.23 + index * 1.7 + frame * 0.26) * (j / height) * 2.4 + Math.sin(j * 0.6 + index) * 0.6;
        const x = Math.round(x0 + sway);
        const y = by - j;
        P(x, y, PAP);
        if (j > 4 && j % 5 === index % 5) {
          const side = j % 10 < 5 ? 1 : -1;
          P(x + side, y - 1, PAP);
          P(x + 2 * side, y - 2, PAP);
          P(x + 3 * side, y - 3, PAP);
        }
      }
      // The holdfast: a small dense clump gripping the stone.
      P(x0 - 1, by, PAP);
      P(x0 + 1, by, PAP);
      P(x0 - 2, by + 1, T75);
      P(x0 + 2, by + 1, T75);
      P(x0, by + 1, PAP);
    });
  }

  /* ----- one frame ----- */
  function render(frame: number, hot: number): Uint8Array {
    const f = frame;
    L = frameLevels;
    frameLevels.set(still);
    drawKelp(f);
    drawChain(hot);
    drawKeys();
    if (ship && WL >= 0 && WL < H) {
      // The moon's path on the surface line.
      const { x: mx, r: mr } = layout.moon;
      for (let x = 0; x < W; x++) {
        if (frameLevels[WL * W + x] !== 0) continue;
        const glow = Math.exp(-Math.pow((x - mx) / (mr * 1.5), 2));
        const r1 = hash(x, f >> 1, 11);
        const r2 = hash(x >> 1, f >> 2, 12);
        frameLevels[WL * W + x] = glow > 0.25 ? (r1 < 0.82 ? PAP : T50) : r2 < 0.3 + glow ? T75 : r2 < 0.62 ? T50 : T25;
      }
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const level = frameLevels[i] as number;
        let t: number;
        if (level !== 0) t = LEVEL[level] as number;
        else {
          t = tone[i] as number;
          const open = (calm[i] as number) > 0.98;
          if (y > WL) {
            // Slow drift of the light shafts, and a breathing jitter at every band edge.
            if (t > 0.03) t += (hash(x, y, (f >> 1) + 20) - 0.5) * 0.11;
            const dp = y - WL;
            if (ship && dp < 4) t += 0.16 * Math.sin(x * 0.5 + f * 0.8 + dp) * (calm[i] as number);
          } else if (t > 0.06 && t < 1) t += (hash(x, y, (f >> 2) + 40) - 0.5) * 0.1;
          else if (t <= 0.06 && y < WL - 3 && open) {
            // Stars.
            if (hash(x, y, 99) < 0.0032 && hash(x, y, f >> 3) > 0.12) t = 1;
          }
          // Motes drifting in the dark water.
          if (y > WL + 12 && t < 0.06 && x > calmX && open && hash(x, y + (f >> 3), 77) < 0.0016) t = 1;
          t = quantise(t);
        }
        out[i] = ditherOn(t, x, y) ? 1 : 0;
      }
    }
    return out;
  }

  buildCalm();
  buildTone();
  L = still;
  drawBed();
  if (ship) drawShip();
  else {
    hawseX = layout.chainFrom?.x ?? 0;
    hawseY = layout.chainFrom?.y ?? 0;
  }
  drawAnchor();
  if (!ship && layout.chainFrom === undefined) {
    hawseX = compact ? ringX + 1 : ringX - 38;
    hawseY = -8;
  }
  buildChain();
  placeKeys();

  return {
    layout,
    get links() {
      return links;
    },
    get keys() {
      return keys;
    },
    render,
  };
}

/** The column of the bow's hawse and the tip of the jib-boom, for a ship of scale `k` centred on `ox`. */
export function shipExtent(ox: number, k: number): { stern: number; hawse: number; tip: number; mastTop: number } {
  return { stern: ox - 53 * k, hawse: ox + 44.5 * k, tip: ox + 75 * k, mastTop: 74 * k };
}
