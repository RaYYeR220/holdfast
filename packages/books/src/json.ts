/**
 * JSON that gives back the amounts it was given. A bigint is written as
 * `{ "$bigint": "<decimal>" }`, the same tag the database layer uses, and
 * read back as a bigint; everything else is plain JSON.
 */
const BIGINT = '$bigint';
/** No amount on any chain is longer than a 256-bit integer; a longer run of digits is not an amount. */
const DECIMAL = /^-?\d{1,78}$/;

export function stringifyExact(value: unknown, space?: number): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? { [BIGINT]: v.toString() } : v), space);
}

function isBigintTag(value: unknown): value is { [BIGINT]: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === BIGINT;
}

export function parseExact(text: string): unknown {
  return JSON.parse(text, (_key, v: unknown) => {
    if (!isBigintTag(v)) return v;
    const digits = v[BIGINT];
    if (typeof digits !== 'string' || !DECIMAL.test(digits)) throw new SyntaxError(`malformed amount ${String(digits).slice(0, 40)}`);
    return BigInt(digits);
  });
}
