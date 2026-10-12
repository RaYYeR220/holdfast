import type { OrgRecord } from '@holdfast/db';
import { type AuditLinkView, listLinks } from '@/server/books/audit-links';
import { demoOrg } from '@/server/demo/service';
import { type AuditPage, type BooksPage, auditPage, booksPage, demoBooksPage } from '@/server/pages/books';
import { keep } from '../../_lib/keep';
import { type Attempt, attempt } from '../safety/attempt';
import type { Period } from './model';

/**
 * What the Books pages and the auditor's view read. The books are gathered
 * once for a request: the statement, the ledger and the reconciliation all
 * describe the same moment.
 */

/** The shape of an auditor link's token: 32 random bytes in base64url. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** How long a page waits for the books: the venue's answer and, after it, the reconciliation's own patience. */
const PATIENCE_MS = 30_000;

/** Gathering the books reads a venue and two payout chains; for the public demo one gathering serves every visitor for a minute. */
const keptBooks = keep<Attempt<BooksPage>>(60_000, 32);

/** The demo treasury's books for a period, from its public face. */
export function loadDemoBooks(orgId: string, period: Period): Promise<Attempt<BooksPage>> {
  return keptBooks(JSON.stringify([orgId, period.range]), () => attempt(async (deps) => demoBooksPage(deps, await demoOrg(deps, orgId), period.range), PATIENCE_MS));
}

export interface OwnerBooks {
  page: BooksPage;
  /** Every auditor link of the organisation, newest first; revoked and expired ones too. */
  links: AuditLinkView[];
}

/** The books of the signed-in owner's organisation for a period, with its auditor links. */
export function loadOwnerBooks(org: OrgRecord, period: Period): Promise<Attempt<OwnerBooks>> {
  return attempt(async (deps) => {
    const [page, links] = await Promise.all([booksPage(deps, org, period.range), listLinks(deps, org.id)]);
    return { page, links };
  }, PATIENCE_MS);
}

/** What an auditor link opens. A token of the wrong shape names nothing, like one that is unknown, revoked or expired. */
export function loadAudit(token: string): Promise<Attempt<AuditPage>> {
  if (!TOKEN.test(token)) return Promise.resolve({ status: 'missing' });
  return attempt((deps) => auditPage(deps, token), PATIENCE_MS);
}
