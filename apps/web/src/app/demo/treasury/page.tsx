import type { Metadata } from 'next';
import { SectionHeading, Unavailable } from '@/ui';
import { sourceName } from '../../_sections/overview/OverviewBody';
import { TreasuryView } from '../../_sections/treasury/TreasuryView';
import { loadDemoTreasury } from '../../_sections/treasury/load';

export const metadata: Metadata = { title: 'Treasury' };

/** The treasury of the public demo: read only, no sign-in. */
export default async function DemoTreasuryPage() {
  const read = await loadDemoTreasury();
  const now = Date.now();

  if (read.status !== 'ok') {
    return (
      <div className="hf-stack">
        <SectionHeading level={1} size="page" title="Treasury" lead="What the viewing key shows of the demo treasury: its balance, the payments that reached it and what it sent." />
        <Unavailable reason={`${read.reason}; the treasury cannot be shown until the demo treasury can be read again`} source={sourceName(read.source)} at={read.at} now={now} />
      </div>
    );
  }
  return <TreasuryView base="/demo" now={now} data={read.data} />;
}
