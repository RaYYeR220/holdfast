import type { Metadata } from 'next';
import NextLink from 'next/link';
import type { ReactNode } from 'react';
import '../_sections/books/books.css';

export const metadata: Metadata = {
  title: 'Auditor’s view',
  description: 'The part of an organisation’s books an auditor link opens, read only.',
  // An address that carries a link's token is not for a search engine, and is not handed on to the pages it links to.
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

// What a link opens depends on whether it has been revoked or has expired at the moment it is used.
export const dynamic = 'force-dynamic';

/**
 * The frame of the auditor's view. It stands outside the workspace: no rail
 * of sections and no sign-in, only the name of the service, what kind of
 * page this is, and the page.
 */
export default function AuditLayout({ children }: { children: ReactNode }) {
  return (
    <div className="au hf-ink">
      <a className="hf-shell__skip" href="#content">
        Skip to the page
      </a>
      <header className="au-head">
        <div className="au-head__in">
          <div>
            <NextLink className="au-mark" href="/" prefetch={false}>
              Holdfast
            </NextLink>
            <p className="au-kind">Auditor’s view</p>
          </div>
          <p className="au-who">
            <i className="hf-swatch hf-pat-limit" aria-hidden="true" />
            Read only, no account
          </p>
        </div>
      </header>
      <div className="au-band hf-paper" aria-hidden="true">
        <i className="hf-t75" />
        <i className="hf-t50" />
        <i className="hf-t25" />
        <i className="hf-t12" />
      </div>
      <main className="au-page hf-paper" id="content">
        <div className="au-page__in">{children}</div>
      </main>
    </div>
  );
}
