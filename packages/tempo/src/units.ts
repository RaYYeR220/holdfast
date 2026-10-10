import { TOKEN_DECIMALS } from './networks';

const UNIT = 10n ** BigInt(TOKEN_DECIMALS);
const AMOUNT = new RegExp(`^(\\d+)(?:\\.(\\d{1,${TOKEN_DECIMALS}}))?$`);

/** Parse a plain decimal amount such as `12.34` into token base units. */
export function toBaseUnits(text: string): bigint {
  const match = AMOUNT.exec(text);
  if (!match) throw new RangeError(`"${text}" is not a decimal amount with at most ${TOKEN_DECIMALS} decimals`);
  const fraction = (match[2] ?? '').padEnd(TOKEN_DECIMALS, '0');
  return BigInt(match[1] ?? '0') * UNIT + BigInt(fraction);
}

/** Format base units as a decimal amount with at least two decimals: `12.34`, `10.00`, `0.000001`. */
export function formatBaseUnits(units: bigint): string {
  const sign = units < 0n ? '-' : '';
  const abs = units < 0n ? -units : units;
  const fraction = (abs % UNIT).toString().padStart(TOKEN_DECIMALS, '0').replace(/0{1,4}$/, '');
  return `${sign}${abs / UNIT}.${fraction}`;
}
