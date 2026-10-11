import { messageOf, type Redactor } from './redact';

/**
 * One value read from a chain, a venue or the journal, with where it came
 * from and when it was read. A read that failed, or whose answer is too old,
 * is `unavailable` and says why; it is never an older or a default value.
 */
export type Reading<T> =
  | { status: 'ok'; source: string; readAt: number; value: T }
  | { status: 'unavailable'; source: string; readAt: number; reason: string };

export type Available<T> = Extract<Reading<T>, { status: 'ok' }>;

export const available = <T>(source: string, readAt: number, value: T): Reading<T> => ({ status: 'ok', source, readAt, value });

export const missing = <T>(source: string, readAt: number, reason: string): Reading<T> => ({ status: 'unavailable', source, readAt, reason });

/** Run a read against a live source. Whatever it throws becomes the reason the value is unavailable. */
export async function reading<T>(source: string, clock: { now: () => number; redact: Redactor }, read: () => Promise<T>): Promise<Reading<T>> {
  try {
    const value = await read();
    return available(source, clock.now(), value);
  } catch (error) {
    return missing(source, clock.now(), clock.redact(messageOf(error)));
  }
}

/** The same reading with its value put through `change`; an unavailable one stays as it is. */
export function mapReading<T, U>(read: Reading<T>, change: (value: T) => U): Reading<U> {
  return read.status === 'ok' ? { ...read, value: change(read.value) } : read;
}
