import { isStorableText } from './text';

/**
 * JSON as the database keeps it, with nothing lost on the way.
 *
 * JSON has no integer wider than a double, and the journal carries zatoshi
 * amounts as bigint: a bigint is written as `{ "$bigint": "<decimal>" }` and
 * read back as a bigint. Postgres also refuses a few strings JSON allows (a
 * NUL, half a surrogate pair); such a string is written as
 * `{ "$string": "<its JSON escapes>" }`. Everything else is plain JSON, so a
 * value comes out of the database with the types and content it went in with.
 *
 * Two things JSON itself cannot tell apart are folded together: a property
 * set to undefined is dropped, and negative zero is read back as zero. The
 * journal digest treats both pairs as equal too.
 */
const BIGINT = '$bigint';
const STRING = '$string';
const DECIMAL = /^-?\d+$/;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function isPlainObject(v: object): v is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function encodeKey(key: string): string {
  if (key === BIGINT || key === STRING) throw new TypeError(`the key ${key} is reserved`);
  if (!isStorableText(key)) throw new TypeError(`cannot store the key ${JSON.stringify(key)}`);
  return key;
}

/**
 * Turn a value into something `JSON.stringify` and Postgres keep intact. It
 * refuses what could not be read back unchanged rather than storing an
 * approximation.
 */
export function encodeJson(v: unknown): JsonValue {
  if (v === null) return null;
  switch (typeof v) {
    case 'boolean':
      return v;
    case 'string':
      return isStorableText(v) ? v : { [STRING]: JSON.stringify(v).slice(1, -1) };
    case 'number':
      if (!Number.isFinite(v)) throw new TypeError('cannot store a non-finite number');
      return v;
    case 'bigint':
      return { [BIGINT]: v.toString() };
    case 'object': {
      if (Array.isArray(v)) return v.map((x) => encodeJson(x === undefined ? null : x));
      if (!isPlainObject(v)) throw new TypeError('cannot store an object that is not a plain record');
      // fromEntries defines own properties, so a key named __proto__ stays data.
      return Object.fromEntries(
        Object.entries(v)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [encodeKey(key), encodeJson(value)]),
      );
    }
    default:
      throw new TypeError(`cannot store a value of type ${typeof v}`);
  }
}

/** The value a tagged object stands for, or undefined when the object is an ordinary one. */
function untag(record: Record<string, unknown>): bigint | string | undefined {
  if (Object.keys(record).length !== 1) return undefined;
  if (Object.hasOwn(record, BIGINT)) {
    const digits = record[BIGINT];
    if (typeof digits !== 'string' || !DECIMAL.test(digits)) throw new TypeError(`malformed bigint ${JSON.stringify(digits)}`);
    return BigInt(digits);
  }
  if (Object.hasOwn(record, STRING)) {
    const escaped = record[STRING];
    const text = typeof escaped === 'string' ? unescape(escaped) : undefined;
    if (text === undefined) throw new TypeError(`malformed string ${JSON.stringify(escaped)}`);
    return text;
  }
  return undefined;
}

function unescape(escaped: string): string | undefined {
  try {
    return JSON.parse(`"${escaped}"`) as string;
  } catch {
    return undefined;
  }
}

/** The inverse of `encodeJson`, applied to JSON that has already been parsed. */
export function decodeJson(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(decodeJson);
  const record = v as Record<string, unknown>;
  const plain = untag(record);
  if (plain !== undefined) return plain;
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, decodeJson(value)]));
}

export function stringifyJson(v: unknown): string {
  return JSON.stringify(encodeJson(v));
}

export function parseJson(text: string): unknown {
  return decodeJson(JSON.parse(text));
}
