import { SectionLoading } from '../../_sections/safety/SectionLoading';

/** Shown while the ledger is gathered and every payout run is looked up on its chain. */
export default function BooksLoading() {
  return <SectionLoading title="Books" doing="Gathering the ledger, reading the hedge’s fills and funding from Hyperliquid, and looking every payout run up on its chain." parts={['Drawing up the statement', 'Reconciling the records', 'Reading the ledger']} />;
}
