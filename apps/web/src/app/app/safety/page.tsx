import type { Metadata } from 'next';
import { SectionHeading, Unavailable } from '@/ui';
import { OwnerGate } from '../../_lib/OwnerGate';
import { loadOwner } from '../../_lib/owner';
import { AttesterPanel } from '../../_sections/safety/AttesterPanel';
import { ProbePanel } from '../../_sections/safety/ProbePanel';
import { SafetyView } from '../../_sections/safety/SafetyView';
import { loadOwnerSafety } from '../../_sections/safety/load';
import { probeSpecs } from '../../_sections/safety/probes';

export const metadata: Metadata = { title: 'Safety' };

const LEAD = 'Every key the service holds for this treasury, what bounds it, and every time a key was made to exceed its authority.';

/** The owner's Safety page: the same record the demo shows, with the probes and the naming of the attester. */
export default async function AppSafetyPage() {
  const owner = await loadOwner();
  if (owner.status !== 'ok') {
    return (
      <div className="hf-stack">
        <SectionHeading level={1} size="page" title="Safety" lead={LEAD} />
        <OwnerGate owner={owner} what="the keys and their refusals" />
      </div>
    );
  }
  const safety = await loadOwnerSafety(owner.org);
  const now = Date.now();
  if (safety.status !== 'ok') {
    return (
      <div className="hf-stack">
        <SectionHeading level={1} size="page" title="Safety" lead={LEAD} />
        {safety.status === 'missing' ? (
          <Unavailable reason="the organisation could not be found" source="database" at={now} now={now} />
        ) : (
          <Unavailable reason={`${safety.reason}; the keys and the refusals cannot be shown until they can be read again`} source={safety.source} at={safety.at} now={now} />
        )}
      </div>
    );
  }
  const { data, attestor } = safety.value;
  return (
    <SafetyView
      data={data}
      now={now}
      base="/app"
      audience="owner"
      probes={<ProbePanel orgId={owner.org.id} probes={probeSpecs(data)} payoutsHref="/app/payouts" />}
      attester={
        <AttesterPanel
          orgId={owner.org.id}
          account={attestor.account}
          attester={attestor.attester}
          contract={attestor.contract}
          chainId={attestor.chainId}
          registered={attestor.registered.status === 'ok' ? attestor.registered.value.registered : null}
        />
      }
    />
  );
}
