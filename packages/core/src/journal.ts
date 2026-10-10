import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

export type Hex = `0x${string}`;

export const ZERO_ROOT: Hex = `0x${'00'.repeat(32)}`;

/**
 * Deterministic JSON: object keys sorted, bigint written as a decimal string,
 * undefined properties dropped. Two snapshots with the same content always
 * serialise to the same bytes, whatever order they were built in.
 */
export function canonicalJson(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) throw new TypeError('cannot serialise a non-finite number');
      return JSON.stringify(v);
    case 'bigint':
      return JSON.stringify(v.toString());
    case 'string':
      return JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x === undefined ? null : x)).join(',')}]`;
      const o = v as Record<string, unknown>;
      const parts = Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`);
      return `{${parts.join(',')}}`;
    }
    default:
      throw new TypeError(`cannot serialise a ${typeof v}`);
  }
}

export function digest(v: unknown): Hex {
  return `0x${bytesToHex(keccak_256(utf8ToBytes(canonicalJson(v))))}`;
}

function compare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function hashPair(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [lo, hi] = compare(a, b) <= 0 ? [a, b] : [b, a];
  const joined = new Uint8Array(64);
  joined.set(lo, 0);
  joined.set(hi, 32);
  return keccak_256(joined);
}

/**
 * Merkle root over 32-byte leaves. Pairs are hashed in sorted order; an odd
 * node at the end of a level moves up unchanged. No leaves gives the zero root.
 */
export function merkleRoot(leaves: Hex[]): Hex {
  if (leaves.length === 0) return ZERO_ROOT;
  let level: Uint8Array[] = leaves.map((leaf) => {
    const bytes = hexToBytes(leaf.slice(2));
    if (bytes.length !== 32) throw new RangeError('merkle leaves must be 32 bytes');
    return bytes;
  });
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i] as Uint8Array;
      const right = level[i + 1];
      next.push(right === undefined ? left : hashPair(left, right));
    }
    level = next;
  }
  return `0x${bytesToHex(level[0] as Uint8Array)}`;
}
