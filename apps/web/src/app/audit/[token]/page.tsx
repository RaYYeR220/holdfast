import { SectionHeading, Unavailable } from '@/ui';
import { AuditGone } from '../../_sections/books/AuditGone';
import { AuditView } from '../../_sections/books/AuditView';
import { Download } from '../../_sections/books/Download';
import { loadAudit } from '../../_sections/books/load';

/**
 * The auditor's view: the part of an organisation's books a link opens, for
 * whoever holds the link, without a session. A link that opens nothing is a
 * state of this page like any other; the route behind it, which programs
 * call, answers such a token with "not found".
 */
export default async function AuditViewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const audit = await loadAudit(token);
  // Unknown, revoked and expired are one answer.
  if (audit.status === 'missing') return <AuditGone />;
  const now = Date.now();

  if (audit.status === 'unavailable') {
    return (
      <div className="hf-stack">
        <SectionHeading level={1} size="page" kicker="Auditor’s view" title="The books could not be read" />
        <Unavailable reason={`${audit.reason}; without it there is no ledger to show, and one that silently lacked a source would be a wrong one`} source={audit.source} at={audit.at} now={now} />
        <p>The link itself may be in order. Open it again in a little while.</p>
      </div>
    );
  }

  return (
    <AuditView
      audit={audit.value}
      now={now}
      download={<Download source={{ kind: 'audit', token }} filename="holdfast-ledger.csv" type="text/csv" label="Download as CSV" working="Reading the ledger again for the file." />}
    />
  );
}
