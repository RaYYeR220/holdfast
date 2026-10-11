import type { Proof } from './entry';

/** Transaction page of each chain's explorer; `{tx}` stands for the transaction id. */
export type ExplorerTemplates = Readonly<Record<string, string>>;

export const DEFAULT_EXPLORERS: ExplorerTemplates = {
  zcash: 'https://mainnet.zcashexplorer.app/transactions/{tx}',
  hyperliquid: 'https://app.hyperliquid.xyz/explorer/tx/{tx}',
  tempo: 'https://explore.tempo.xyz/tx/{tx}',
  solana: 'https://explorer.solana.com/tx/{tx}',
  base: 'https://basescan.org/tx/{tx}',
  arbitrum: 'https://arbiscan.io/tx/{tx}',
};

export function proofOf(chain: string, tx: string | null, block: number | null, explorers: ExplorerTemplates): Proof {
  const template = Object.hasOwn(explorers, chain) ? explorers[chain] : undefined;
  const url = tx === null || tx === '' || template === undefined ? null : template.replace('{tx}', encodeURIComponent(tx));
  return { chain, tx: tx === '' ? null : tx, block, url };
}
