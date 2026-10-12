import type { Metadata } from 'next';
import { SectionHeading } from '@/ui';
import { loadDemo } from '../_lib/demo';
import { OverviewBody } from '../_sections/overview/OverviewBody';

export const metadata: Metadata = { title: 'Overview' };

export default async function DemoOverviewPage() {
  const demo = await loadDemo();
  const now = Date.now();
  const overview = demo.status === 'ok' ? demo.overview : null;
  const failure = demo.status === 'ok' ? null : { source: demo.source, reason: demo.reason, at: demo.at };

  return (
    <div className="hf-stack">
      <SectionHeading level={1} size="page" title="Overview" lead="What the treasury holds, how much of its dollar value is locked, and when each figure was read. Anyone can read this page. Nobody can change anything from it." />
      <OverviewBody overview={overview} journal={demo.status === 'ok' ? demo.journal : null} failure={failure} now={now} />
    </div>
  );
}
