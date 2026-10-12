import type { Metadata } from 'next';
import { SectionHeading, Unavailable } from '@/ui';
import { loadDemo } from '../../_lib/demo';
import { SafetyView } from '../../_sections/safety/SafetyView';
import { loadDemoSafety } from '../../_sections/safety/load';

export const metadata: Metadata = { title: 'Safety' };

const LEAD = 'The keys the service holds for this treasury, what each can and cannot do, and every time one was made to exceed its authority.';

/** The demo treasury's keys and refusals, for anyone to read. Nothing can be done from this page. */
export default async function DemoSafetyPage() {
  const demo = await loadDemo();
  const now = Date.now();
  if (demo.status !== 'ok') {
    return (
      <div className="hf-stack">
        <SectionHeading level={1} size="page" title="Safety" lead={LEAD} />
        <Unavailable reason={`${demo.reason}; the keys and the refusals cannot be shown until the demo treasury can be read`} source={demo.source} at={demo.at} now={now} />
      </div>
    );
  }
  const safety = await loadDemoSafety(demo.org.id);
  if (safety.status !== 'ok') {
    return (
      <div className="hf-stack">
        <SectionHeading level={1} size="page" title="Safety" lead={LEAD} />
        {safety.status === 'missing' ? (
          <Unavailable reason="this organisation is no longer a public demo, so its keys are not shown here" source="database" at={now} now={now} />
        ) : (
          <Unavailable reason={`${safety.reason}; the keys and the refusals cannot be shown until they can be read again`} source={safety.source} at={safety.at} now={now} />
        )}
      </div>
    );
  }
  return <SafetyView data={safety.value} now={Date.now()} base="/demo" audience="demo" />;
}
