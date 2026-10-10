import { describe, expect, it } from 'vitest';
import { ASSETS, OneClickError, createOneClick } from '../src/oneclick';

const NOW = 1_791_635_000_000;

// Trimmed from a live quote: 0.0046 ZEC to USDC on Hyperliquid.
const quoteBody = (over: Record<string, unknown> = {}) => ({
  quote: {
    depositAddress: 't1Rz5oeDUphb5vwrFvUXi9xWtyTTsLGvF6C',
    amountIn: '460000',
    amountInFormatted: '0.0046',
    amountInUsd: '5.638450000000',
    minAmountIn: '460000',
    amountOut: '531775000',
    amountOutFormatted: '5.31775',
    amountOutUsd: '5.316378020500',
    minAmountOut: '526147200',
    timeEstimate: 465,
    deadline: '2026-10-10T13:29:07.896Z',
    ...over,
  },
  signature: 'ed25519:3rrfHLec',
  timestamp: '2026-10-10T12:29:08.340Z',
});

function fakeFetch(status: number, body: unknown, seen: { url?: string; init?: RequestInit } = {}): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    seen.url = String(url);
    if (init !== undefined) seen.init = init;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
}

const request = {
  originAsset: ASSETS.ZEC,
  destinationAsset: ASSETS.USDC_HYPERCORE,
  amount: 460_000n,
  recipient: '0x8ba1f109551bD432803012645Ac136ddd64DBA72',
  refundTo: 't1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs',
  slippageBps: 100,
  validForMs: 3_600_000,
  dry: false,
};

describe('1Click quotes', () => {
  it('maps a quote and measures its cost', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const q = await createOneClick({ fetch: fakeFetch(200, quoteBody(), seen), now: () => NOW }).quote(request);
    expect(q).toEqual({
      depositAddress: 't1Rz5oeDUphb5vwrFvUXi9xWtyTTsLGvF6C',
      amountIn: 460_000n,
      amountOut: 531_775_000n,
      minAmountOut: 526_147_200n,
      amountInUsd: 5.63845,
      amountOutUsd: 5.3163780205,
      costBps: 571,
      etaSeconds: 465,
      deadline: Date.parse('2026-10-10T13:29:07.896Z'),
      signature: 'ed25519:3rrfHLec',
    });
    expect(seen.url).toBe('https://1click.chaindefuser.com/v0/quote');
    expect(JSON.parse(String(seen.init?.body))).toEqual({
      dry: false,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      originAsset: 'nep141:zec.omft.near',
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: '1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054',
      amount: '460000',
      refundTo: 't1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs',
      refundType: 'ORIGIN_CHAIN',
      recipient: '0x8ba1f109551bD432803012645Ac136ddd64DBA72',
      recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(NOW + 3_600_000).toISOString(),
    });
  });

  it('allows a dry quote without a deposit address', async () => {
    const body = quoteBody();
    delete (body.quote as Record<string, unknown>).depositAddress;
    const q = await createOneClick({ fetch: fakeFetch(200, body) }).quote({ ...request, dry: true });
    expect(q.depositAddress).toBeNull();
  });

  it('refuses a real quote that has no deposit address', async () => {
    const body = quoteBody({ depositAddress: '' });
    await expect(createOneClick({ fetch: fakeFetch(200, body) }).quote(request)).rejects.toThrow(/without a deposit address/);
  });

  it('refuses a quote for a different amount than it asked for', async () => {
    const body = quoteBody({ amountIn: '4600000' });
    await expect(createOneClick({ fetch: fakeFetch(200, body) }).quote(request)).rejects.toThrow(/different input amount/);
  });

  it('refuses amounts that are not integers in base units', async () => {
    for (const bad of [{ amountOut: '5.3' }, { minAmountOut: null }, { amountOut: '-1' }, { timeEstimate: 'soon' }]) {
      await expect(createOneClick({ fetch: fakeFetch(200, quoteBody(bad)) }).quote(request)).rejects.toBeInstanceOf(OneClickError);
    }
  });

  it('surfaces the service error message', async () => {
    const api = createOneClick({ fetch: fakeFetch(400, { message: 'recipient is not valid' }) });
    const failure = await api.quote(request).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(OneClickError);
    expect((failure as OneClickError).message).toBe('recipient is not valid');
    expect((failure as OneClickError).status).toBe(400);
  });

  it('reports an unreachable service and a non-JSON answer as errors', async () => {
    const down = (async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;
    await expect(createOneClick({ fetch: down }).quote(request)).rejects.toThrow(/unreachable: socket hang up/);
    await expect(createOneClick({ fetch: fakeFetch(502, '<html>') }).quote(request)).rejects.toThrow(/not JSON/);
  });

  it('validates its own inputs before calling out', async () => {
    const api = createOneClick({
      fetch: (async () => {
        throw new Error('must not be called');
      }) as unknown as typeof fetch,
    });
    await expect(api.quote({ ...request, amount: 0n })).rejects.toThrow(/positive/);
    await expect(api.quote({ ...request, slippageBps: 5_000 })).rejects.toThrow(/slippage/);
  });

  it('sends the partner key when configured', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    await createOneClick({ fetch: fakeFetch(200, quoteBody(), seen), apiKey: 'k-123' }).quote(request);
    expect((seen.init?.headers as Record<string, string>).authorization).toBe('Bearer k-123');
  });
});

describe('1Click swap status', () => {
  const statusBody = (status: string, details: Record<string, unknown> = {}) => ({
    status,
    updatedAt: '2026-10-10T12:40:00.000Z',
    swapDetails: details,
  });

  it('maps a finished swap', async () => {
    const body = statusBody('SUCCESS', {
      amountIn: '460000',
      amountOut: '531775000',
      originChainTxHashes: [{ hash: 'aa11', explorerUrl: 'x' }],
      destinationChainTxHashes: [{ hash: 'bb22', explorerUrl: 'y' }],
    });
    const s = await createOneClick({ fetch: fakeFetch(200, body) }).status('t1Rz5oeDUphb5vwrFvUXi9xWtyTTsLGvF6C');
    expect(s).toEqual({
      state: 'SUCCESS',
      final: true,
      amountIn: 460_000n,
      amountOut: 531_775_000n,
      originTxs: ['aa11'],
      destinationTxs: ['bb22'],
      updatedAt: Date.parse('2026-10-10T12:40:00.000Z'),
    });
  });

  it('knows which states are final', async () => {
    const final = async (state: string) =>
      (await createOneClick({ fetch: fakeFetch(200, statusBody(state)) }).status('t1x')).final;
    expect(await final('PENDING_DEPOSIT')).toBe(false);
    expect(await final('PROCESSING')).toBe(false);
    expect(await final('INCOMPLETE_DEPOSIT')).toBe(false);
    expect(await final('REFUNDED')).toBe(true);
    expect(await final('FAILED')).toBe(true);
  });

  it('does not treat an unfamiliar state as finished', async () => {
    const s = await createOneClick({ fetch: fakeFetch(200, statusBody('KNOWN_DEPOSIT_TX')) }).status('t1x');
    expect(s.state).toBe('UNKNOWN');
    expect(s.final).toBe(false);
    expect(s.amountOut).toBeNull();
  });

  it('raises on an unknown deposit address', async () => {
    const api = createOneClick({ fetch: fakeFetch(404, { message: 'Deposit address t1x not found' }) });
    await expect(api.status('t1x')).rejects.toThrow(/not found/);
  });
});
