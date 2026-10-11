/**
 * JSON as the API sends it. Amounts are bigint in the code and decimal
 * strings on the wire: a JSON number cannot carry base units exactly.
 */
export function toWire(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

/** Plain data with every bigint written as a decimal string: what a client gets after parsing `toWire`. */
export function wireShape(value: unknown): unknown {
  return JSON.parse(toWire(value)) as unknown;
}
