/** SPL token amounts are unsigned 64-bit integers. */
export const MAX_TOKEN_AMOUNT = 2n ** 64n - 1n;

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new RangeError(`invalid token decimals ${decimals}`);
  }
}

/**
 * Parse a plain decimal string into token base units:
 * `toBaseUnits('12.34', 6) === 12_340_000n`. Digits the token cannot
 * represent are an error, never rounded away.
 */
export function toBaseUnits(amount: string, decimals: number): bigint {
  assertDecimals(decimals);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount);
  if (!match) throw new RangeError(`invalid amount "${amount}"`);
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) {
    throw new RangeError(`amount "${amount}" has more than ${decimals} decimal places`);
  }
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (units > MAX_TOKEN_AMOUNT) throw new RangeError(`amount "${amount}" does not fit in a token amount`);
  return units;
}

/** The inverse of {@link toBaseUnits}, without trailing zeros: `formatBaseUnits(5_750_000n, 6) === '5.75'`. */
export function formatBaseUnits(units: bigint, decimals: number): string {
  assertDecimals(decimals);
  if (units < 0n) throw new RangeError(`negative token amount ${units}`);
  const scale = 10n ** BigInt(decimals);
  const whole = units / scale;
  const fraction = units % scale;
  if (fraction === 0n) return whole.toString();
  return `${whole}.${fraction.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
}
