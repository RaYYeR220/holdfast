import type { Metadata } from 'next';
import { runtime } from '@/server/runtime';
import { SectionHeading, Unavailable } from '@/ui';
import { OwnerGate } from '../../_lib/OwnerGate';
import { loadOwner } from '../../_lib/owner';
import { LockView } from '../../_sections/lock/LockView';
import { loadOwnerLock } from '../../_sections/lock/load';
import { type Search, lockParams } from '../../_sections/lock/params';
import { sourceName } from '../../_sections/overview/OverviewBody';
import { AgentApproval } from './AgentApproval';
import { LockSwitch } from './LockSwitch';
import { PolicyEditor } from './PolicyEditor';

export const metadata: Metadata = { title: 'Lock' };

/** The owner's lock: the same page the demo shows, with the switch, the policy's editor and the agent's approval. */
export default async function AppLockPage({ searchParams }: { searchParams: Promise<Search> }) {
  const owner = await loadOwner();
  if (owner.status !== 'ok') {
    return (
      <div className="hf-stack">
        <SectionHeading level={1} size="page" title="Lock" />
        <OwnerGate owner={owner} what="the lock" />
      </div>
    );
  }

  const params = lockParams(await searchParams);
  const read = await loadOwnerLock(owner.org, params);
  const now = Date.now();
  if (read.status !== 'ok') {
    return (
      <div className="hf-stack">
        <SectionHeading level={1} size="page" title="Lock" />
        <Unavailable reason={`${read.reason}; the lock cannot be shown until it can be read again`} source={sourceName(read.source)} at={read.at} now={now} />
      </div>
    );
  }

  const { data } = read;
  const { lock, overview } = data;
  const approval = lock.agent.approval;
  return (
    <LockView
      base="/app"
      now={now}
      data={data}
      params={params}
      actions={{
        lockSwitch: (
          <LockSwitch
            orgId={data.org.id}
            enabled={lock.lockEnabled}
            facts={{
              policy: lock.policy,
              shortLots: overview.hedge.status === 'ok' ? overview.hedge.value.shortLots : null,
              targetLots: overview.coverage.status === 'ok' ? overview.coverage.value.targetLots : null,
              agentApproved: approval.status === 'ok' ? approval.value.approved : null,
            }}
          />
        ),
        policyEditor: <PolicyEditor orgId={data.org.id} policy={lock.policy} />,
        agentApproval:
          lock.agent.address === null ? undefined : (
            <AgentApproval orgId={data.org.id} agentAddress={lock.agent.address} account={lock.account} network={runtime().network} approved={approval.status === 'ok' ? approval.value.approved : null} />
          ),
      }}
    />
  );
}
