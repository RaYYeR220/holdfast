import { AUDIT_MODULES } from '@holdfast/books';
import type { ReactNode } from 'react';
import { type AuditPage, RECONCILIATION_CHECKS } from '@/server/pages/books';
import { Panel, SectionHeading, StateTag, Tag, Timestamp, formatUtc } from '@/ui';
import { LedgerPanel, ReconciliationPanel, StatementPanel, VerifyNotes } from './BooksParts';
import { MODULE_COVERS, MODULE_NAME, scopeDates } from './model';

export interface AuditViewProps {
  audit: AuditPage;
  /** The server's clock at render. */
  now: number;
  /** The control that downloads the scoped ledger as CSV. */
  download?: ReactNode;
}

const VERIFY_COMMAND = 'pnpm --filter @holdfast/cli holdfast verify /path/to/holdfast-statement.json --ufvk-file /path/to/key.ufvk';

/**
 * What an auditor link opens: whose books these are, the scope stated first,
 * then the statement, the reconciliation and the ledger of that scope, and
 * how to check each of them without trusting this page.
 */
export function AuditView({ audit, now, download }: AuditViewProps) {
  const { organisation, label, expiresAt, scope, statement, ledger, checks, reconciliation } = audit;
  const dates = scopeDates(scope, (ms) => formatUtc(ms));
  const hidden = RECONCILIATION_CHECKS.filter((id) => !checks.includes(id));
  const openDates = scope.from === null && (scope.to === null || scope.to >= statement.asOf);
  const whole = openDates && AUDIT_MODULES.every((module) => scope.modules.includes(module));

  return (
    <div className="hf-stack hf-stack--loose bk">
      <SectionHeading
        level={1}
        size="page"
        kicker="Auditor’s view"
        title={`Books of ${organisation}`}
        lead="The organisation’s own ledger, cut down to what the link you hold covers. Nothing outside that scope is shown, and no total is carried over from it."
      />

      <Panel framed title="What this link covers" level={2} aside={<Tag variant="solid">{label}</Tag>}>
        <div className="au-scope">
          <dl className="bk-lock__facts">
            <div>
              <dt>Dates</dt>
              <dd>{dates}</dd>
            </div>
            <div>
              <dt>Works until</dt>
              <dd>{expiresAt === null ? 'No expiry is set. The organisation can revoke it at any time.' : <Timestamp at={expiresAt} show="absolute" />}</dd>
            </div>
            <div>
              <dt>Read</dt>
              <dd>
                <Timestamp at={statement.asOf} now={now} />
              </dd>
            </div>
          </dl>
          <ul className="au-scope__modules">
            {AUDIT_MODULES.map((module) => {
              const included = scope.modules.includes(module);
              return (
                <li key={module}>
                  <StateTag state={included ? 'locked' : 'stale'} label={MODULE_NAME[module]} />
                  <span>{included ? `${MODULE_COVERS[module]}.` : 'Not included. No entry, total or check of this module is shown.'}</span>
                </li>
              );
            })}
          </ul>
        </div>
      </Panel>

      <StatementPanel statement={statement} ledger={ledger} now={now} periodName={scope.from === null && scope.to === null ? 'Every date' : dates} modules={scope.modules} whole={whole} />

      {reconciliation === null ? (
        <Panel title="Reconciliation" level={2} state="stale" stateLabel="Outside this scope">
          <p>
            The reconciliation holds every record of a kind against the others, from the first to the latest, and its findings name records by id and by amount. A check is therefore shown only to a link that covers the modules it reads{openDates ? '' : ', with no date that leaves a record out'}. This link shows none of them.
          </p>
        </Panel>
      ) : (
        <ReconciliationPanel reconciliation={reconciliation} now={now} hidden={hidden} />
      )}

      <LedgerPanel
        ledger={ledger}
        now={now}
        empty="No entry of the ledger falls inside this link’s dates and modules."
        {...(download === undefined ? {} : { aside: download })}
        note={
          <>
            {ledger.length === 0 ? 'This link covers no entry yet.' : ledger.length === 1 ? 'The one entry this link covers.' : `The ${ledger.length} entries this link covers.`} Funding is paid every hour, so each day’s payments are added up into one row here; the CSV holds every entry singly.
          </>
        }
      />

      <section aria-labelledby="au-verify" className="bk-own">
        <SectionHeading id="au-verify" title="Check it without trusting this page" lead="Everything above is what the service read and booked. Each part of it can be held against its source." />
        <Panel title="Against the chains" level={3}>
          <ul className="bk-verify__steps">
            <li>Every row with a transaction links to it on its chain’s explorer. A payout on Tempo or Solana shows its amount, its recipient and its memo there.</li>
            <li>
              A Zcash explorer shows that a shielded transaction exists, and neither its amount nor its memo. To read those, ask the organisation for the treasury’s viewing key and import it into any wallet that takes one: a viewing key shows what was received and sent, and cannot spend.
            </li>
            <li>The hedge is public. The fills and the funding of the organisation’s Hyperliquid account can be read on the exchange by anyone who knows the account’s address.</li>
          </ul>
        </Panel>
        <Panel title="With holdfast verify" level={3}>
          <div className="bk-pub__body">
            <p>Ask the organisation for its statement export, the file its owner downloads from the Books page, and for the viewing key. The tool then repeats the work instead of trusting it:</p>
            <div className="bk-command">
              <code className="hf-num">{VERIFY_COMMAND}</code>
            </div>
            <VerifyNotes />
          </div>
        </Panel>
      </section>
    </div>
  );
}
