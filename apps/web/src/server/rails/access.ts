import type { OrgRecord } from '@holdfast/db';
import type { TempoPayoutRail } from '@holdfast/tempo';
import type { Hex } from 'viem';
import type { Deps, SolanaRail } from '../deps';
import { refused } from '../errors';

/**
 * The payout rails of one organisation: each signs with that organisation's
 * own service key and pays from the account its profile names. An
 * organisation that lacks either cannot use the rail yet, and is told which.
 */

export interface TempoAccess {
  rail: TempoPayoutRail;
  /** The organisation's Tempo account, whose root authorizes the access key. */
  account: string;
  accessKey: string;
  accessKeyPrivateKey: Hex;
}

export interface SolanaAccess {
  rail: SolanaRail;
  /** The organisation's wallet, which approves the delegate. */
  owner: string;
  delegate: string;
}

export async function tempoAccess(deps: Pick<Deps, 'store' | 'tempo'>, org: OrgRecord): Promise<TempoAccess> {
  if (org.tempoAccount === null) throw refused('the organisation has no Tempo account yet; set one in its profile first');
  const key = await deps.store.activeKey(org.id, 'tempo_access');
  if (key === null) throw refused('the organisation has no Tempo access key');
  const accessKeyPrivateKey = key.secret as Hex;
  return { rail: deps.tempo.rail(accessKeyPrivateKey), account: org.tempoAccount, accessKey: key.address, accessKeyPrivateKey };
}

export async function solanaAccess(deps: Pick<Deps, 'store' | 'solana'>, org: OrgRecord): Promise<SolanaAccess> {
  if (org.solanaOwner === null) throw refused('the organisation has no Solana wallet yet; set one in its profile first');
  const key = await deps.store.activeKey(org.id, 'solana_delegate');
  if (key === null) throw refused('the organisation has no Solana service key');
  // Runs paid under an earlier service key are marked under that key; the rail has to know it to recognise them.
  const earlier = (await deps.store.listKeys(org.id)).filter((k) => k.kind === 'solana_delegate' && k.status === 'revoked').map((k) => k.address);
  return { rail: deps.solana.rail(key.secret, earlier), owner: org.solanaOwner, delegate: key.address };
}
