import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AppShell, Notice } from '@/ui';
import { loadOwner } from '../_lib/owner';

export const metadata: Metadata = {
  title: { default: 'Treasury', template: '%s · Holdfast' },
  robots: { index: false },
};

// Every page here depends on who is signed in.
export const dynamic = 'force-dynamic';

/**
 * The signed-in application: every page under /app sits in the shell, which
 * shows the address that signed in and names its organisation. Signing in
 * and the pages themselves are not this layout's work.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const owner = await loadOwner();
  const session = owner.status === 'out' ? null : owner.session;
  const hint = owner.status === 'out' ? 'Sign in to open your treasury.' : owner.status === 'none' ? 'No treasury is registered to this address yet.' : undefined;
  const problem = owner.status === 'unavailable' ? { title: owner.session === null ? 'Sessions cannot be checked' : 'The organisation could not be read', reason: owner.reason } : null;

  return (
    <AppShell
      base="/app"
      orgName={owner.status === 'ok' ? owner.org.name : null}
      identity={session === null ? { kind: 'none' } : { kind: 'address', address: session.address }}
      {...(hint === undefined ? {} : { orgHint: hint })}
      {...(problem === null ? {} : { banner: <Notice kind="warning" title={problem.title}>{problem.reason}.</Notice> })}
    >
      {children}
    </AppShell>
  );
}
