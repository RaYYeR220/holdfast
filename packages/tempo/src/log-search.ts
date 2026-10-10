import { type Address, type Hex, isAddressEqual, pad } from 'viem';
import type { ChainLog } from './chain';
import { TempoRailError } from './config';
import { explainError } from './reasons';
import { TRANSFER_WITH_MEMO_TOPIC } from './tip20';

/**
 * The search that decides whether a run was already paid. "Not found" sends
 * money, so this never returns an answer it cannot vouch for: a range that was
 * not searched in full, a node that had not reached the end of the range, or
 * an answer that looks cut off or does not match the question all reject.
 */

export interface RpcCall {
  method: string;
  params: unknown[];
}

/** Sends the calls as one JSON-RPC batch, so that one node answers all of them, and returns their results in order. */
export type RpcBatch = (calls: readonly RpcCall[]) => Promise<unknown[]>;

export type BlockRange = [from: bigint, to: bigint];

/** Public Tempo RPCs refuse `eth_getLogs` over more blocks than this; the error names the real limit when it differs. */
export const LOG_RANGE = 100_000n;
/** Ranges queried at once. The public RPC starts rate limiting above this. */
const LOG_CONCURRENCY = 4;
/** One sender and at most 32 memos cannot have this many transfers; an answer this long may have been cut at a provider's cap. */
const MOST_LOGS_PER_ANSWER = 1_000;
const ATTEMPTS = 8;
const RETRY_MS = 400;
const REQUEST_TIMEOUT_MS = 20_000;

/** Split `fromBlock..toBlock` into inclusive ranges of at most `span` blocks, newest first. */
export function blockRanges(fromBlock: bigint, toBlock: bigint, span: bigint): BlockRange[] {
  const ranges: BlockRange[] = [];
  for (let to = toBlock; to >= fromBlock; to -= span) {
    ranges.push([to - fromBlock >= span ? to - span + 1n : fromBlock, to]);
  }
  return ranges;
}

/** A JSON-RPC batch over one HTTP request. Any answer that is missing or an error rejects the whole batch. */
export function rpcBatchOver(url: string, fetchFn: typeof fetch = fetch): RpcBatch {
  return async (calls) => {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(calls.map((call, id) => ({ jsonrpc: '2.0', id, method: call.method, params: call.params }))),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw Object.assign(new Error(`the RPC answered HTTP ${response.status}`), { code: response.status });
    const answers: unknown = await response.json();
    if (!Array.isArray(answers) || answers.length !== calls.length) throw new Error('the RPC did not answer the batch call by call');
    return calls.map((call, id) => {
      const answer = answers.find((entry: { id?: unknown } | null) => entry?.id === id) as { result?: unknown; error?: { code?: number; message?: string; data?: unknown } } | undefined;
      if (!answer) throw new Error(`the RPC left ${call.method} unanswered`);
      if (answer.error || !('result' in answer)) {
        throw Object.assign(new Error(answer.error?.message ?? `${call.method} failed`), { code: answer.error?.code, data: answer.error?.data });
      }
      return answer.result;
    });
  };
}

export interface MemoLogSearch {
  rpc: RpcBatch;
  token: Address;
  root: Address;
  memos: readonly Hex[];
  fromBlock: bigint;
  toBlock: bigint;
  sleep: (ms: number) => Promise<void>;
  /** Widest range to ask for; defaults to `LOG_RANGE`. */
  span?: bigint;
}

function rangeLimitOf(error: unknown): bigint | null {
  const match = /max block range (\d+)/i.exec(explainError(error));
  return match?.[1] ? BigInt(match[1]) : null;
}

/** A node that is behind, or a rate limit: asking again shortly can succeed. Everything else is final. */
function worthAskingAgain(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === -32005 || code === 429 || /beyond current head|rate limit|try again|too many requests/i.test(explainError(error));
}

function quantity(value: unknown, what: string): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) throw new TempoRailError(`the RPC returned no usable ${what}`);
  return BigInt(value);
}

/** Take the node's logs only if every one of them is an answer to the question that was asked. */
function readLogs(value: unknown, search: MemoLogSearch, [from, to]: BlockRange): ChainLog[] {
  if (!Array.isArray(value)) throw new TempoRailError('the RPC returned no list of logs');
  if (value.length >= MOST_LOGS_PER_ANSWER) throw new TempoRailError(`the RPC returned ${value.length} logs for one run, which may be a truncated answer`);
  const root = pad(search.root).toLowerCase();
  const memos = new Set(search.memos.map((memo) => memo.toLowerCase()));
  return value.map((entry: Record<string, unknown> | null) => {
    const topics = Array.isArray(entry?.topics) ? (entry.topics as unknown[]).map((topic) => String(topic).toLowerCase() as Hex) : [];
    const blockNumber = quantity(entry?.blockNumber, 'block number for a log');
    const matches =
      entry?.removed !== true &&
      typeof entry?.address === 'string' &&
      isAddressEqual(entry.address as Address, search.token) &&
      topics.length === 4 &&
      topics[0] === TRANSFER_WITH_MEMO_TOPIC &&
      topics[1] === root &&
      memos.has(topics[3] ?? '') &&
      blockNumber >= from &&
      blockNumber <= to &&
      typeof entry.transactionHash === 'string' &&
      /^0x[0-9a-fA-F]{64}$/.test(entry.transactionHash) &&
      typeof entry.data === 'string';
    if (!matches) throw new TempoRailError('the RPC returned a log that is not an answer to the search');
    return {
      address: entry.address as Address,
      topics,
      data: entry.data as Hex,
      logIndex: Number(quantity(entry.logIndex, 'log index')),
      transactionHash: entry.transactionHash as Hex,
      blockNumber,
    };
  });
}

async function searchRange(search: MemoLogSearch, range: BlockRange): Promise<ChainLog[]> {
  const [from, to] = range;
  const filter = {
    address: search.token,
    fromBlock: `0x${from.toString(16)}`,
    toBlock: `0x${to.toString(16)}`,
    topics: [TRANSFER_WITH_MEMO_TOPIC, pad(search.root).toLowerCase(), null, search.memos],
  };
  let last = 'no answer';
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) await search.sleep(RETRY_MS);
    let answers: unknown[];
    try {
      // The head is asked first and in the same request, so it is the head of the node that then searches.
      answers = await search.rpc([
        { method: 'eth_blockNumber', params: [] },
        { method: 'eth_getLogs', params: [filter] },
      ]);
    } catch (error) {
      if (!worthAskingAgain(error)) throw error;
      last = explainError(error);
      continue;
    }
    const nodeHead = quantity(answers[0], 'block number');
    if (nodeHead >= to) return readLogs(answers[1], search, range);
    last = `the answering node is at block ${nodeHead}, behind block ${to}`;
  }
  throw new TempoRailError(`the log search over blocks ${from}..${to} could not be completed: ${last}`);
}

/**
 * Search `fromBlock..toBlock` for the memo transfers. Returns the logs and the
 * range width the RPC turned out to accept, for the next search.
 */
export async function searchMemoLogs(search: MemoLogSearch): Promise<{ logs: ChainLog[]; span: bigint }> {
  let span = search.span ?? LOG_RANGE;
  let ranges = blockRanges(search.fromBlock, search.toBlock, span);
  const newest = ranges[0];
  if (!newest) return { logs: [], span };
  // The newest range goes first and alone: it is where a retried run usually is, and it shows how wide a range the RPC accepts.
  const logs = await searchRange(search, newest).catch((error: unknown) => {
    const limit = rangeLimitOf(error);
    if (limit === null || limit <= 0n || limit >= span) throw error;
    span = limit;
    ranges = blockRanges(search.fromBlock, search.toBlock, span);
    return searchRange(search, ranges[0] ?? newest);
  });
  for (let i = 1; i < ranges.length; i += LOG_CONCURRENCY) {
    const answers = await Promise.all(ranges.slice(i, i + LOG_CONCURRENCY).map((range) => searchRange(search, range)));
    logs.push(...answers.flat());
  }
  return { logs, span };
}
