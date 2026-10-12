import { Panel, SectionHeading } from '@/ui';
import { VerifyNotes } from './BooksParts';
import { Download } from './Download';

const VERIFY_COMMAND = 'pnpm --filter @holdfast/cli holdfast verify /path/to/holdfast-statement.json --ufvk-file /path/to/key.ufvk';

/**
 * The owner's exports: the statement with everything it was derived from,
 * in the form `holdfast verify` reads, and the whole ledger as CSV. Both are
 * built when asked for, from the books as they stand at that moment.
 */
export function ExportPanel({ orgId }: { orgId: string }) {
  return (
    <section aria-labelledby="bk-exports" className="bk-own">
      <SectionHeading id="bk-exports" title="Take the books with you" lead="Two files, built when you ask for them. Neither holds the viewing key, and the statement file is refused by its own builder if a secret is found in it." />
      <div className="bk-exports">
        <Panel title="Statement for holdfast verify" level={3}>
          <div className="bk-export">
            <p>
              <span className="hf-num">holdfast-statement.json</span>: the statement, the ledger, the whole journal, the swap records, each payout run beside what its chain shows now, and the policy in force. It names the treasury by its address. Give it to an auditor with the viewing key, and they can derive it again.
            </p>
            <Download source={{ kind: 'statement', orgId }} filename="holdfast-statement.json" type="application/json" label="Download the statement" working="Gathering the ledger and looking every payout run up on its chain." variant="primary" />
          </div>
        </Panel>
        <Panel title="Ledger as CSV" level={3}>
          <div className="bk-export">
            <p>
              <span className="hf-num">holdfast-ledger.csv</span>: every entry of the ledger, one line each, with its amount in base units and in dollars, its reference, its counterparty and its transaction. For a spreadsheet or an accounting system.
            </p>
            <Download source={{ kind: 'ledger', orgId }} filename="holdfast-ledger.csv" type="text/csv" label="Download the ledger" working="Gathering the ledger." />
          </div>
        </Panel>
      </div>
      <Panel title="What holdfast verify does with the statement" level={3}>
        <div className="bk-pub__body">
          <p>
            The tool takes the statement file and repeats the work instead of trusting it. Run it in a checkout of the repository, with absolute paths: relative ones are read from <code className="hf-num">apps/cli</code>.
          </p>
          <div className="bk-command">
            <code className="hf-num">{VERIFY_COMMAND}</code>
          </div>
          <VerifyNotes />
        </div>
      </Panel>
    </section>
  );
}
