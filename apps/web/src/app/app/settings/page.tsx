import type { Metadata } from 'next';
import { Panel, SectionHeading, Timestamp, Unavailable } from '@/ui';
import { OwnerGate } from '../../_lib/OwnerGate';
import { loadOwner } from '../../_lib/owner';
import { Address } from '../../_sections/safety/parts';
import { ProfileForm } from '../../_sections/settings/ProfileForm';
import { SettingsView } from '../../_sections/settings/SettingsView';
import { SignOut } from '../../_sections/settings/SignOut';
import { loadOwnerSettings } from '../../_sections/settings/load';

export const metadata: Metadata = { title: 'Settings' };

const LEAD = 'What this organisation is called, what it is tied to, and the keys the service holds for it.';

/** The owner's Settings page: the same facts the demo shows of its own organisation, with the profile form and the way out. */
export default async function AppSettingsPage() {
  const owner = await loadOwner();
  if (owner.status !== 'ok') {
    return (
      <div className="hf-stack">
        <SectionHeading level={1} size="page" title="Settings" lead={LEAD} />
        <OwnerGate owner={owner} what="the settings" />
      </div>
    );
  }
  const settings = await loadOwnerSettings(owner.org);
  const now = Date.now();
  if (settings.status !== 'ok') {
    return (
      <div className="hf-stack">
        <SectionHeading level={1} size="page" title="Settings" lead={LEAD} />
        {settings.status === 'missing' ? (
          <Unavailable reason="the organisation could not be found" source="database" at={now} now={now} />
        ) : (
          <Unavailable reason={`${settings.reason}; the settings cannot be shown until they can be read again`} source={settings.source} at={settings.at} now={now} />
        )}
      </div>
    );
  }
  const facts = settings.value;
  return (
    <SettingsView
      facts={facts}
      now={now}
      base="/app"
      audience="owner"
      profile={<ProfileForm orgId={facts.id} name={facts.name} monthlyBurnUsd={facts.monthlyBurnUsd} />}
      session={
        <Panel title="This session" level={2}>
          <div className="st-session">
            <p>
              Signed in as <Address value={owner.session.address} what="signed-in address" />. The session ends by itself <Timestamp at={owner.session.expiresAt} show="absolute" />; signing in again takes one signature. Signing out drops the session in this browser and leaves the wallet connected.
            </p>
            <SignOut />
          </div>
        </Panel>
      }
    />
  );
}
