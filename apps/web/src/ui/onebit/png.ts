import { crc32, deflateSync } from 'node:zlib';
import { INK, PAPER } from './raster';

/**
 * A one-bit picture as a PNG file: one bit a pixel and a palette of the two
 * inks. Server only; the browser paints the same bits on a canvas.
 */

function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, tail]);
}

/**
 * Encode `bits` (1 for paper, 0 for ink, `w` by `h`) with every design pixel
 * enlarged to `scale` by `scale` image pixels.
 */
export function encodePng(bits: Uint8Array, w: number, h: number, scale = 1): Buffer {
  const width = w * scale;
  const height = h * scale;
  const stride = 1 + Math.ceil(width / 8);
  const raw = Buffer.alloc(stride * height);
  const row = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    row.fill(0);
    for (let x = 0; x < w; x++) {
      if (bits[y * w + x] !== 1) continue;
      for (let s = 0; s < scale; s++) {
        const px = x * scale + s;
        const at = 1 + (px >> 3);
        row[at] = (row[at] as number) | (0x80 >> (px & 7));
      }
    }
    for (let s = 0; s < scale; s++) row.copy(raw, (y * scale + s) * stride);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 1; // bit depth
  header[9] = 3; // palette
  const palette = Buffer.from([...INK, ...PAPER]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('PLTE', palette),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
