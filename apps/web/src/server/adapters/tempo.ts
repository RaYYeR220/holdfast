import {
  NETWORKS,
  type RailDeps,
  TOKEN_DECIMALS,
  type TempoPayoutRail,
  type TempoRailConfig,
  accessKeyAddressOf,
  createTempoPayoutRail,
  createViemChain,
  explorerTxUrl,
  generateAccessKey,
  resolveConfig,
} from '@holdfast/tempo';
import type { Address, Hex } from 'viem';
import type { TempoSettings } from '../config';
import type { TempoPort } from '../deps';

/**
 * Tempo payouts in one token on one network. Every organisation has its own
 * access key; the sponsor that pays fees is the service's own and is read
 * when the first rail is made. `testing` puts an in-memory chain in the
 * network's place, one per access key.
 */
export function tempoPort(settings: TempoSettings, sponsorPrivateKey: () => Hex, testing?: (accessKey: Address) => RailDeps & Required<Pick<RailDeps, 'chain'>>): TempoPort {
  // One rail per key for the life of the process: a rail sends one transaction at a time on its nonce lane.
  const rails = new Map<Hex, TempoPayoutRail>();

  const configFor = (accessKeyPrivateKey: Hex): TempoRailConfig => ({
    network: settings.network,
    token: settings.token,
    accessKeyPrivateKey,
    sponsorPrivateKey: sponsorPrivateKey(),
    ...(settings.rpcUrl === undefined ? {} : { rpcUrl: settings.rpcUrl }),
  });

  return {
    network: settings.network,
    chainId: NETWORKS[settings.network].chainId,
    token: settings.token,
    tokenSymbol: settings.tokenSymbol,
    decimals: TOKEN_DECIMALS,
    newAccessKey: generateAccessKey,

    rail(accessKeyPrivateKey) {
      let rail = rails.get(accessKeyPrivateKey);
      if (rail === undefined) {
        rail = createTempoPayoutRail(configFor(accessKeyPrivateKey), testing?.(accessKeyAddressOf(accessKeyPrivateKey)));
        rails.set(accessKeyPrivateKey, rail);
      }
      return rail;
    },

    chain: (accessKeyPrivateKey) => testing?.(accessKeyAddressOf(accessKeyPrivateKey)).chain ?? createViemChain(resolveConfig(configFor(accessKeyPrivateKey))),

    txUrl: (hash) => explorerTxUrl(settings.network, hash),
  };
}
