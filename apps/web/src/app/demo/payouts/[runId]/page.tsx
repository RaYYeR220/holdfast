import type { Metadata } from 'next';
import { SectionHeading } from '@/ui';
import { NoSuchRun, RunView } from '../../../_sections/payouts/RunView';
import { loadDemoOrg, loadRun, siteOrigin } from '../../../_sections/payouts/load';
import { GapNote } from '../../../_sections/payouts/parts';

interface Props {
  params: Promise<{ runId: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { runId } = await params;
  return { title: /^HF-\d{4}-\d{2}-\d{4}$/.test(runId) ? `Run ${runId}` : 'Payout run' };
}

/**
 * One paid run of the public demo treasury: its lines with their amounts,
 * memos and receipts, its transaction, and for a Solana run its marker as
 * the chain has it now. Payees are not named.
 */
export default async function DemoRunPage({ params }: Props) {
  const { runId } = await params;
  const demo = await loadDemoOrg();
  if (demo.status !== 'ok') {
    return (
      <div className="hf-stack">
        <SectionHeading level={1} size="page" kicker="Payout run" title="Run unavailable" />
        <GapNote gap={demo} now={Date.now()} />
      </div>
    );
  }
  const [{ page }, origin] = await Promise.all([loadRun(demo.org, runId, 'public'), siteOrigin()]);
  const now = Date.now();
  if (page.status !== 'ok') {
    return (
      <div className="hf-stack">
        <SectionHeading level={1} size="page" kicker="Payout run" title="Run unavailable" />
        <GapNote gap={page} now={now} />
      </div>
    );
  }
  if (page.value === null) return <NoSuchRun runId={runId} base="/demo" audience="public" />;
  return <RunView audience="public" page={page.value} now={now} base="/demo" origin={origin} />;
}
