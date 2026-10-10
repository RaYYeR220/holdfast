import { ZAT_PER_ZEC, type Zat } from '@holdfast/core';

/**
 * ZIP-321 payment requests. Holdfast never signs a Zcash transaction; every
 * movement of ZEC is handed to the treasurer's own wallet as one of these.
 */
export interface Payment {
  address: string;
  amountZat: Zat;
  /** Shielded recipients only; at most 512 bytes of UTF-8. */
  memo?: string;
  label?: string;
  message?: string;
}

export type AddressKind = 'transparent' | 'tex' | 'sapling' | 'unified';

const MAX_MEMO_BYTES = 512;
const MAX_ZAT = 21_000_000n * ZAT_PER_ZEC;

const PREFIXES: [RegExp, AddressKind][] = [
  [/^(t1|t3|tm|t2)[1-9A-HJ-NP-Za-km-z]{33}$/, 'transparent'],
  [/^tex(test)?1[02-9ac-hj-np-z]{20,}$/, 'tex'],
  [/^(zs|ztestsapling)1[02-9ac-hj-np-z]{60,}$/, 'sapling'],
  [/^u(test)?1[02-9ac-hj-np-z]{60,}$/, 'unified'],
];

/** Shape check only; the wallet that pays does the full checksum validation. */
export function addressKind(address: string): AddressKind | null {
  for (const [pattern, kind] of PREFIXES) if (pattern.test(address)) return kind;
  return null;
}

export function formatZec(zat: Zat): string {
  if (zat < 0n || zat > MAX_ZAT) throw new RangeError(`amount ${zat} zatoshi is out of range`);
  const whole = zat / ZAT_PER_ZEC;
  const fraction = (zat % ZAT_PER_ZEC).toString().padStart(8, '0').replace(/0+$/, '');
  return fraction === '' ? whole.toString() : `${whole}.${fraction}`;
}

export function parseZec(text: string): Zat {
  if (!/^\d+(\.\d{1,8})?$/.test(text)) throw new RangeError(`"${text}" is not a ZEC amount`);
  const [whole = '0', fraction = ''] = text.split('.');
  const zat = BigInt(whole) * ZAT_PER_ZEC + BigInt(fraction.padEnd(8, '0'));
  if (zat > MAX_ZAT) throw new RangeError(`amount ${text} ZEC is out of range`);
  return zat;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new RangeError('memo is not base64url');
  return new Uint8Array(Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
}

/** Percent-encode everything outside ZIP-321's unreserved query characters. */
function qchar(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function check(p: Payment, index: number): Uint8Array | null {
  const kind = addressKind(p.address);
  if (kind === null) throw new RangeError(`payment ${index}: "${p.address}" is not a Zcash address`);
  if (p.amountZat <= 0n) throw new RangeError(`payment ${index}: amount must be positive`);
  if (p.memo === undefined) return null;
  if (kind === 'transparent' || kind === 'tex') {
    throw new RangeError(`payment ${index}: a memo cannot be sent to a transparent address`);
  }
  const bytes = new TextEncoder().encode(p.memo);
  if (bytes.length > MAX_MEMO_BYTES) throw new RangeError(`payment ${index}: memo is ${bytes.length} bytes, limit ${MAX_MEMO_BYTES}`);
  return bytes;
}

/**
 * One request can carry several payments; a wallet turns it into a single
 * transaction. A lone payment uses the short `zcash:<address>?…` form.
 */
export function buildPaymentUri(payments: Payment[]): string {
  if (payments.length === 0) throw new RangeError('a payment request needs at least one payment');
  const seen = new Set<string>();
  const params: string[] = [];
  const single = payments.length === 1;

  payments.forEach((p, index) => {
    const memo = check(p, index);
    if (seen.has(p.address)) throw new RangeError(`payment ${index}: address appears twice in one request`);
    seen.add(p.address);
    const suffix = index === 0 ? '' : `.${index}`;
    if (!single) params.push(`address${suffix}=${p.address}`);
    params.push(`amount${suffix}=${formatZec(p.amountZat)}`);
    if (memo !== null) params.push(`memo${suffix}=${base64url(memo)}`);
    if (p.label !== undefined) params.push(`label${suffix}=${qchar(p.label)}`);
    if (p.message !== undefined) params.push(`message${suffix}=${qchar(p.message)}`);
  });

  return `zcash:${single ? (payments[0] as Payment).address : ''}?${params.join('&')}`;
}

export function parsePaymentUri(uri: string): Payment[] {
  if (!uri.startsWith('zcash:')) throw new RangeError('not a zcash: URI');
  const rest = uri.slice('zcash:'.length);
  const q = rest.indexOf('?');
  const pathAddress = q === -1 ? rest : rest.slice(0, q);
  const query = q === -1 ? '' : rest.slice(q + 1);

  const slots = new Map<number, Record<string, string>>();
  const slot = (i: number) => {
    let s = slots.get(i);
    if (s === undefined) slots.set(i, (s = {}));
    return s;
  };
  if (pathAddress !== '') slot(0).address = pathAddress;

  for (const pair of query === '' ? [] : query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new RangeError(`malformed parameter "${pair}"`);
    const m = /^([a-z]+)(?:\.([1-9]\d{0,3}))?$/.exec(pair.slice(0, eq));
    if (m === null) throw new RangeError(`malformed parameter name "${pair.slice(0, eq)}"`);
    const [, name = '', idx] = m;
    const s = slot(idx === undefined ? 0 : Number(idx));
    if (name in s) throw new RangeError(`duplicate parameter "${pair.slice(0, eq)}"`);
    s[name] = decodeURIComponent(pair.slice(eq + 1));
  }

  return [...slots.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, s]) => {
      if (s.address === undefined || s.amount === undefined) {
        throw new RangeError(`payment ${index} needs an address and an amount`);
      }
      const payment: Payment = { address: s.address, amountZat: parseZec(s.amount) };
      if (s.memo !== undefined) payment.memo = new TextDecoder('utf-8', { fatal: true }).decode(fromBase64url(s.memo));
      if (s.label !== undefined) payment.label = s.label;
      if (s.message !== undefined) payment.message = s.message;
      check(payment, index);
      return payment;
    });
}
