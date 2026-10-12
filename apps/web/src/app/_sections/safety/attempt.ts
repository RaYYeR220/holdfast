import type { Deps } from '@/server/deps';
import { ApiError, ConfigError } from '@/server/errors';
import { messageOf } from '@/server/redact';
import { runtime } from '@/server/runtime';

/**
 * How the pages of the Books, Safety and Settings sections read the server:
 * straight from its service functions, on the real dependencies, and never
 * by throwing. A read that fails, takes too long or finds nothing comes back
 * as a state the page shows in the place of what it would have shown.
 */

export interface Failure {
  /** Which source failed: "database", "configuration", "Hyperliquid", or the page's own patience. */
  source: string;
  reason: string;
  /** When the read was attempted. */
  at: number;
}

export type Attempt<T> =
  | { status: 'ok'; value: T }
  /** The server answered that there is no such thing. */
  | { status: 'missing' }
  | ({ status: 'unavailable' } & Failure);

/** How long a page waits for the database and the chains before it shows the read as unavailable. */
export const PATIENCE_MS = 20_000;

class Slow extends Error {}

function within<T>(ms: number, work: Promise<T>): Promise<T> {
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

/** What a failed read is shown as. A missing setting names its variable and never its value; anything unplanned is logged and named only in general. */
export function failureOf(error: unknown, at: number, patienceMs: number, deps: Pick<Deps, 'redact' | 'report'>): Failure {
  if (error instanceof ConfigError) return { source: error.variable === 'DATABASE_URL' ? 'database' : 'configuration', reason: error.message, at };
  if (error instanceof Slow) return { source: 'the server', reason: `no answer within ${patienceMs / 1000} s`, at };
  if (error instanceof ApiError) {
    const source = String(error.details.source ?? 'the server');
    const prefix = `${source} is unavailable: `;
    return { source, reason: deps.redact(error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message), at };
  }
  deps.report(deps.redact(error instanceof Error ? (error.stack ?? error.message) : messageOf(error)));
  return { source: 'database', reason: 'the database could not be read', at };
}

/** Run a read against the server's services. Nothing it throws leaves here. */
export async function attempt<T>(read: (deps: Deps) => Promise<T>, patienceMs: number = PATIENCE_MS): Promise<Attempt<T>> {
  const deps = runtime();
  const at = deps.now();
  try {
    return { status: 'ok', value: await within(patienceMs, read(deps)) };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { status: 'missing' };
    return { status: 'unavailable', ...failureOf(error, at, patienceMs, deps) };
  }
}
