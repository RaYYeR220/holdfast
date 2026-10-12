/**
 * Bitmap lettering and the anchor mark, for pictures rendered without a
 * browser: the icon, the Open Graph image and the logo. Pages set their type
 * with the real faces; this is only for pixels written by hand.
 */

/** Glyphs on a nine-row grid: rows 0 to 6 above the baseline, 7 and 8 below it. */
const GLYPHS: Record<string, readonly string[]> = {
  a: ['.....', '.....', '.###.', '....#', '.####', '#...#', '.####'],
  b: ['#....', '#....', '####.', '#...#', '#...#', '#...#', '####.'],
  c: ['.....', '.....', '.###.', '#...#', '#....', '#...#', '.###.'],
  d: ['....#', '....#', '.####', '#...#', '#...#', '#...#', '.####'],
  e: ['.....', '.....', '.###.', '#...#', '#####', '#....', '.###.'],
  f: ['..##', '.#..', '###.', '.#..', '.#..', '.#..', '.#..'],
  g: ['.....', '.....', '.####', '#...#', '#...#', '#...#', '.####', '....#', '.###.'],
  h: ['#....', '#....', '####.', '#...#', '#...#', '#...#', '#...#'],
  i: ['#', '.', '#', '#', '#', '#', '#'],
  k: ['#...', '#...', '#..#', '#.#.', '##..', '#.#.', '#..#'],
  l: ['#', '#', '#', '#', '#', '#', '#'],
  m: ['.....', '.....', '##.#.', '#.#.#', '#.#.#', '#.#.#', '#.#.#'],
  n: ['.....', '.....', '####.', '#...#', '#...#', '#...#', '#...#'],
  o: ['.....', '.....', '.###.', '#...#', '#...#', '#...#', '.###.'],
  p: ['.....', '.....', '####.', '#...#', '#...#', '#...#', '####.', '#....', '#....'],
  r: ['....', '....', '#.##', '##..', '#...', '#...', '#...'],
  s: ['.....', '.....', '.####', '#....', '.###.', '....#', '####.'],
  t: ['.#..', '.#..', '####', '.#..', '.#..', '.#..', '..##'],
  u: ['.....', '.....', '#...#', '#...#', '#...#', '#...#', '.####'],
  v: ['.....', '.....', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  w: ['.....', '.....', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
  y: ['.....', '.....', '#...#', '#...#', '#...#', '#...#', '.####', '....#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  '.': ['.', '.', '.', '.', '.', '.', '#'],
  ',': ['..', '..', '..', '..', '..', '..', '.#', '#.'],
  ' ': ['...'],
};

export const LETTER_ROWS = 9;
export const LETTER_BASELINE = 7;

/** Width of a line of lettering, in design pixels at the given scale. */
export function letteringWidth(text: string, scale = 1): number {
  let width = 0;
  for (const ch of text) {
    const glyph = GLYPHS[ch];
    if (glyph === undefined) continue;
    width += (glyph[0] as string).length + 1;
  }
  return Math.max(0, width - 1) * scale;
}

/** Write a line of lettering with its top left corner at (x, y). Characters without a glyph are skipped. */
export function drawLettering(put: (x: number, y: number) => void, text: string, x: number, y: number, scale = 1): void {
  let pen = x;
  for (const ch of text) {
    const glyph = GLYPHS[ch];
    if (glyph === undefined) continue;
    const width = (glyph[0] as string).length;
    for (let j = 0; j < glyph.length; j++) {
      const row = glyph[j] as string;
      for (let i = 0; i < width; i++) {
        if (row.charAt(i) !== '#') continue;
        for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) put(pen + i * scale + sx, y + j * scale + sy);
      }
    }
    pen += (width + 1) * scale;
  }
}

/** The anchor as a sixteen-pixel bitmap, for the smallest sizes. */
export const ANCHOR_16: readonly string[] = [
  '......####......',
  '.....#....#.....',
  '.....#....#.....',
  '......####......',
  '.......##.......',
  '...##########...',
  '.......##.......',
  '.......##.......',
  '.......##.......',
  '#......##......#',
  '##.....##.....##',
  '###....##....###',
  '.##....##....##.',
  '..##...##...##..',
  '...##########...',
  '.....######.....',
];

/**
 * Signed distance to an anchor standing upright in a box `size` tall, its
 * centre at the origin: ring, stock, shank, and two arms ending in flukes.
 */
export function anchorDistance(size: number): (x: number, y: number) => number {
  const u = size / 100;
  const weight = 4.6 * u;
  const ringY = -40 * u;
  const ringR = 9 * u;
  const stockY = -22 * u;
  const stockHalf = 26 * u;
  const crownY = 44 * u;
  const armR = 34 * u;
  const armY = crownY - armR;
  const box = (x: number, y: number, hx: number, hy: number) => {
    const dx = Math.abs(x) - hx;
    const dy = Math.abs(y) - hy;
    return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
  };
  const reach = (62 * Math.PI) / 180;
  const tipX = armR * Math.sin(reach);
  const tipY = armY + armR * Math.cos(reach);
  return (x, y) => {
    let d = Math.abs(Math.hypot(x, y - ringY) - ringR) - weight * 0.72;
    d = Math.min(d, box(x, y - (ringY + ringR + crownY) / 2, weight, (crownY - ringY - ringR) / 2));
    d = Math.min(d, box(x, y - stockY, stockHalf, weight * 0.8));
    d = Math.min(d, Math.hypot(Math.abs(x) - stockHalf, y - stockY) - weight * 1.5);
    // The arms: the lower part of a circle, as far round as the flukes.
    const angle = Math.atan2(Math.abs(x), y - armY);
    if (angle <= reach) d = Math.min(d, Math.abs(Math.hypot(x, y - armY) - armR) - weight);
    // A fluke at each tip: a blade pointing up and out.
    const fx = Math.abs(x) - tipX;
    const fy = y - tipY;
    const along = fx * 0.5 - fy * 0.866;
    const across = fx * 0.866 + fy * 0.5;
    if (along > -4 * u && along < 16 * u) d = Math.min(d, Math.abs(across) - Math.max(0, (16 * u - along) * 0.55));
    return d;
  };
}
