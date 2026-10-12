import type { Deps } from '../deps';
import { ApiError, ConfigError } from '../errors';
import { messageOf } from '../redact';

/**
 * What the Treasury, Lock and entry pages share when they read: a read that
 * failed is a state the page shows, with the source that failed and the
 * reason, and a read the service will not make as things stand is another.
 * Nothing here lets an error reach a page as an exception.
 */

export interface Failure {
  /** Which source failed, as the service named it. */
  source: string;
  reason: string;
  /** When the read was attempted, ms. */
  at: number;
}

/** The answer of a read that may also be refused: made, refused as things stand, or not possible now. */
export type Outcome<T> = { status: 'ok'; value: T } | ({ status: 'refused' } & Pick<Failure, 'reason' | 'at'>) | ({ status: 'unavailable' } & Failure);

/** How long a page waits for one group of reads before it shows them as unavailable, ms. */
export const PAGE_PATIENCE_MS = 12_000;

class Slow extends Error {}

export function within<T>(ms: number, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Slow()), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

type FailureDeps = Pick<Deps, 'redact' | 'report'>;

/** Why a read failed, as it may be shown. An error nobody planned for is written to the log and shown without its text. */
export function failureOf(deps: FailureDeps, error: unknown, at: number, source = 'database'): Failure {
  // A missing or malformed setting names its variable and never its value.
  if (error instanceof ConfigError) return { source: error.variable === 'DATABASE_URL' ? 'database' : 'configuration', reason: error.message, at };
  if (error instanceof Slow) return { source, reason: `no answer within ${PAGE_PATIENCE_MS / 1000} s`, at };
  if (error instanceof ApiError) return { source: String(error.details.source ?? source), reason: deps.redact(error.message), at };
  deps.report(deps.redact(error instanceof Error ? (error.stack ?? error.message) : messageOf(error)));
  return { source, reason: `the ${source} could not be read`, at };
}

/**
 * Run a read of a service that answers, refuses or is unavailable. A refusal
 * (HTTP 409 and 404 from the service's own rules, 400 for input it will not
 * take) is the service working and is kept apart from a source that failed.
 */
export async function outcomeOf<T>(deps: FailureDeps & Pick<Deps, 'now'>, source: string, read: () => Promise<T>): Promise<Outcome<T>> {
  const at = deps.now();
  try {
    return { status: 'ok', value: await within(PAGE_PATIENCE_MS, read()) };
  } catch (error) {
    if (error instanceof ApiError && error.code !== 'unavailable' && error.status < 500) return { status: 'refused', reason: deps.redact(error.message), at };
    return { status: 'unavailable', ...failureOf(deps, error, at, source) };
  }
}
