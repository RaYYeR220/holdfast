import type { Metadata } from 'next';
import { SectionHeading, Unavailable } from '@/ui';
import { loadDemo } from '../../_lib/demo';
import { BooksView } from '../../_sections/books/BooksView';
import { loadDemoBooks } from '../../_sections/books/load';
import { periodOf } from '../../_sections/books/model';

export const metadata: Metadata = { title: 'Books' };

const LEAD = 'One ledger across Zcash, Hyperliquid, the swaps and the payouts, with the statement drawn from it and the reconciliation of its records.';

/** The demo treasury's books, for anyone to read. Nothing can be exported or shared from this page. */
export default async function DemoBooksPage({ searchParams }: { searchParams: Promise<{ period?: string | string[] }> }) {
  const [demo, query] = await Promise.all([loadDemo(), searchParams]);
  const now = Date.now();
  if (demo.status !== 'ok') {
    return (
      <div className="hf-stack">
        <SectionHeading level={1} size="page" title="Books" lead={LEAD} />
        <Unavailable reason={`${demo.reason}; the books cannot be shown until the demo treasury can be read`} source={demo.source} at={demo.at} now={now} />
      </div>
    );
  }
  const period = periodOf(query.period);
  const books = await loadDemoBooks(demo.org.id, period);
  if (books.status !== 'ok') {
    return (
      <div className="hf-stack">
        <SectionHeading level={1} size="page" title="Books" lead={LEAD} />
        {books.status === 'missing' ? (
          <Unavailable reason="this organisation is no longer a public demo, so its books are not shown here" source="database" at={now} now={now} />
        ) : (
          <Unavailable reason={`${books.reason}; without it there is no ledger, and a ledger that silently lacked a source would be a wrong one`} source={books.source} at={books.at} now={now} />
        )}
      </div>
    );
  }
  return <BooksView page={books.value} period={period} now={Date.now()} base="/demo" audience="demo" />;
}
