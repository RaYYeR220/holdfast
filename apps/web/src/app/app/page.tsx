import type { Metadata } from 'next';
import { runtime } from '@/server/runtime';
import { SectionHeading, Unavailable } from '@/ui';
import { OwnerGate } from '../_lib/OwnerGate';
import { loadOwner } from '../_lib/owner';
import { OwnerOverviewView } from '../_sections/entry/OwnerOverviewView';
import '../_sections/entry/entry.css';
import { loadOwnerOverview } from '../_sections/entry/load';
import { sourceName } from '../_sections/overview/OverviewBody';
import { Register } from './_entry/Register';
import { SignIn } from './_entry/SignIn';

export const metadata: Metadata = { title: 'Overview' };

/**
 * The way into the application. Nobody signed in: connect a wallet and sign
 * in. Signed in with no organisation: register one. Signed in with one: the
 * owner's overview.
 */
export default async function AppPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const owner = await loadOwner();

  if (owner.status === 'unavailable') {
    return (
      <div className="hf-stack">
        <SectionHeading level={1} size="page" title="Overview" />
        <OwnerGate owner={owner} what="your treasury" />
      </div>
    );
  }

  if (owner.status === 'out') {
    return (
      <div className="hf-stack">
        <SectionHeading level={1} size="page" title="Sign in" lead="The treasurer signs in with the wallet of the team’s Hyperliquid account. Signing in proves you hold that address; it moves nothing and approves nothing." />
        <SignIn />
      </div>
    );
  }

  if (owner.status === 'none') {
    return (
      <div className="hf-stack">
        <SectionHeading level={1} size="page" title="Register" lead="No treasury is registered to this address yet. Registering takes a name and the treasury’s viewing key, which can read the treasury and cannot spend from it." />
        <Register address={owner.session.address} network={runtime().network} />
      </div>
    );
  }

  const read = await loadOwnerOverview(owner.org);
  const now = Date.now();
  if (read.status !== 'ok') {
    return (
      <div className="hf-stack">
        <SectionHeading level={1} size="page" title="Overview" />
        <Unavailable reason={`${read.reason}; the overview cannot be shown until it can be read again`} source={sourceName(read.source)} at={read.at} now={now} />
      </div>
    );
  }
  return <OwnerOverviewView data={read.data} policy={owner.org.policy} now={now} justRegistered={(await searchParams).registered !== undefined} />;
}
