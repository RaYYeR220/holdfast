import type { Metadata } from 'next';
import { SectionHeading, Unavailable } from '@/ui';
import { OwnerGate } from '../../_lib/OwnerGate';
import { loadOwner } from '../../_lib/owner';
import { sourceName } from '../../_sections/overview/OverviewBody';
import { TreasuryView } from '../../_sections/treasury/TreasuryView';
import { loadOwnerTreasury } from '../../_sections/treasury/load';
import { FundingPanel } from './FundingPanel';

export const metadata: Metadata = { title: 'Treasury' };

/** The owner's treasury: what the viewing key shows, and funding from it. */
export default async function AppTreasuryPage() {
  const owner = await loadOwner();
  if (owner.status !== 'ok') {
    return (
      <div className="hf-stack">
        <SectionHeading level={1} size="page" title="Treasury" />
        <OwnerGate owner={owner} what="the treasury" />
      </div>
    );
  }

  const read = await loadOwnerTreasury(owner.org);
  const now = Date.now();
  if (read.status !== 'ok') {
    return (
      <div className="hf-stack">
        <SectionHeading level={1} size="page" title="Treasury" />
        <Unavailable reason={`${read.reason}; the treasury cannot be shown until it can be read again`} source={sourceName(read.source)} at={read.at} now={now} />
      </div>
    );
  }
  const { data } = read;
  return <TreasuryView base="/app" now={now} data={data} funding={<FundingPanel orgId={data.org.id} hasSolanaWallet={data.org.hasSolanaWallet} mainnet={data.treasury.network === 'mainnet'} />} />;
}
