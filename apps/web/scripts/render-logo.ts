import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { logoPicture } from '../src/ui/onebit/pictures';
import { encodePng } from '../src/ui/onebit/png';

/**
 * Writes the Holdfast logo as a square PNG: the anchor against the moon, in
 * the two inks.
 *
 *   pnpm --filter @holdfast/web exec tsx scripts/render-logo.ts <out.png> [edge]
 *
 * `edge` is the edge of the image in pixels, 1024 when omitted. It must be a
 * multiple of 128: the logo is 128 design pixels across.
 */
const [out, edgeText = '1024'] = process.argv.slice(2);
const edge = Number(edgeText);
if (out === undefined || !Number.isInteger(edge) || edge < 128 || edge % 128 !== 0) {
  console.error('usage: tsx scripts/render-logo.ts <out.png> [edge, a multiple of 128]');
  process.exit(1);
}

const { bits, w, h } = logoPicture(128);
const png = encodePng(bits, w, h, edge / 128);
const path = resolve(out);
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, png);
console.log(`${path}: ${edge} by ${edge} pixels, ${png.length} bytes`);
