/**
 * How amounts in base units are written out. Plain functions over bigint, so
 * no figure passes through a floating-point number on its way to the page.
 */

function digitsOf(amount: bigint, decimals: number, minFraction: number): string {
  const magnitude = (amount < 0n ? -amount : amount).toString().padStart(decimals + 1, '0');
  const whole = magnitude.slice(0, magnitude.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = decimals === 0 ? '' : magnitude.slice(-decimals).replace(/0+$/, '').padEnd(Math.min(minFraction, decimals), '0');
  return fraction === '' ? whole : `${whole}.${fraction}`;
}

/**
 * Base units as a decimal with thousands separators: 1250000 at six decimals
 * is `1.25`. Trailing zeros are dropped down to `minFraction` decimals. A
 * negative amount takes a true minus sign.
 */
export function formatUnits(amount: bigint, decimals: number, minFraction = 0): string {
  return `${amount < 0n ? '−' : ''}${digitsOf(amount, decimals, minFraction)}`;
}

/** The same with its sign always written, for a ledger column where the direction is the point: `+0.01975`, `−0.0093`. Zero has none. */
export function formatSignedUnits(amount: bigint, decimals: number, minFraction = 0): string {
  const sign = amount < 0n ? '−' : amount > 0n ? '+' : '';
  return `${sign}${digitsOf(amount, decimals, minFraction)}`;
}

const ZEC_DECIMALS = 8;

/** Zatoshi as ZEC: 1030000 is `0.0103`. */
export function formatZat(zat: bigint): string {
  return formatUnits(zat, ZEC_DECIMALS);
}

/** Dollars with their sign always written and a true minus: `+$0.26`, `−$1.50`. Zero is `$0.00`. */
export function formatSignedUsd(value: number, digits = 2): string {
  const rounded = Math.abs(value).toFixed(digits);
  const [whole = '0', fraction] = rounded.split('.');
  const text = `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction === undefined ? '' : `.${fraction}`}`;
  if (Number(rounded) === 0) return text;
  return `${value < 0 ? '−' : '+'}${text}`;
}

/**
 * How many decimals a dollar figure needs to be read: two, or more for an
 * amount under a cent, so that a funding payment of $0.000157 is not shown
 * as nothing. Never more than six.
 */
export function usdDigits(value: number): number {
  const size = Math.abs(value);
  if (size === 0 || size >= 0.01) return 2;
  return Math.min(6, Math.max(2, 1 - Math.floor(Math.log10(size))));
}
