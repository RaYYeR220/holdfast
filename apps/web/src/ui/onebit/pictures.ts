import { ANCHOR_16, anchorDistance, drawLettering } from './lettering';
import { ditherOn } from './raster';
import { buildScene } from './scene';

/**
 * The pictures Holdfast shows outside its own pages, as bits: the icon, the
 * logo and the card that social sites show for a link. They are drawn with
 * the same routines as the pages and encoded by `png.ts`.
 */

export interface Picture {
  bits: Uint8Array;
  w: number;
  h: number;
}

/** The anchor on a square of ink, `margin` design pixels clear of the edge. Sixteen pixels of anchor. */
export function iconPicture(margin = 0): Picture {
  const size = 16 + margin * 2;
  const bits = new Uint8Array(size * size);
  ANCHOR_16.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row.charAt(x) === '#') bits[(y + margin) * size + x + margin] = 1;
  });
  return { bits, w: size, h: size };
}

/**
 * The logo: the anchor in ink against the moon, whose halo is the four
 * dither densities in rings. `size` is the edge of the square in design
 * pixels; 128 at eight image pixels each gives 1024.
 */
export function logoPicture(size = 128): Picture {
  const bits = new Uint8Array(size * size);
  const cx = size / 2;
  const cy = size / 2;
  const moon = size * 0.36;
  const anchor = anchorDistance(size * 0.58);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const tone = d < moon ? 1 : d < moon * 1.14 ? 0.75 : d < moon * 1.32 ? 0.5 : d < moon * 1.58 ? 0.25 : d < moon * 1.95 ? 0.125 : 0;
      let on = ditherOn(tone, x, y);
      const mark = anchor(x + 0.5 - cx, y + 0.5 - cy - size * 0.015);
      if (mark < 0) on = false;
      // A paper keyline where the anchor leaves the moon, so its arms read against the halo.
      else if (mark < 1.6 && d >= moon) on = true;
      bits[y * size + x] = on ? 1 : 0;
    }
  }
  return { bits, w: size, h: size };
}

/**
 * The card for a shared link, 240 by 126 design pixels: the ship at anchor
 * with the claim set across the waterline, as on the first screen of the site.
 */
export function socialCardPicture(): Picture {
  const w = 240;
  const h = 126;
  const waterline = 62;
  const k = 0.72;
  const ox = 172;
  const moon = { x: ox - 2, y: waterline - 30, r: 26 };
  const scene = buildScene({
    kind: 'ship',
    w,
    h,
    waterline,
    compact: false,
    k,
    ox,
    moon,
    clouds: [
      [moon.x - 60, waterline - 10, 40, 1.6, 0.5],
      [moon.x + 44, waterline - 14, 22, 1.4, 0.5],
      [moon.x - 84, waterline - 34, 30, 1.2, 0.25],
      [moon.x + 50, waterline - 40, 16, 1.2, 0.25],
    ],
    rocks: [[232, 6, 5]],
    kelp: [
      [229, 22],
      [235, 13],
    ],
    anchor: { x: 204, length: 22, mirrored: false },
    chainCurve: 1.6,
    calmX: 124,
    quiet: [
      { x0: 6, y0: 4, x1: 116, y1: waterline - 2 },
      { x0: 6, y0: waterline + 5, x1: 116, y1: 110 },
    ],
    keyScale: 0,
  });
  const bits = Uint8Array.from(scene.render(0, -1));
  const put = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < w && y < h) bits[y * w + x] = 1;
  };
  drawLettering(put, 'Holdfast', 12, 5, 1);
  drawLettering(put, 'Lock your', 12, 18, 2);
  drawLettering(put, 'runway.', 12, 39, 2);
  drawLettering(put, 'Keep your', 12, 68, 2);
  drawLettering(put, 'keys.', 12, 89, 2);
  return { bits, w, h };
}
