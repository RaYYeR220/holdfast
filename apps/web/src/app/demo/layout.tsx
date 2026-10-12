import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AppShell, Notice } from '@/ui';
import { loadDemo } from '../_lib/demo';

export const metadata: Metadata = {
  title: { default: 'Demo treasury', template: '%s · Demo treasury · Holdfast' },
  description: 'The Holdfast demo treasury on mainnet: public and read only.',
};

// The demo shows what the chains and the venue say now; nothing here is built ahead of the request.
export const dynamic = 'force-dynamic';

/**
 * The public demo workspace: every page under /demo sits in the shell, reads
 * the same demo organisation and needs no sign-in. When the organisation
 * cannot be read the shell says so above the page, and each page shows its
 * own figures as unavailable.
 */
export default async function DemoLayout({ children }: { children: ReactNode }) {
  const demo = await loadDemo();
  const banner =
    demo.status === 'ok' ? undefined : demo.status === 'empty' ? (
      <Notice kind="warning" title="There is no demo treasury here">
        The database answered, and no organisation in it has chosen to be a public demo.
      </Notice>
    ) : (
      <Notice kind="warning" title="The demo treasury could not be read">
        Source: {demo.source}. {demo.reason}. Figures on this page are shown as unavailable until it can be read again.
      </Notice>
    );
  return (
    <AppShell base="/demo" orgName={demo.status === 'ok' ? demo.org.name : null} identity={{ kind: 'demo' }} {...(banner === undefined ? {} : { banner })}>
      {children}
    </AppShell>
  );
}
