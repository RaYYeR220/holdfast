/**
 * Names and addresses the pages write out that are not the server's to give:
 * what a source is called, and where HyperEVM's explorer keeps a page.
 */

const SOURCE: Record<string, string> = {
  tempo: 'Tempo',
  solana: 'Solana',
  hyperliquid: 'Hyperliquid',
  hyperevm: 'HyperEVM',
  zcash: 'Zcash',
  journal: 'the journal',
  'key format': 'the key’s own format',
  'viewing key': 'the viewing key',
  database: 'the database',
};

/** A source as a reader knows it. One this list does not hold is shown as the server named it. */
export const sourceName = (source: string): string => SOURCE[source] ?? source;

export const HYPEREVM_CHAIN_ID = 999;

/** The explorer page of a HyperEVM transaction or address; null on any chain but HyperEVM mainnet. */
export function hyperEvmUrl(chainId: number, kind: 'tx' | 'address', id: string): string | null {
  return chainId === HYPEREVM_CHAIN_ID ? `https://hyperevmscan.io/${kind}/${id}` : null;
}
