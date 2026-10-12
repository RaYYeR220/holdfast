import type { Metadata } from 'next';
import { SectionHeading } from '@/ui';
import { PayoutsView } from '../../_sections/payouts/PayoutsView';
import { loadDemoOrg, loadPayouts } from '../../_sections/payouts/load';
import { GapNote } from '../../_sections/payouts/parts';

export const metadata: Metadata = { title: 'Payouts' };

/**
 * The payouts of the public demo treasury: both rails as their chains report
 * them now and the runs that were paid. It offers no action; where the owner
 * has one, it says whose signature that takes.
 */
export default async function DemoPayoutsPage() {
  const demo = await loadDemoOrg();
  if (demo.status !== 'ok') {
    return (
      <div className="hf-stack">
        <SectionHeading level={1} size="page" title="Payouts" lead="The two payout rails of the demo treasury and the runs paid through them." />
        <GapNote gap={demo} now={Date.now()} />
      </div>
    );
  }
  const data = await loadPayouts(demo.org, 'public');
  return <PayoutsView audience="public" data={data} now={Date.now()} base="/demo" />;
}
