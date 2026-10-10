import { type Hex, pad } from 'viem';
import { describe, expect, it } from 'vitest';
import { type RpcCall, TRANSFER_WITH_MEMO_TOPIC, memoBytes, rpcBatchOver, runMemos, searchMemoLogs } from '../src/index';
import { OUTSIDER, PAYEES, ROOT, TOKEN } from './fake-chain';

const RUN = 'HF-2026-10-0001';
const memos = runMemos(RUN).map(memoBytes);
const TX = `0x${'ab'.repeat(32)}` as Hex;
const hex = (n: bigint | number) => `0x${n.toString(16)}`;
const topic = (address: string) => pad(address as Hex).toLowerCase();

function log(block: bigint, line: number, over: Record<string, unknown> = {}) {
  return {
    address: TOKEN,
    topics: [TRANSFER_WITH_MEMO_TOPIC, topic(ROOT), topic(PAYEES[0]), memoBytes(`${RUN}/${line}`)],
    data: `0x${'00'.repeat(31)}01`,
    blockNumber: hex(block),
    transactionHash: TX,
    logIndex: hex(line),
    removed: false,
    ...over,
  };
}

interface Filter {
  fromBlock: string;
  toBlock: string;
  topics: unknown[];
  address: string;
}

/** A node at block `head` that holds `logs`, speaking JSON-RPC batches. */
function node(head: bigint, logs: ReturnType<typeof log>[] = []) {
  const state = { head, batches: [] as RpcCall[][], answer: null as null | ((filter: Filter, attempt: number) => unknown) };
  const rpc = async (calls: readonly RpcCall[]) => {
    state.batches.push([...calls]);
    return calls.map((call) => {
      if (call.method === 'eth_blockNumber') return hex(state.head);
      const filter = call.params[0] as Filter;
      if (state.answer) {
        const answer = state.answer(filter, state.batches.length);
        if (answer instanceof Error) throw answer;
        if (answer !== undefined) return answer;
      }
      return logs.filter((entry) => BigInt(entry.blockNumber) >= BigInt(filter.fromBlock) && BigInt(entry.blockNumber) <= BigInt(filter.toBlock));
    });
  };
  return { state, rpc };
}

const search = (rpc: ReturnType<typeof node>['rpc'], over: Partial<Parameters<typeof searchMemoLogs>[0]> = {}) =>
  searchMemoLogs({ rpc, token: TOKEN, root: ROOT, memos, fromBlock: 1_000_000n, toBlock: 1_250_000n, sleep: async () => undefined, ...over });

describe('searching for an earlier payment', () => {
  it('asks for the node head and the logs in one batch, with the sender and every memo of the run as topics', async () => {
    const { state, rpc } = node(1_250_000n);
    await search(rpc);
    for (const batch of state.batches) expect(batch.map((call) => call.method)).toEqual(['eth_blockNumber', 'eth_getLogs']);
    const filter = state.batches[0]?.[1]?.params[0] as Filter;
    expect(filter.address).toBe(TOKEN);
    expect(filter.topics).toEqual([TRANSFER_WITH_MEMO_TOPIC, topic(ROOT), null, memos]);
    expect(memos).toHaveLength(32);
  });

  it('covers the whole range without gaps, newest first', async () => {
    const { state, rpc } = node(1_250_000n);
    await search(rpc);
    const ranges = state.batches.map((batch) => batch[1]?.params[0] as Filter).map((filter) => [BigInt(filter.fromBlock), BigInt(filter.toBlock)]);
    expect(ranges).toEqual([
      [1_150_001n, 1_250_000n],
      [1_050_001n, 1_150_000n],
      [1_000_000n, 1_050_000n],
    ]);
  });

  it('returns the logs of every part of the range', async () => {
    const { rpc } = node(1_250_000n, [log(1_249_999n, 1), log(1_100_000n, 2), log(1_000_000n, 3)]);
    const found = await search(rpc);
    expect(found.logs.map((entry) => [entry.blockNumber, entry.logIndex])).toEqual([
      [1_249_999n, 1],
      [1_100_000n, 2],
      [1_000_000n, 3],
    ]);
    expect(found.logs[0]).toMatchObject({ address: TOKEN, transactionHash: TX, topics: [TRANSFER_WITH_MEMO_TOPIC, topic(ROOT), topic(PAYEES[0]), memoBytes(`${RUN}/1`)] });
  });

  it('answers "nothing" only when every part of the range was searched', async () => {
    const { state, rpc } = node(1_250_000n);
    expect((await search(rpc)).logs).toEqual([]);
    expect(state.batches).toHaveLength(3);
  });

  it('does not take an answer from a node that has not reached the end of the range', async () => {
    const { state, rpc } = node(1_249_990n, [log(1_249_995n, 1)]);
    // The node is ten blocks behind: it cannot know about the payment in block 1,249,995.
    await expect(search(rpc)).rejects.toThrow('the log search over blocks 1150001..1250000 could not be completed: the answering node is at block 1249990, behind block 1250000');
    expect(state.batches.length).toBeGreaterThan(1);
  });

  it('waits for a node that is briefly behind and then takes its answer', async () => {
    const { state, rpc } = node(1_249_999n, [log(1_250_000n, 1)]);
    let naps = 0;
    const found = await search(rpc, {
      sleep: async () => {
        naps += 1;
        state.head = 1_250_000n;
      },
    });
    expect(naps).toBe(1);
    expect(found.logs).toHaveLength(1);
  });

  it('asks again when the node itself says the range runs past its head, or limits the rate', async () => {
    for (const error of [
      Object.assign(new Error('block range extends beyond current head block: requested 1250000, head 1249998'), { code: -32602 }),
      Object.assign(new Error('rate limited, try again in 44ms'), { code: -32005 }),
    ]) {
      const { state, rpc } = node(1_250_000n, [log(1_200_000n, 1)]);
      state.answer = (_filter, attempt) => (attempt === 1 ? error : undefined);
      expect((await search(rpc)).logs).toHaveLength(1);
    }
    const { state, rpc } = node(1_250_000n);
    state.answer = () => Object.assign(new Error('rate limited, try again in 44ms'), { code: -32005 });
    await expect(search(rpc)).rejects.toThrow('could not be completed: rate limited');
  });

  it('fails as a whole when any part of the range fails', async () => {
    const { state, rpc } = node(1_250_000n, [log(1_249_999n, 1)]);
    state.answer = (filter) => (BigInt(filter.toBlock) === 1_050_000n ? new Error('fetch failed') : undefined);
    await expect(search(rpc)).rejects.toThrow('fetch failed');
  });

  it('fails when the node cannot be reached at all', async () => {
    await expect(
      search(async () => {
        throw new Error('fetch failed');
      }),
    ).rejects.toThrow('fetch failed');
  });

  it('adopts the range limit the RPC names and still covers everything', async () => {
    const { state, rpc } = node(1_250_000n, [log(1_000_500n, 1)]);
    state.answer = (filter) => (BigInt(filter.toBlock) - BigInt(filter.fromBlock) + 1n > 50_000n ? Object.assign(new Error('query exceeds max block range 50000'), { code: -32602 }) : undefined);
    const found = await search(rpc);
    expect(found.span).toBe(50_000n);
    expect(found.logs).toHaveLength(1);
    const asked = state.batches.map((batch) => batch[1]?.params[0] as Filter).filter((filter) => BigInt(filter.toBlock) - BigInt(filter.fromBlock) + 1n <= 50_000n);
    expect(asked.reduce((sum, filter) => sum + (BigInt(filter.toBlock) - BigInt(filter.fromBlock) + 1n), 0n)).toBe(250_001n);
  });

  it('refuses an answer that looks cut off', async () => {
    const { state, rpc } = node(1_250_000n);
    state.answer = () => Array.from({ length: 1_000 }, (_, i) => log(1_200_000n, (i % 32) + 1));
    await expect(search(rpc)).rejects.toThrow('1000 logs for one run, which may be a truncated answer');
  });

  it('refuses logs that are not an answer to the question', async () => {
    const wrong: [string, Record<string, unknown>][] = [
      ['a block outside the range', { blockNumber: hex(999_999n) }],
      ['another sender', { topics: [TRANSFER_WITH_MEMO_TOPIC, topic(OUTSIDER), topic(PAYEES[0]), memoBytes(`${RUN}/1`)] }],
      ['another memo', { topics: [TRANSFER_WITH_MEMO_TOPIC, topic(ROOT), topic(PAYEES[0]), memoBytes('HF-2026-10-0002/1')] }],
      ['another event', { topics: [`0x${'dd'.repeat(32)}`, topic(ROOT), topic(PAYEES[0]), memoBytes(`${RUN}/1`)] }],
      ['another token', { address: OUTSIDER }],
      ['a log of a block that was dropped', { removed: true }],
      ['no transaction hash', { transactionHash: null }],
      ['no log index', { logIndex: null }],
    ];
    for (const [label, over] of wrong) {
      const { state, rpc } = node(1_250_000n);
      state.answer = () => [log(1_200_000n, 1, over)];
      await expect(search(rpc), label).rejects.toThrow(/the RPC returned/);
    }
    const { state, rpc } = node(1_250_000n);
    state.answer = () => ({ logs: [] });
    await expect(search(rpc)).rejects.toThrow('the RPC returned no list of logs');
  });

  it('refuses a head it cannot read', async () => {
    await expect(search(async () => [null, []])).rejects.toThrow('the RPC returned no usable block number');
  });
});

describe('a JSON-RPC batch over HTTP', () => {
  const calls = [
    { method: 'eth_blockNumber', params: [] },
    { method: 'eth_getLogs', params: [{ fromBlock: '0x1', toBlock: '0x2' }] },
  ];
  const answering = (status: number, body: unknown, seen: { requests: unknown[] } = { requests: [] }) =>
    (async (_url: unknown, init?: RequestInit) => {
      seen.requests.push(JSON.parse(String(init?.body)));
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }) as typeof fetch;

  it('sends every call in one request and returns the results in the order asked', async () => {
    const seen = { requests: [] as unknown[] };
    // Answered out of order, as a node may.
    const fetchFn = answering(200, [{ jsonrpc: '2.0', id: 1, result: [] }, { jsonrpc: '2.0', id: 0, result: '0x10' }], seen);
    expect(await rpcBatchOver('https://rpc.example', fetchFn)(calls)).toEqual(['0x10', []]);
    expect(seen.requests).toEqual([
      [
        { jsonrpc: '2.0', id: 0, method: 'eth_blockNumber', params: [] },
        { jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ fromBlock: '0x1', toBlock: '0x2' }] },
      ],
    ]);
  });

  it('rejects the whole batch when one call fails, is missing, or the transport fails', async () => {
    const batch = (status: number, body: unknown) => rpcBatchOver('https://rpc.example', answering(status, body))(calls);
    await expect(batch(200, [{ id: 0, result: '0x10' }, { id: 1, error: { code: -32602, message: 'query exceeds max block range 100000' } }])).rejects.toMatchObject({ message: 'query exceeds max block range 100000', code: -32602 });
    await expect(batch(200, [{ id: 0, result: '0x10' }])).rejects.toThrow('did not answer the batch call by call');
    await expect(batch(200, [{ id: 0, result: '0x10' }, { id: 7, result: [] }])).rejects.toThrow('left eth_getLogs unanswered');
    await expect(batch(200, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batches are not supported' } })).rejects.toThrow('did not answer the batch call by call');
    await expect(batch(429, 'slow down')).rejects.toMatchObject({ message: 'the RPC answered HTTP 429', code: 429 });
    await expect(batch(200, [{ id: 0 }, { id: 1, result: [] }])).rejects.toThrow('eth_blockNumber failed');
    const down = (async () => {
      throw new Error('fetch failed');
    }) as typeof fetch;
    await expect(rpcBatchOver('https://rpc.example', down)(calls)).rejects.toThrow('fetch failed');
  });
});
