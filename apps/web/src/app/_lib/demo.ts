import { cache } from 'react';
import { type DemoJournal, type DemoOverview, demoJournal, demoList, demoOrg, demoOverview } from '@/server/demo/service';
import { ApiError, ConfigError } from '@/server/errors';
import { messageOf } from '@/server/redact';
import { runtime } from '@/server/runtime';

/**
 * The public demo treasury as the pages read it: straight from the service
 * functions behind /api/demo, on the real dependencies. Nothing here throws.
 * A deployment without a database, a database that cannot be reached and a
 * database with no demo organisation each come back as a state the page can
 * show.
 */

export interface Failure {
  /** Which source failed: "database" or "configuration". */
  source: string;
  reason: string;
  /** When the read was attempted. */
  at: number;
}

export type DemoRead =
  | { status: 'ok'; org: { id: string; name: string }; overview: DemoOverview; journal: { status: 'ok'; value: DemoJournal } | ({ status: 'unavailable' } & Failure); readAt: number }
  /** The database answered and holds no organisation that chose to be a public demo. */
  | ({ status: 'empty' } & Failure)
  | ({ status: 'unavailable' } & Failure);

const JOURNAL_ROWS = 6;
/** How long a page waits for the database and the venue before it shows the read as unavailable. */
const PATIENCE_MS = 8_000;

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

function failureOf(error: unknown, at: number): Failure {
  const deps = runtime();
  // A missing or malformed setting names its variable and never its value.
  if (error instanceof ConfigError) return { source: error.variable === 'DATABASE_URL' ? 'database' : 'configuration', reason: error.message, at };
  if (error instanceof Slow) return { source: 'database', reason: `no answer within ${PATIENCE_MS / 1000} s`, at };
  if (error instanceof ApiError) return { source: String(error.details.source ?? 'server'), reason: deps.redact(error.message), at };
  deps.report(deps.redact(error instanceof Error ? (error.stack ?? error.message) : messageOf(error)));
  return { source: 'database', reason: 'the database could not be read', at };
}

/** The demo treasury, read once for a request and shared by the layout and the page. */
export const loadDemo = cache(async (): Promise<DemoRead> => {
  const deps = runtime();
  const at = deps.now();
  const read = async (): Promise<DemoRead> => {
    const [first] = await demoList(deps);
    if (first === undefined) return { status: 'empty', source: 'database', reason: 'no organisation has chosen to be a public demo', at };
    const org = await demoOrg(deps, first.id);
    const [overview, journal] = await Promise.all([
      demoOverview(deps, org),
      demoJournal(deps, org, { limit: JOURNAL_ROWS }).then(
        (value) => ({ status: 'ok' as const, value }),
        (error: unknown) => ({ status: 'unavailable' as const, ...failureOf(error, deps.now()) }),
      ),
    ]);
    return { status: 'ok', org: { id: org.id, name: org.name }, overview, journal, readAt: deps.now() };
  };
  try {
    return await within(PATIENCE_MS, read());
  } catch (error) {
    return { status: 'unavailable', ...failureOf(error, at) };
  }
});
