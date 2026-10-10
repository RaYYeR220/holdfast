import type { Address, Chain } from 'viem';
import { tempo, tempoModerato } from 'viem/chains';

export type TempoNetwork = 'mainnet' | 'moderato';

export interface NetworkInfo {
  chainId: number;
  explorer: string;
  testnet: boolean;
}

export const NETWORKS: Record<TempoNetwork, NetworkInfo> = {
  mainnet: { chainId: 4217, explorer: 'https://explore.tempo.xyz', testnet: false },
  moderato: { chainId: 42431, explorer: 'https://explore.testnet.tempo.xyz', testnet: true },
};

/** Every TIP-20 stablecoin uses six decimals. */
export const TOKEN_DECIMALS = 6;

/**
 * Stablecoins a payout can be made in. `USDCe` is the token shown as USDC.e;
 * it lives at a different address on each network.
 */
export const TOKENS = {
  mainnet: {
    pathUSD: '0x20c0000000000000000000000000000000000000',
    USDCe: '0x20c000000000000000000000b9537d11c60e8b50',
    OUSD: '0x20c0000000000000000000006a37da5c996874be',
  },
  moderato: {
    pathUSD: '0x20c0000000000000000000000000000000000000',
    AlphaUSD: '0x20c0000000000000000000000000000000000001',
    BetaUSD: '0x20c0000000000000000000000000000000000002',
    ThetaUSD: '0x20c0000000000000000000000000000000000003',
    USDCe: '0x20c0000000000000000000009e8d7eb59b783726',
    OUSD: '0x20c0000000000000000000006a37da5c996874be',
  },
} as const satisfies Record<TempoNetwork, Record<string, Address>>;

/** The viem chain for a network. Always passed explicitly: the SDK's own default is mainnet. */
export function chainOf(network: TempoNetwork): Chain {
  return network === 'mainnet' ? tempo : tempoModerato;
}

export function explorerTxUrl(network: TempoNetwork, hash: string): string {
  return `${NETWORKS[network].explorer}/tx/${hash}`;
}

export function explorerAddressUrl(network: TempoNetwork, address: string): string {
  return `${NETWORKS[network].explorer}/address/${address}`;
}
