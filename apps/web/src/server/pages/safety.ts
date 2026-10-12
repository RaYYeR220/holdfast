import type { OrgRecord } from '@holdfast/db';
import type { HoldfastNetwork } from '../config';
import type { Deps } from '../deps';
import type { Reading } from '../reading';
import { treasuryAddress } from './settings';

/**
 * What the Safety page needs beside each key's scope: the accounts the keys
 * act on, the tokens the two paying keys are limited in, and the contract the
 * attester records on. Every value is an address or a setting of the
 * deployment, and is public on its own chain.
 */
export interface SafetyFacts {
  network: HoldfastNetwork;
  /** The address the viewing key receives on; the key itself is never shown. */
  treasury: Reading<{ address: string }>;
  /** The organisation's Hyperliquid account, which the agent trades on and the attester records for. */
  hyperliquidAccount: string;
  tempo: {
    network: string;
    /** The organisation's Tempo account; null until its profile names one. */
    account: string | null;
    /** The one token the access key may pay in. */
    token: { address: string; symbol: string; decimals: number };
  };
  solana: {
    cluster: string;
    /** The organisation's wallet; null until its profile names one. */
    owner: string | null;
    token: { address: string; symbol: string; decimals: number };
  };
  /** The HedgeAttestor contract; null where this deployment records no attestations. */
  attestor: { contract: string; chainId: number; everyMinutes: number } | null;
}

export async function safetyFacts(deps: Pick<Deps, 'store' | 'zcash' | 'tempo' | 'solana' | 'attestor' | 'network' | 'now' | 'redact'>, org: OrgRecord): Promise<SafetyFacts> {
  const treasury = await treasuryAddress(deps, org);
  const { attestor } = deps;
  return {
    network: deps.network,
    treasury,
    hyperliquidAccount: org.hlUser,
    tempo: {
      network: deps.tempo.network,
      account: org.tempoAccount,
      token: { address: deps.tempo.token, symbol: deps.tempo.tokenSymbol, decimals: deps.tempo.decimals },
    },
    solana: {
      cluster: deps.solana.cluster,
      owner: org.solanaOwner,
      token: { address: deps.solana.mint, symbol: deps.solana.tokenSymbol, decimals: deps.solana.decimals },
    },
    attestor: attestor === null ? null : { contract: attestor.contract, chainId: attestor.chainId, everyMinutes: Math.round(attestor.everyMs / 60_000) },
  };
}
