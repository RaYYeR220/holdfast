import { Link, Notice, Unavailable } from '@/ui';
import type { OwnerRead } from './owner';

export interface OwnerGateProps {
  /** Any state but `ok`: the page renders this in place of its content. */
  owner: Exclude<OwnerRead, { status: 'ok' }>;
  /** What the page would show, as it reads in a sentence: "the payouts", "the books". */
  what: string;
}

/**
 * What a page under /app shows when there is no organisation to show it for:
 * nobody is signed in, the address has not registered a treasury, or the
 * session or the database could not be read. Signing in and registering both
 * happen on /app itself, so that is where it points.
 */
export function OwnerGate({ owner, what }: OwnerGateProps) {
  if (owner.status === 'unavailable') {
    return <Unavailable reason={`${owner.reason}; ${what} cannot be shown until it can be read again`} source={owner.source} at={owner.at} />;
  }
  if (owner.status === 'out') {
    return (
      <Notice kind="info" title="Sign in to see this">
        Only the owner of a treasury can open {what}. <Link href="/app">Sign in with the wallet of the team&apos;s Hyperliquid account</Link>, or read the same pages of the <Link href="/demo">public demo treasury</Link> without signing in.
      </Notice>
    );
  }
  return (
    <Notice kind="info" title="No treasury is registered to this address yet">
      There is nothing to show for {what} until one is. <Link href="/app">Register the treasury</Link>: it takes a name and the treasury&apos;s viewing key.
    </Notice>
  );
}
