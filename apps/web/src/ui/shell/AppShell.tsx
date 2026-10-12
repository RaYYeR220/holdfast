import NextLink from 'next/link';
import type { ReactNode } from 'react';
import { shorten } from '../format';
import { ShellNav } from './ShellNav';

/** The sections of a treasury, in the order of the rail. Each lives at `<base>/<slug>`; the overview is the base itself. */
export const SHELL_SECTIONS = [
  { slug: '', label: 'Overview' },
  { slug: 'treasury', label: 'Treasury' },
  { slug: 'lock', label: 'Lock' },
  { slug: 'payouts', label: 'Payouts' },
  { slug: 'books', label: 'Books' },
  { slug: 'safety', label: 'Safety' },
  { slug: 'settings', label: 'Settings' },
] as const;

export type ShellIdentity =
  /** The public demo: anyone may read, nobody may change. */
  | { kind: 'demo' }
  /** The signed-in application, and the address that signed in. */
  | { kind: 'address'; address: string }
  /** The signed-in application before anyone has signed in. */
  | { kind: 'none' };

export interface AppShellProps {
  /** The path the area lives under: "/demo" or "/app". */
  base: string;
  /** The organisation's name. Null when it could not be read; the header then says so. */
  orgName: string | null;
  /** Shown in place of the name when there is no organisation to name: nobody is signed in, or the account has none yet. */
  orgHint?: string;
  identity: ShellIdentity;
  /** For the right of the header: sign in, sign out, an organisation switcher. */
  aside?: ReactNode;
  /** Shown above the page on every route of the area: a failed source, a notice of maintenance. */
  banner?: ReactNode;
  /** The page. */
  children: ReactNode;
}

function Identity({ identity }: { identity: ShellIdentity }) {
  if (identity.kind === 'demo') {
    return (
      <p className="hf-shell__who">
        <i className="hf-swatch hf-pat-limit" aria-hidden="true" />
        Public demo, read only
      </p>
    );
  }
  if (identity.kind === 'address') {
    return (
      <p className="hf-shell__who" title={identity.address}>
        <i className="hf-swatch hf-pat-locked" aria-hidden="true" />
        <span className="hf-sr">Signed in as </span>
        <span className="hf-shell__address">{shorten(identity.address, 6, 4)}</span>
      </p>
    );
  }
  return (
    <p className="hf-shell__who">
      <i className="hf-swatch hf-pat-unlocked" aria-hidden="true" />
      Not signed in
    </p>
  );
}

/**
 * The frame of both product areas: the public demo under /demo and the
 * signed-in application under /app. A rail of the seven sections, a header
 * that names the organisation and says who is looking, and the page.
 *
 * The rail and the header are ink; the page is paper. From 1000px down the
 * rail becomes a strip under the header that scrolls sideways, so every
 * section stays one tap away at 390px.
 */
export function AppShell({ base, orgName, orgHint, identity, aside, banner, children }: AppShellProps) {
  const items = SHELL_SECTIONS.map((section) => ({ label: section.label, href: section.slug === '' ? base : `${base}/${section.slug}` }));
  return (
    <div className="hf-shell hf-ink">
      <a className="hf-shell__skip" href="#content">
        Skip to the page
      </a>
      <div className="hf-shell__rail">
        <NextLink className="hf-shell__mark" href="/" prefetch={false}>
          Holdfast
        </NextLink>
        <ShellNav items={items} base={base} label={identity.kind === 'demo' ? 'Demo treasury' : 'Treasury'} />
        <p className="hf-shell__railfoot">
          <a className="hf-link" href="https://github.com/RaYYeR220/holdfast#readme">
            Docs
          </a>
        </p>
      </div>
      <div className="hf-shell__main">
        <header className="hf-shell__head">
          <div className="hf-shell__org">
            <p className="hf-shell__orglabel">{identity.kind === 'demo' ? 'Demo treasury' : 'Organisation'}</p>
            {orgHint !== undefined ? (
              <p className="hf-shell__orghint">{orgHint}</p>
            ) : orgName === null ? (
              <p className="hf-shell__orgname" data-state="stale">
                <i className="hf-swatch hf-pat-stale" aria-hidden="true" />
                Name unavailable
              </p>
            ) : (
              <p className="hf-shell__orgname">{orgName}</p>
            )}
          </div>
          <div className="hf-shell__aside">
            <Identity identity={identity} />
            {aside}
          </div>
        </header>
        <div className="hf-shell__band hf-paper" aria-hidden="true">
          <i className="hf-t75" />
          <i className="hf-t50" />
          <i className="hf-t25" />
          <i className="hf-t12" />
        </div>
        <main className="hf-shell__page hf-paper" id="content">
          <div className="hf-shell__inner">
            {banner !== undefined && <div className="hf-shell__banner">{banner}</div>}
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
