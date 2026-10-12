import type { ReactNode } from 'react';
import { shorten } from '../format';
import { OutArrow } from './Link';

export type Chain = 'zcash' | 'hyperliquid' | 'tempo' | 'solana';

export const CHAIN_NAME: Record<Chain, string> = {
  zcash: 'Zcash',
  hyperliquid: 'Hyperliquid',
  tempo: 'Tempo',
  solana: 'Solana',
};

/** The public explorer page of a mainnet transaction on each chain. */
export function explorerTxUrl(chain: Chain, id: string): string {
  switch (chain) {
    case 'zcash':
      return `https://mainnet.zcashexplorer.app/transactions/${id}`;
    case 'hyperliquid':
      return `https://app.hyperliquid.xyz/explorer/tx/${id}`;
    case 'tempo':
      return `https://explore.tempo.xyz/tx/${id}`;
    case 'solana':
      return `https://solscan.io/tx/${id}`;
  }
}

/** The public explorer page of a Hyperliquid account. */
export function hyperliquidAccountUrl(address: string): string {
  return `https://app.hyperliquid.xyz/explorer/address/${address}`;
}

export interface ExternalTxLinkProps {
  chain: Chain;
  /** The transaction id, hash or signature, whole. */
  id: string;
  /** Use this address instead of the explorer's page for `id`: the server sometimes knows a better one. */
  href?: string;
  /** Show the chain's name before the id. On by default. */
  showChain?: boolean;
  /** Replaces the shortened id as the visible text. */
  children?: ReactNode;
  className?: string;
}

/**
 * A link to a transaction on its chain's explorer: the chain's name, the two
 * ends of the id in the numeric face, and the arrow of a link that leaves the
 * application. It opens in a new tab.
 */
export function ExternalTxLink({ chain, id, href, showChain = true, children, className }: ExternalTxLinkProps) {
  return (
    <a
      className={`hf-txlink${className === undefined ? '' : ` ${className}`}`}
      href={href ?? explorerTxUrl(chain, id)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${CHAIN_NAME[chain]} transaction ${shorten(id)} on the explorer (opens in a new tab)`}
      title={id}
    >
      {showChain && <span className="hf-txlink__chain">{CHAIN_NAME[chain]}</span>}
      <span className="hf-txlink__id">{children ?? shorten(id)}</span>
      <OutArrow />
    </a>
  );
}
