/**
 * A QR code encoder for payment requests: byte mode, error correction level
 * M, the smallest version (1 to 40) the text fits. It follows ISO/IEC 18004
 * and returns the symbol as a matrix for the page to draw; it draws nothing
 * itself and depends on nothing.
 */

export interface QrCode {
  /** 1 to 40. */
  version: number;
  /** Modules per side: 17 + 4 × version. */
  size: number;
  /** The mask pattern in use, 0 to 7. */
  mask: number;
  /**
   * `modules[row][column]`, true for a dark module. The quiet zone is not
   * part of it: whoever draws the symbol leaves four light modules around it.
   */
  modules: boolean[][];
}

export interface QrOptions {
  /** Use this mask pattern (0 to 7). Left out, the one with the lowest penalty is chosen, as the standard has it. */
  mask?: number;
}

const MIN_VERSION = 1;
const MAX_VERSION = 40;

/** Error correction codewords in each block at level M, by version. */
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
/** Error correction blocks at level M, by version. */
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
/** The two bits that name level M in the format information. */
const FORMAT_LEVEL_M = 0;
const MODE_BYTE = 0b0100;

const PENALTY_RUN = 3;
const PENALTY_BLOCK = 3;
const PENALTY_FINDER = 40;
const PENALTY_BALANCE = 10;

function table(values: readonly number[], version: number): number {
  const value = values[version];
  if (value === undefined) throw new RangeError(`there is no QR version ${version}`);
  return value;
}

/** Modules of a version that carry data or error correction: everything but the function patterns. */
function rawDataModules(version: number): number {
  let count = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignments = Math.floor(version / 7) + 2;
    count -= (25 * alignments - 10) * alignments - 55;
    if (version >= 7) count -= 36;
  }
  return count;
}

function dataCodewords(version: number): number {
  return Math.floor(rawDataModules(version) / 8) - table(ECC_PER_BLOCK, version) * table(BLOCKS, version);
}

/** Bits of the character count that follows the mode indicator in byte mode. */
const countBits = (version: number): number => (version <= 9 ? 8 : 16);

/** How many bytes a symbol of a version holds in byte mode at level M. */
export function qrByteCapacity(version: number): number {
  return Math.floor((dataCodewords(version) * 8 - 4 - countBits(version)) / 8);
}

/** Multiplication in GF(2^8) modulo x^8 + x^4 + x^3 + x^2 + 1. */
function multiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** The Reed-Solomon generator polynomial of a degree, highest power first, without its leading 1. */
function generator(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = multiply(result[j] ?? 0, root) ^ (result[j + 1] ?? 0);
    }
    root = multiply(root, 0x02);
  }
  return result;
}

/** The error correction codewords of one block. */
export function reedSolomon(data: readonly number[], degree: number): number[] {
  const divisor = generator(degree);
  const remainder = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ (remainder.shift() ?? 0);
    remainder.push(0);
    divisor.forEach((coefficient, i) => {
      remainder[i] = (remainder[i] ?? 0) ^ multiply(coefficient, factor);
    });
  }
  return remainder;
}

/** The data codewords of a symbol: mode, length, the bytes, the terminator and the padding. */
function dataStream(bytes: Uint8Array, version: number): number[] {
  const capacity = dataCodewords(version) * 8;
  const bits: number[] = [];
  const append = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  append(MODE_BYTE, 4);
  append(bytes.length, countBits(version));
  for (const byte of bytes) append(byte, 8);
  append(0, Math.min(4, capacity - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) append(pad, 8);

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let codeword = 0;
    for (let j = 0; j < 8; j += 1) codeword = (codeword << 1) | (bits[i + j] ?? 0);
    codewords.push(codeword);
  }
  return codewords;
}

/** Split the data into blocks, give each its error correction, and interleave them as they are laid out. */
function interleave(data: readonly number[], version: number): number[] {
  const blockCount = table(BLOCKS, version);
  const eccLength = table(ECC_PER_BLOCK, version);
  const total = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blockCount - (total % blockCount);
  const shortLength = Math.floor(total / blockCount) - eccLength;

  const blocks: { data: number[]; ecc: number[] }[] = [];
  for (let i = 0, at = 0; i < blockCount; i += 1) {
    const length = shortLength + (i < shortBlocks ? 0 : 1);
    const block = data.slice(at, at + length);
    at += length;
    blocks.push({ data: block, ecc: reedSolomon(block, eccLength) });
  }

  const result: number[] = [];
  for (let i = 0; i <= shortLength; i += 1) {
    for (const block of blocks) {
      const codeword = block.data[i];
      if (codeword !== undefined) result.push(codeword);
    }
  }
  for (let i = 0; i < eccLength; i += 1) {
    for (const block of blocks) result.push(block.ecc[i] ?? 0);
  }
  return result;
}

/** Centres of the alignment patterns along one axis. */
function alignmentPositions(version: number, size: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const positions = [6];
  for (let position = size - 7; positions.length < count; position -= step) positions.splice(1, 0, position);
  return positions;
}

const bit = (value: number, index: number): boolean => ((value >>> index) & 1) !== 0;

/** A symbol being built: the modules, and which of them belong to function patterns and are never masked. */
class Matrix {
  readonly size: number;
  readonly modules: boolean[][];
  private readonly fixed: boolean[][];

  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.fixed = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  private at(x: number, y: number): boolean {
    return this.modules[y]?.[x] === true;
  }

  private isFixed(x: number, y: number): boolean {
    return this.fixed[y]?.[x] === true;
  }

  private put(x: number, y: number, dark: boolean): void {
    const row = this.modules[y];
    if (row !== undefined && x >= 0 && x < this.size) row[x] = dark;
  }

  private fix(x: number, y: number, dark: boolean): void {
    const row = this.fixed[y];
    if (row === undefined || x < 0 || x >= this.size) return;
    row[x] = true;
    this.put(x, y, dark);
  }

  drawFunctionPatterns(): void {
    for (let i = 0; i < this.size; i += 1) {
      this.fix(6, i, i % 2 === 0);
      this.fix(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [[3, 3], [this.size - 4, 3], [3, this.size - 4]] as const) {
      for (let dy = -4; dy <= 4; dy += 1) {
        for (let dx = -4; dx <= 4; dx += 1) {
          const distance = Math.max(Math.abs(dx), Math.abs(dy));
          this.fix(cx + dx, cy + dy, distance !== 2 && distance !== 4);
        }
      }
    }
    const positions = alignmentPositions(this.version, this.size);
    const last = positions.length - 1;
    positions.forEach((cx, i) => {
      positions.forEach((cy, j) => {
        // The three corners that hold finder patterns have no alignment pattern.
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) this.fix(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      });
    });
    this.drawFormat(0);
    this.drawVersion();
  }

  /** The level and the mask, with their BCH code, in both places the standard puts them. */
  drawFormat(mask: number): void {
    const data = (FORMAT_LEVEL_M << 3) | mask;
    let remainder = data;
    for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    const bits = ((data << 10) | remainder) ^ 0x5412;

    for (let i = 0; i <= 5; i += 1) this.fix(8, i, bit(bits, i));
    this.fix(8, 7, bit(bits, 6));
    this.fix(8, 8, bit(bits, 7));
    this.fix(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i += 1) this.fix(14 - i, 8, bit(bits, i));

    for (let i = 0; i < 8; i += 1) this.fix(this.size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i += 1) this.fix(8, this.size - 15 + i, bit(bits, i));
    this.fix(8, this.size - 8, true);
  }

  /** The version with its BCH code, twice, from version 7 up. */
  private drawVersion(): void {
    if (this.version < 7) return;
    let remainder = this.version;
    for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const bits = (this.version << 12) | remainder;
    for (let i = 0; i < 18; i += 1) {
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.fix(a, b, bit(bits, i));
      this.fix(b, a, bit(bits, i));
    }
  }

  /** Lay the codewords out in the zigzag of two-module columns, from the bottom right. */
  drawCodewords(codewords: readonly number[]): void {
    let index = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let step = 0; step < this.size; step += 1) {
        for (let j = 0; j < 2; j += 1) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - step : step;
          if (this.isFixed(x, y) || index >= codewords.length * 8) continue;
          this.put(x, y, bit(codewords[index >>> 3] ?? 0, 7 - (index & 7)));
          index += 1;
        }
      }
    }
  }

  /** Flip the data modules a mask pattern selects. Applying the same mask again undoes it. */
  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        if (!this.isFixed(x, y) && masked(mask, x, y)) this.put(x, y, !this.at(x, y));
      }
    }
  }

  /** The penalty the standard gives a masked symbol; the mask with the lowest is the one to use. */
  penalty(): number {
    let result = 0;
    for (const horizontal of [true, false]) {
      for (let line = 0; line < this.size; line += 1) {
        let colour = false;
        let run = 0;
        const history = [0, 0, 0, 0, 0, 0, 0];
        for (let i = 0; i < this.size; i += 1) {
          const dark = horizontal ? this.at(i, line) : this.at(line, i);
          if (dark === colour) {
            run += 1;
            if (run === 5) result += PENALTY_RUN;
            else if (run > 5) result += 1;
          } else {
            this.remember(run, history);
            if (!colour) result += this.finderLike(history) * PENALTY_FINDER;
            colour = dark;
            run = 1;
          }
        }
        // A dark run ends at the edge; the quiet zone beyond it counts as a light one.
        if (colour) {
          this.remember(run, history);
          run = 0;
        }
        this.remember(run + this.size, history);
        result += this.finderLike(history) * PENALTY_FINDER;
      }
    }

    let dark = 0;
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        const colour = this.at(x, y);
        if (colour) dark += 1;
        if (x + 1 < this.size && y + 1 < this.size && colour === this.at(x + 1, y) && colour === this.at(x, y + 1) && colour === this.at(x + 1, y + 1)) result += PENALTY_BLOCK;
      }
    }
    const total = this.size * this.size;
    result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * PENALTY_BALANCE;
    return result;
  }

  private remember(run: number, history: number[]): void {
    // The first run of a line is light and continues into the quiet zone before it.
    const length = history[0] === 0 ? run + this.size : run;
    history.pop();
    history.unshift(length);
  }

  /** How many times the latest runs form the 1:1:3:1:1 of a finder pattern with light on a side. */
  private finderLike(history: readonly number[]): number {
    const [h0 = 0, n = 0, h2 = 0, h3 = 0, h4 = 0, h5 = 0, h6 = 0] = history;
    const core = n > 0 && h2 === n && h3 === n * 3 && h4 === n && h5 === n;
    return (core && h0 >= n * 4 && h6 >= n ? 1 : 0) + (core && h6 >= n * 4 && h0 >= n ? 1 : 0);
  }
}

function masked(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      throw new RangeError(`there is no mask pattern ${mask}`);
  }
}

/**
 * Encode a text as a QR code. The text goes in as its UTF-8 bytes, so a URI
 * is carried exactly as written. Throws a RangeError for a text longer than
 * the 2331 bytes the largest symbol holds at this level.
 */
export function encodeQr(text: string, options: QrOptions = {}): QrCode {
  const bytes = new TextEncoder().encode(text);
  let version = MIN_VERSION;
  while (version <= MAX_VERSION && qrByteCapacity(version) < bytes.length) version += 1;
  if (version > MAX_VERSION) throw new RangeError(`${bytes.length} bytes do not fit a QR code; the limit is ${qrByteCapacity(MAX_VERSION)}`);
  if (options.mask !== undefined && (!Number.isInteger(options.mask) || options.mask < 0 || options.mask > 7)) throw new RangeError(`there is no mask pattern ${options.mask}`);

  const symbol = new Matrix(version);
  symbol.drawFunctionPatterns();
  symbol.drawCodewords(interleave(dataStream(bytes, version), version));

  let mask = options.mask;
  if (mask === undefined) {
    let lowest = Number.POSITIVE_INFINITY;
    for (let candidate = 0; candidate < 8; candidate += 1) {
      symbol.applyMask(candidate);
      symbol.drawFormat(candidate);
      const penalty = symbol.penalty();
      if (penalty < lowest) {
        lowest = penalty;
        mask = candidate;
      }
      symbol.applyMask(candidate);
    }
  }
  const chosen = mask ?? 0;
  symbol.applyMask(chosen);
  symbol.drawFormat(chosen);
  return { version, size: symbol.size, mask: chosen, modules: symbol.modules };
}
