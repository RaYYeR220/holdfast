import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { SESSION_COOKIE, type Session, readSession } from '@/server/auth/session';
import { listOrganisations } from '@/server/orgs/service';
import { runtime } from '@/server/runtime';
import { AppShell, Notice } from '@/ui';

export const metadata: Metadata = {
  title: { default: 'Treasury', template: '%s · Holdfast' },
  robots: { index: false },
};

// Every page here depends on who is signed in.
export const dynamic = 'force-dynamic';

type Who = { status: 'in'; session: Session } | { status: 'out' } | { status: 'unavailable'; reason: string };

const reasonOf = (error: unknown) => runtime().redact(error instanceof Error ? error.message : String(error));

/** The session the request's cookie stands for, checked with the same secret the API checks it with. */
async function whoIsSignedIn(): Promise<Who> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token === undefined || token === '') return { status: 'out' };
  const deps = runtime();
  try {
    const session = await readSession(deps.secrets.session, token, deps.now());
    return session === null ? { status: 'out' } : { status: 'in', session };
  } catch (error) {
    // A deployment without SESSION_SECRET cannot check a session; the message names the variable.
    return { status: 'unavailable', reason: reasonOf(error) };
  }
}

/** The name of the first organisation the address owns: null when it has none, a reason when the database cannot say. */
async function organisationOf(address: string): Promise<{ status: 'ok'; name: string | null } | { status: 'unavailable'; reason: string }> {
  try {
    const [first] = await listOrganisations(runtime(), address);
    return { status: 'ok', name: first?.name ?? null };
  } catch (error) {
    return { status: 'unavailable', reason: reasonOf(error) };
  }
}

/**
 * The signed-in application: every page under /app sits in the shell, which
 * shows the address that signed in and names its organisation. Signing in
 * and the pages themselves are not this layout's work.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const who = await whoIsSignedIn();
  const org = who.status === 'in' ? await organisationOf(who.session.address) : null;

  const problem = who.status === 'unavailable' ? { title: 'Sessions cannot be checked', reason: who.reason } : org?.status === 'unavailable' ? { title: 'The organisation could not be read', reason: org.reason } : null;
  const hint = who.status !== 'in' ? 'Sign in to open your treasury.' : org?.status === 'ok' && org.name === null ? 'No treasury is registered to this address yet.' : undefined;

  return (
    <AppShell
      base="/app"
      orgName={org?.status === 'ok' ? org.name : null}
      identity={who.status === 'in' ? { kind: 'address', address: who.session.address } : { kind: 'none' }}
      {...(hint === undefined ? {} : { orgHint: hint })}
      {...(problem === null ? {} : { banner: <Notice kind="warning" title={problem.title}>{problem.reason}.</Notice> })}
    >
      {children}
    </AppShell>
  );
}
