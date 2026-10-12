import type { ReactNode } from 'react';
import type { BooksPage } from '@/server/pages/books';
import { BooksPlate, CopyButton, Link, Panel, Plate, SectionHeading } from '@/ui';
import { LedgerPanel, ReconciliationPanel, StatementPanel, VerifyNotes } from './BooksParts';
import { type Period, monthName } from './model';

export interface BooksViewProps {
  page: BooksPage;
  period: Period;
  /** The server's clock at render. */
  now: number;
  /** Where this workspace lives: "/demo" or "/app". */
  base: string;
  audience: 'demo' | 'owner';
  /** The owner's panel that downloads the exports. The demo passes none and says where its published statement is. */
  exports?: ReactNode;
  /** The owner's panel of auditor links. */
  auditLinks?: ReactNode;
}

const STATEMENT_URL = 'https://github.com/RaYYeR220/holdfast/blob/main/demo/statement.json';
const KEY_URL = 'https://github.com/RaYYeR220/holdfast/blob/main/demo/treasury.ufvk';
const VERIFY_COMMAND = 'pnpm --filter @holdfast/cli holdfast verify <repo>/demo/statement.json --ufvk-file <repo>/demo/treasury.ufvk';

function PeriodNav({ base, period, months }: { base: string; period: Period; months: readonly string[] }) {
  const choices = [{ id: 'all', label: 'All time', href: `${base}/books` }, ...[...months].reverse().map((month) => ({ id: month, label: monthName(month), href: `${base}/books?period=${month}` }))];
  return (
    <nav className="bk-periods" aria-label="Period of the statement">
      <span className="bk-periods__label hf-px">Period</span>
      <ul>
        {choices.map((choice) => (
          <li key={choice.id}>
            <Link href={choice.href} variant="nav" current={choice.id === period.id}>
              {choice.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * The Books page: the statement for a period, the reconciliation of the
 * records behind it, and the ledger. The same view serves the public demo,
 * which adds where its published statement is and how to verify it, and the
 * owner, who adds the exports and the auditor links.
 */
export function BooksView({ page, period, now, base, audience, exports, auditLinks }: BooksViewProps) {
  const periodName = period.id === 'all' ? 'All time' : monthName(period.id);
  const shown = page.ledger.length;
  return (
    <div className="hf-stack hf-stack--loose bk">
      <SectionHeading
        level={1}
        size="page"
        title="Books"
        lead="One ledger across Zcash, Hyperliquid, the swaps and the payouts: what came in, what the hedge made or cost, what was paid out and what is held now."
      />

      <div className="hf-stack">
        <PeriodNav base={base} period={period} months={page.months} />
        <StatementPanel statement={page.statement} ledger={page.ledger} now={now} periodName={periodName} {...(audience === 'owner' ? { burnHref: `${base}/settings` } : {})} />
      </div>

      <ReconciliationPanel reconciliation={page.reconciliation} now={now} />

      <LedgerPanel
        ledger={page.ledger}
        now={now}
        empty={page.entries === 0 ? 'Nothing has moved yet. The first entry appears when the viewing key shows a payment in, or the venue shows a fill.' : `No entry of the ledger falls in ${periodName}. The ledger holds ${page.entries} in all.`}
        note={
          <>
            {period.id === 'all' ? `All ${page.entries} entries of the ledger.` : `${shown} of the ledger’s ${page.entries} entries fall in ${periodName}.`} Funding is paid every hour, so each day’s payments are added up into one row here; {audience === 'owner' ? 'the exports hold' : 'the published statement holds'} every entry singly.
            {audience === 'demo' && ' Payees are not named on this public page; each payout line links to its transaction.'}
          </>
        }
      />

      {audience === 'demo' ? (
        <section aria-labelledby="bk-verify" className="bk-own">
          <SectionHeading
            id="bk-verify"
            title="Derive these books again"
            lead="The demo treasury’s statement is published with everything it was derived from. One command repeats the work instead of trusting it."
          />
          <div className="bk-pub">
            <Plate className="bk-pub__plate">
              <BooksPlate label="A ruled page with every line ticked" className="bk-pub__pic" />
            </Plate>
            <Panel title="The published statement" level={3}>
              <div className="bk-pub__body">
                <p>
                  <Link href={STATEMENT_URL} external>
                    demo/statement.json
                  </Link>{' '}
                  in the repository is the statement as the owner’s export wrote it: the ledger, the whole journal, the swap records, each payout run beside what its chain showed, and the policy in force.{' '}
                  <Link href={KEY_URL} external>
                    demo/treasury.ufvk
                  </Link>{' '}
                  is the treasury’s viewing key, published on purpose so that anyone can read the shielded payments this ledger starts from.
                </p>
                <div className="bk-command">
                  <code className="hf-num">{VERIFY_COMMAND}</code>
                  <CopyButton value={VERIFY_COMMAND} what="command" />
                </div>
                <p className="hf-small">
                  Run it in a checkout of the repository, with <code className="hf-num">&lt;repo&gt;</code> replaced by the checkout’s absolute path: relative paths are read from <code className="hf-num">apps/cli</code>. The statement is a file from one moment, so its totals are those of that moment and not of this page.
                </p>
              </div>
            </Panel>
          </div>
          <Panel title="What holdfast verify does" level={3}>
            <VerifyNotes />
          </Panel>
          <p className="hf-small bk-who">
            The owner of a treasury downloads the same file for their own books from this page, and makes links that let an auditor read a chosen part of them without an account. The demo is read only, so neither is offered here.
          </p>
        </section>
      ) : (
        <>
          {exports}
          {auditLinks}
        </>
      )}
    </div>
  );
}
