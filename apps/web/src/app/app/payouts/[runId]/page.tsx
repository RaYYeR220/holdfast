import type { Metadata } from 'next';
import { SectionHeading } from '@/ui';
import { OwnerGate } from '../../../_lib/OwnerGate';
import { loadOwner } from '../../../_lib/owner';
import { ExecuteRun } from '../../../_sections/payouts/ExecuteRun';
import { RunPreview } from '../../../_sections/payouts/RunPreview';
import { NoSuchRun, RunView } from '../../../_sections/payouts/RunView';
import { tokenText } from '../../../_sections/payouts/format';
import { loadRun, siteOrigin } from '../../../_sections/payouts/load';
import { GapNote } from '../../../_sections/payouts/parts';

interface Props {
  params: Promise<{ runId: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { runId } = await params;
  return { title: /^HF-\d{4}-\d{2}-\d{4}$/.test(runId) ? `Run ${runId}` : 'Payout run' };
}

/**
 * One run of the owner's: its record beside what its chain holds now, what
 * paying it would do, the button that pays it, and its lines with the
 * receipt of each.
 */
export default async function RunPage({ params }: Props) {
  const { runId } = await params;
  const owner = await loadOwner();
  if (owner.status !== 'ok') {
    return (
      <div className="hf-stack">
        <SectionHeading level={1} size="page" kicker="Payout run" title="Payout run" />
        <OwnerGate owner={owner} what="this payout run" />
      </div>
    );
  }
  const { org } = owner;
  const [{ page, tempo, solana }, origin] = await Promise.all([loadRun(org, runId, 'owner'), siteOrigin()]);
  const now = Date.now();
  if (page.status !== 'ok') {
    return (
      <div className="hf-stack">
        <SectionHeading level={1} size="page" kicker="Payout run" title="Run unavailable" />
        <GapNote gap={page} now={now} />
      </div>
    );
  }
  if (page.value === null) return <NoSuchRun runId={runId} base="/app" audience="owner" />;

  const { run, preview } = page.value;
  return (
    <RunView
      audience="owner"
      page={page.value}
      now={now}
      base="/app"
      origin={origin}
      actions={
        <RunPreview page={page.value} tempo={tempo} solana={solana} now={now}>
          <ExecuteRun
            orgId={org.id}
            runId={run.id}
            chain={run.chain}
            total={tokenText(run.total, run.token)}
            lines={run.lines.length}
            standing={run.status === 'paid' ? 'paid' : run.status === 'sending' ? 'unsettled' : 'unpaid'}
            wouldProceed={preview === null || preview.status !== 'ok' ? null : preview.value.wouldProceed}
          />
        </RunPreview>
      }
    />
  );
}
