import type { Metadata } from 'next';
import { SectionHeading, Unavailable } from '@/ui';
import { loadDemo } from '../../_lib/demo';
import { SettingsView } from '../../_sections/settings/SettingsView';
import { loadDemoSettings } from '../../_sections/settings/load';

export const metadata: Metadata = { title: 'Settings' };

const LEAD = 'What this organisation is called, what it is tied to, and the keys the service holds for it.';

/** The demo organisation's settings, for anyone to read. Nothing can be changed from this page. */
export default async function DemoSettingsPage() {
  const demo = await loadDemo();
  const now = Date.now();
  if (demo.status !== 'ok') {
    return (
      <div className="hf-stack">
        <SectionHeading level={1} size="page" title="Settings" lead={LEAD} />
        <Unavailable reason={`${demo.reason}; the settings cannot be shown until the demo treasury can be read`} source={demo.source} at={demo.at} now={now} />
      </div>
    );
  }
  const settings = await loadDemoSettings(demo.org.id);
  if (settings.status !== 'ok') {
    return (
      <div className="hf-stack">
        <SectionHeading level={1} size="page" title="Settings" lead={LEAD} />
        {settings.status === 'missing' ? (
          <Unavailable reason="this organisation is no longer a public demo, so its settings are not shown here" source="database" at={now} now={now} />
        ) : (
          <Unavailable reason={`${settings.reason}; the settings cannot be shown until they can be read again`} source={settings.source} at={settings.at} now={now} />
        )}
      </div>
    );
  }
  return <SettingsView facts={settings.value} now={now} base="/demo" audience="demo" />;
}
