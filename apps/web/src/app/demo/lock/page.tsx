import type { Metadata } from 'next';
import { SectionHeading, Unavailable } from '@/ui';
import { LockView } from '../../_sections/lock/LockView';
import { loadDemoLock } from '../../_sections/lock/load';
import { type Search, lockParams } from '../../_sections/lock/params';
import { sourceName } from '../../_sections/overview/OverviewBody';

export const metadata: Metadata = { title: 'Lock' };

/** The lock of the public demo treasury: read only, no sign-in. */
export default async function DemoLockPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = lockParams(await searchParams);
  const read = await loadDemoLock(params);
  const now = Date.now();

  if (read.status !== 'ok') {
    return (
      <div className="hf-stack">
        <SectionHeading level={1} size="page" title="Lock" lead="The hedge of the demo treasury, the policy it runs under and the controller’s journal." />
        <Unavailable reason={`${read.reason}; the lock cannot be shown until the demo treasury can be read again`} source={sourceName(read.source)} at={read.at} now={now} />
      </div>
    );
  }
  return <LockView base="/demo" now={now} data={read.data} params={params} />;
}
