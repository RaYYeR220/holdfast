/**
 * What the address of a Lock page can ask for beside the page itself: an
 * older page of the journal, and the proof of one entry under one snapshot.
 * Both are read out of the query string on the server, so that the journal
 * pages and the proof are ordinary links and work without a script.
 *
 *   ?before=120            the journal from entry 119 down
 *   ?check=2               the proof of entry 2 under the latest snapshot
 *   ?check=2&snapshot=0.1  the same under snapshot 1 of series 0
 */

export interface SnapshotRef {
  series: bigint;
  number: bigint;
}

export interface LockParams {
  /** Show journal entries before this one; null for the newest page. */
  before: number | null;
  /** The journal entry whose proof is asked for; null when none is. */
  check: number | null;
  /** The snapshot to prove it under; null for the latest one. */
  snapshot: SnapshotRef | null;
}

export type Search = Record<string, string | string[] | undefined>;

const MAX_SEQ = 2_147_483_647;
const COUNTER = /^(0|[1-9]\d{0,19})$/;

const single = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

function seqOf(text: string | undefined): number | null {
  if (text === undefined || !/^[1-9]\d{0,9}$/.test(text)) return null;
  const seq = Number(text);
  return seq <= MAX_SEQ ? seq : null;
}

/** `series.number`, both counted from zero, as the contract counts them. */
export function parseSnapshot(text: string | undefined): SnapshotRef | null {
  if (text === undefined) return null;
  const [series, number, ...rest] = text.split('.');
  if (series === undefined || number === undefined || rest.length > 0 || !COUNTER.test(series) || !COUNTER.test(number)) return null;
  return { series: BigInt(series), number: BigInt(number) };
}

export const snapshotText = (snapshot: { series: bigint | string; number: bigint | string }): string => `${snapshot.series}.${snapshot.number}`;

/** The query of a Lock page. Anything that is not what it should be is treated as absent. */
export function lockParams(search: Search): LockParams {
  return { before: seqOf(single(search.before)), check: seqOf(single(search.check)), snapshot: parseSnapshot(single(search.snapshot)) };
}

/** The address of a Lock page with these parameters, and the part of the page to arrive at. */
export function lockHref(base: string, params: Partial<LockParams>, anchor?: string): string {
  const query: string[] = [];
  if (params.before !== undefined && params.before !== null) query.push(`before=${params.before}`);
  if (params.check !== undefined && params.check !== null) query.push(`check=${params.check}`);
  if (params.snapshot !== undefined && params.snapshot !== null) query.push(`snapshot=${snapshotText(params.snapshot)}`);
  return `${base}/lock${query.length === 0 ? '' : `?${query.join('&')}`}${anchor === undefined ? '' : `#${anchor}`}`;
}

/** Public RPC endpoints of the chains the contract is deployed on, for the call a reader makes themselves. */
const RPC: Record<number, string> = { 999: 'https://rpc.hyperliquid.xyz/evm' };

export interface ProofCall {
  contract: string;
  chainId: number;
  account: string;
  series: bigint | string;
  number: bigint | string;
  leaf: string;
  proof: readonly string[];
}

/**
 * The `cast call` that asks the contract the same question the page asked:
 * whether this leaf, with this proof, is under the journal root of this
 * snapshot. It answers `true` or `false` and sends nothing.
 */
export function castCall(call: ProofCall): string {
  const rpc = RPC[call.chainId] ?? `<an RPC endpoint of chain ${call.chainId}>`;
  return [
    `cast call ${call.contract} \\`,
    '  "verifyEntry(address,uint256,uint256,bytes32,bytes32[])(bool)" \\',
    `  ${call.account} ${call.series} ${call.number} \\`,
    `  ${call.leaf} \\`,
    `  "[${call.proof.join(',')}]" \\`,
    `  --rpc-url ${rpc}`,
  ].join('\n');
}

/** The explorer page of a HyperEVM transaction; null for a chain with no explorer known here. */
export function hyperEvmTxUrl(chainId: number, tx: string): string | null {
  return chainId === 999 ? `https://hyperevmscan.io/tx/${tx}` : null;
}

/** The explorer page of a HyperEVM address; null for a chain with no explorer known here. */
export function hyperEvmAddressUrl(chainId: number, address: string): string | null {
  return chainId === 999 ? `https://hyperevmscan.io/address/${address.toLowerCase()}` : null;
}
