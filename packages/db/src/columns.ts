import { bigint, customType, numeric } from 'drizzle-orm/pg-core';
import { decodeJson, stringifyJson } from './json';
import { toStorableText } from './text';

/**
 * A jsonb column that gives back exactly what it was given, bigints
 * included. Both drivers hand jsonb over already parsed, so reading only has
 * to undo the tags.
 */
export const json = customType<{ data: unknown; driverData: unknown }>({
  dataType: () => 'jsonb',
  toDriver: (value) => stringifyJson(value),
  fromDriver: (value) => decodeJson(value),
});

/**
 * Text written by someone else: the memo anyone can attach to a payment, the
 * error a venue answers with. Whatever Postgres cannot store in it is replaced
 * by U+FFFD, so that nobody can send the treasury a row it is unable to write.
 * Identifiers do not use this; a malformed one should fail, not be altered.
 */
export const freeText = customType<{ data: string; driverData: string }>({
  dataType: () => 'text',
  toDriver: (value) => toStorableText(value),
});

/**
 * The engine keeps time as epoch milliseconds; the database keeps it as
 * timestamptz. Both drivers return the column as text.
 */
export const epochMs = customType<{ data: number; driverData: string }>({
  dataType: () => 'timestamp with time zone',
  toDriver: (ms) => {
    if (!Number.isInteger(ms)) throw new RangeError(`not a whole number of milliseconds: ${ms}`);
    return new Date(ms).toISOString();
  },
  fromDriver: (text) => {
    const ms = new Date(text).getTime();
    if (Number.isNaN(ms)) throw new RangeError(`unreadable timestamp ${text}`);
    return ms;
  },
});

/** Zatoshi. The whole ZEC supply fits a signed 64-bit integer many times over. */
export const zat = (name: string) => bigint(name, { mode: 'bigint' });

/** Token base units on any chain; wide enough for a uint256. */
export const baseUnits = (name: string) => numeric(name, { precision: 78, scale: 0, mode: 'bigint' });
