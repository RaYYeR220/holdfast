import type { Metadata } from 'next';
import { SectionHeading, Unavailable } from '@/ui';
import { OwnerGate } from '../../_lib/OwnerGate';
import { loadOwner } from '../../_lib/owner';
import { AuditLinksPanel } from '../../_sections/books/AuditLinksPanel';
import { BooksView } from '../../_sections/books/BooksView';
import { ExportPanel } from '../../_sections/books/ExportPanel';
import { loadOwnerBooks } from '../../_sections/books/load';
import { periodOf } from '../../_sections/books/model';

export const metadata: Metadata = { title: 'Books' };

const LEAD = 'One ledger across Zcash, Hyperliquid, the swaps and the payouts, with the statement drawn from it and the reconciliation of its records.';

/** The owner's Books page: the same books the demo shows of its own treasury, with the exports and the auditor links. */
export default async function AppBooksPage({ searchParams }: { searchParams: Promise<{ period?: string | string[] }> }) {
  const [owner, query] = await Promise.all([loadOwner(), searchParams]);
  if (owner.status !== 'ok') {
    return (
      <div className="hf-stack">
        <SectionHeading level={1} size="page" title="Books" lead={LEAD} />
        <OwnerGate owner={owner} what="the books" />
      </div>
    );
  }
  const period = periodOf(query.period);
  const books = await loadOwnerBooks(owner.org, period);
  const now = Date.now();
  if (books.status !== 'ok') {
    return (
      <div className="hf-stack">
        <SectionHeading level={1} size="page" title="Books" lead={LEAD} />
        {books.status === 'missing' ? (
          <Unavailable reason="the organisation could not be found" source="database" at={now} now={now} />
        ) : (
          <Unavailable reason={`${books.reason}; without it there is no ledger, and a ledger that silently lacked a source would be a wrong one`} source={books.source} at={books.at} now={now} />
        )}
      </div>
    );
  }
  const { page, links } = books.value;
  return (
    <BooksView
      page={page}
      period={period}
      now={now}
      base="/app"
      audience="owner"
      exports={<ExportPanel orgId={owner.org.id} />}
      auditLinks={<AuditLinksPanel orgId={owner.org.id} links={links} now={now} />}
    />
  );
}
