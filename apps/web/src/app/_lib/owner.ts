import type { OrgRecord } from '@holdfast/db';
import { cookies } from 'next/headers';
import { cache } from 'react';
import { SESSION_COOKIE, type Session, readSession } from '@/server/auth/session';
import { ConfigError } from '@/server/errors';
import { messageOf } from '@/server/redact';
import { runtime } from '@/server/runtime';

/**
 * Who is asking, for the pages under /app: the session the request's cookie
 * stands for, checked with the secret the API checks it with, and the
 * organisation that address owns. Nothing here throws. Nobody signed in, an
 * address with no organisation, and a deployment that cannot check either are
 * each a state the page can show.
 *
 * An address may own more than one organisation; the application shows the
 * one registered first.
 */
export type OwnerRead =
  | { status: 'ok'; session: Session; org: OrgRecord }
  /** Nobody is signed in. */
  | { status: 'out' }
  /** Signed in, and the address owns no organisation yet. */
  | { status: 'none'; session: Session }
  /** The session or the organisation could not be read. `session` is null when it was the session. */
  | { status: 'unavailable'; session: Session | null; source: string; reason: string; at: number };

function failureOf(error: unknown, session: Session | null, at: number): OwnerRead {
  const deps = runtime();
  // A missing or malformed setting names its variable and never its value.
  if (error instanceof ConfigError) return { status: 'unavailable', session, source: error.variable === 'DATABASE_URL' ? 'database' : 'configuration', reason: error.message, at };
  deps.report(deps.redact(error instanceof Error ? (error.stack ?? error.message) : messageOf(error)));
  return { status: 'unavailable', session, source: session === null ? 'session' : 'database', reason: session === null ? 'the session could not be checked' : 'the database could not be read', at };
}

/** The signed-in owner and their organisation, read once for a request and shared by the layout and the page. */
export const loadOwner = cache(async (): Promise<OwnerRead> => {
  const deps = runtime();
  const at = deps.now();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token === undefined || token === '') return { status: 'out' };

  let session: Session | null;
  try {
    session = await readSession(deps.secrets.session, token, at);
  } catch (error) {
    return failureOf(error, null, at);
  }
  if (session === null) return { status: 'out' };

  try {
    const [org] = await deps.store.listOrgs({ owner: session.address });
    return org === undefined ? { status: 'none', session } : { status: 'ok', session, org };
  } catch (error) {
    return failureOf(error, session, at);
  }
});
