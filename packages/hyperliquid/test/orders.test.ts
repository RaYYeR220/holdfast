import type { OrderRequest } from '@holdfast/core';
import { describe, expect, it } from 'vitest';
import { cloidFor, createHedgeVenue, generateAgentKey } from '../src/index';
import filledOrder from './fixtures/orderStatus-filled.json';
import filledOrderFills from './fixtures/orderStatus-filled-fills.json';
import rejectedOrder from './fixtures/orderStatus-rejected.json';
import { type Body, clone, fakeHyperliquid, fixtures, json, text, ZEC_ASSET } from './support';

const NOW = 1_791_636_000_000;
const USER = '0x54ba65bcbfaa7f2c3c53e41e8092159f351ec5e5';
const agent = generateAgentKey();

type Handler = (body: Body) => unknown;

function setup(exchange: Handler, info: Record<string, Handler> = {}) {
  const server = fakeHyperliquid({
    info: {
      metaAndAssetCtxs: () => fixtures.market,
      userRole: () => ({ role: 'agent', data: { user: USER } }),
      orderStatus: () => ({ status: 'unknownOid' }),
      userFillsByTime: () => [],
      ...info,
    },
    exchange,
  });
  let clock = NOW;
  const venue = createHedgeVenue({
    network: 'mainnet',
    agentPrivateKey: agent.privateKey,
    fetch: server.fetch,
    now: () => clock,
  });
  return {
    venue,
    server,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function order(overrides: Partial<OrderRequest> = {}): OrderRequest {
  return {
    user: USER,
    side: 'sell',
    lots: 5,
    limitPx: 1223.9,
    reduceOnly: false,
    cloid: cloidFor('org_1', 100, 0),
    ...overrides,
  };
}

/** The envelope Hyperliquid wraps a single order status in. */
const orderReply = (status: unknown) => ({ status: 'ok', response: { type: 'order', data: { statuses: [status] } } });
const filled = (totalSz: string, avgPx: string, oid = 77_747_314) => orderReply({ filled: { totalSz, avgPx, oid } });

describe('place: what is sent', () => {
  it('sends one IOC limit order signed by the agent', async () => {
    const { venue, server } = setup(() => filled('0.05', '1224.1'));
    const cloid = cloidFor('org_1', 100, 0);
    await venue.place(order({ cloid }));

    const [call] = server.sent('exchange');
    expect(call?.url).toBe('https://api.hyperliquid.xyz/exchange');
    expect(Object.keys(call?.body ?? {})).toEqual(['action', 'nonce', 'signature']);
    expect(call?.body.nonce).toBe(NOW);
    expect(call?.body.signature).toEqual({
      r: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      s: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      v: expect.toBeOneOf([27, 28]),
    });
    // Compared as text: the key order is part of what the signature covers.
    expect(JSON.stringify(call?.body.action)).toBe(
      JSON.stringify({
        type: 'order',
        orders: [{ a: ZEC_ASSET, b: false, p: '1223.9', s: '0.05', r: false, t: { limit: { tif: 'Ioc' } }, c: cloid }],
        grouping: 'na',
      }),
    );
  });

  it('sells to grow the short and buys, reduce-only, to cut it', async () => {
    const { venue, server } = setup(() => filled('0.05', '1224.1'));
    await venue.place(order({ side: 'sell', reduceOnly: false, cloid: cloidFor('o', 1, 0) }));
    await venue.place(order({ side: 'buy', reduceOnly: true, cloid: cloidFor('o', 1, 1) }));
    const [sell, buy] = server.sent('exchange').map((call) => call.body.action.orders[0]);
    expect(sell).toMatchObject({ b: false, r: false });
    expect(buy).toMatchObject({ b: true, r: true });
  });

  it('writes sizes and prices the way Hyperliquid hashes them, without trailing zeros', async () => {
    const { venue, server } = setup(() => filled('0.01', '1'));
    const cases: [lots: number, limitPx: number, s: string, p: string][] = [
      [1, 1223.9, '0.01', '1223.9'],
      [10, 1200, '0.1', '1200'],
      [100, 98.765, '1', '98.765'],
      [150, 0.1234, '1.5', '0.1234'],
      [12_345, 123_456, '123.45', '123456'],
    ];
    for (const [index, [lots, limitPx]] of cases.entries()) {
      await venue.place(order({ lots, limitPx, cloid: cloidFor('sizes', 1, index) }));
    }
    const sent = server.sent('exchange').map((call) => [call.body.action.orders[0].s, call.body.action.orders[0].p]);
    expect(sent).toEqual(cases.map(([, , s, p]) => [s, p]));
  });

  it('lowercases the cloid', async () => {
    const { venue, server } = setup(() => filled('0.05', '1224.1'));
    await venue.place(order({ cloid: '0xABCDEF0123456789ABCDEF0123456789' }));
    expect(server.sent('exchange')[0]?.body.action.orders[0].c).toBe('0xabcdef0123456789abcdef0123456789');
    expect(server.sent('info', 'orderStatus')[0]?.body.oid).toBe('0xabcdef0123456789abcdef0123456789');
  });

  it('checks the market, the agent and the cloid before sending, then remembers the first two', async () => {
    const { venue, server } = setup(() => filled('0.05', '1224.1'));
    const first = cloidFor('org_1', 1, 0);
    const second = cloidFor('org_1', 2, 0);
    await venue.place(order({ cloid: first }));
    expect(server.calls.map((call) => call.body.type ?? call.endpoint)).toEqual([
      'metaAndAssetCtxs',
      'userRole',
      'orderStatus',
      'exchange',
    ]);
    expect(server.sent('info', 'userRole')[0]?.body).toEqual({ type: 'userRole', user: agent.address });
    expect(server.sent('info', 'orderStatus')[0]?.body).toEqual({ type: 'orderStatus', user: USER, oid: first });

    await venue.place(order({ cloid: second }));
    expect(server.calls.slice(4).map((call) => call.body.type ?? call.endpoint)).toEqual(['orderStatus', 'exchange']);
  });

  it('never repeats a nonce, even when the clock stands still or steps back', async () => {
    const { venue, server, advance } = setup(() => filled('0.05', '1224.1'));
    await venue.place(order({ cloid: cloidFor('n', 1, 0) }));
    await venue.place(order({ cloid: cloidFor('n', 1, 1) }));
    advance(-5_000);
    await venue.place(order({ cloid: cloidFor('n', 1, 2) }));
    advance(60_000);
    await venue.place(order({ cloid: cloidFor('n', 1, 3) }));
    expect(server.sent('exchange').map((call) => call.body.nonce)).toEqual([NOW, NOW + 1, NOW + 2, NOW + 55_000]);
  });

  it('posts to the testnet API when configured for it', async () => {
    const server = fakeHyperliquid({
      info: {
        metaAndAssetCtxs: () => fixtures.market,
        userRole: () => ({ role: 'agent', data: { user: USER } }),
        orderStatus: () => ({ status: 'unknownOid' }),
      },
      exchange: () => filled('0.05', '1224.1'),
    });
    const venue = createHedgeVenue({ network: 'testnet', agentPrivateKey: agent.privateKey, fetch: server.fetch });
    await venue.place(order());
    expect(server.sent('exchange')[0]?.url).toBe('https://api.hyperliquid-testnet.xyz/exchange');
  });
});

describe('place: reading the answer', () => {
  it('filled in full', async () => {
    const { venue } = setup(() => filled('0.05', '1224.1'));
    expect(await venue.place(order())).toEqual({
      ok: true,
      status: 'filled',
      filledLots: 5,
      avgPx: 1224.1,
      oid: '77747314',
      error: null,
      replayed: false,
    });
  });

  it('partially filled: the rest of an IOC is cancelled', async () => {
    const { venue } = setup(() => filled('0.02', '1223.95'));
    expect(await venue.place(order())).toEqual({
      ok: true,
      status: 'partial',
      filledLots: 2,
      avgPx: 1223.95,
      oid: '77747314',
      error: null,
      replayed: false,
    });
  });

  it('an IOC that finds nothing to match is a failure with the venue wording', async () => {
    const message = 'Order could not immediately match against any resting orders. asset=214';
    const { venue } = setup(() => orderReply({ error: message }));
    expect(await venue.place(order())).toEqual({
      ok: false,
      status: 'rejected',
      filledLots: 0,
      avgPx: null,
      oid: null,
      error: message,
      replayed: false,
    });
  });

  it('a per-order rejection carries its reason', async () => {
    for (const message of [
      'Order must have minimum value of $10.',
      'Insufficient margin to place order. asset=214',
      'Reduce only order would increase position. asset=214',
      'Price must be divisible by tick size. asset=214',
    ]) {
      const { venue } = setup(() => orderReply({ error: message }));
      expect(await venue.place(order())).toMatchObject({ ok: false, status: 'rejected', filledLots: 0, error: message });
    }
  });

  it('an action-level error carries its reason', async () => {
    const message = `User or API Wallet ${agent.address} does not exist.`;
    const { venue } = setup(() => ({ status: 'err', response: message }));
    expect(await venue.place(order())).toMatchObject({ ok: false, status: 'rejected', filledLots: 0, error: message });
  });

  it('an order left resting is reported with its id and is not a success', async () => {
    const { venue } = setup(() => orderReply({ resting: { oid: 77_738_308 } }));
    const outcome = await venue.place(order());
    expect(outcome).toMatchObject({ ok: false, status: 'resting', filledLots: 0, oid: '77738308' });
    expect(outcome.error).toContain('resting');
  });

  it('a status with no fill in it is not a success', async () => {
    for (const status of ['waitingForFill', 'waitingForTrigger', { somethingNew: {} }, null, 7]) {
      const { venue } = setup(() => orderReply(status));
      const outcome = await venue.place(order());
      expect(outcome, JSON.stringify(status)).toMatchObject({ ok: false, status: 'unknown', filledLots: 0 });
      expect(outcome.error).toContain('unexpected order status');
    }
  });

  it('HTTP errors: a 4xx was turned away, a 5xx leaves the outcome open', async () => {
    const limited = await setup(() => text('rate limited', 429)).venue.place(order());
    expect(limited).toMatchObject({ ok: false, status: 'rejected', filledLots: 0, error: 'HTTP 429: rate limited' });

    const unparsed = await setup(() => text('Failed to deserialize the JSON body into the target type', 422)).venue.place(order());
    expect(unparsed).toMatchObject({ ok: false, status: 'rejected' });
    expect(unparsed.error).toContain('HTTP 422');

    const gateway = await setup(() => text('<html>Bad Gateway</html>', 502)).venue.place(order());
    expect(gateway).toMatchObject({ ok: false, status: 'unknown', filledLots: 0, error: 'HTTP 502: <html>Bad Gateway</html>' });

    const internal = await setup(() => json(null, 500)).venue.place(order());
    expect(internal).toMatchObject({ ok: false, status: 'unknown', error: 'HTTP 500: null' });
  });

  it('a body that is not what an order answer looks like is never read as a fill', async () => {
    const malformed: unknown[] = [
      text('<html>maintenance</html>', 200),
      json(null),
      json([]),
      {},
      { status: 'ok' },
      { status: 'ok', response: { type: 'order' } },
      { status: 'ok', response: { type: 'order', data: {} } },
      { status: 'ok', response: { type: 'order', data: { statuses: [] } } },
      { status: 'ok', response: { type: 'order', data: { statuses: [{ filled: {} }, { filled: {} }] } } },
      { status: 'ok', response: { type: 'default' } },
      { status: 'maybe', response: 'who knows' },
    ];
    for (const body of malformed) {
      const { venue } = setup(() => body);
      const outcome = await venue.place(order());
      expect(outcome).toMatchObject({ ok: false, status: 'unknown', filledLots: 0, avgPx: null });
      expect(outcome.error).toMatch(/unexpected/);
    }
  });

  it('a fill whose size cannot be trusted is not reported as a clean success', async () => {
    for (const totalSz of ['0.0', '0', '0.005', 'lots', '']) {
      const { venue } = setup(() => filled(totalSz, '1224.1'));
      const outcome = await venue.place(order());
      expect(outcome, totalSz).toMatchObject({ ok: false, status: 'unknown', filledLots: 0, oid: '77747314' });
      expect(outcome.error).toBeTruthy();
    }
  });

  it('keeps a fill whose average price is unreadable, with a null price', async () => {
    const { venue } = setup(() => orderReply({ filled: { totalSz: '0.05', avgPx: 'n/a', oid: 1 } }));
    expect(await venue.place(order())).toMatchObject({ ok: true, status: 'filled', filledLots: 5, avgPx: null });
  });

  it('a dropped connection comes back as a failure that says the outcome is open', async () => {
    const { venue } = setup(() => {
      throw new TypeError('fetch failed', { cause: new Error('socket hang up') });
    });
    const outcome = await venue.place(order());
    expect(outcome).toMatchObject({ ok: false, status: 'unknown', filledLots: 0, avgPx: null, oid: null });
    expect(outcome.error).toContain('fetch failed (socket hang up)');
    expect(outcome.error).toContain('may or may not have reached the exchange');
  });

  it('a request that hangs is cut off by the timeout', async () => {
    const server = fakeHyperliquid({
      info: {
        metaAndAssetCtxs: () => fixtures.market,
        userRole: () => ({ role: 'agent', data: { user: USER } }),
        orderStatus: () => ({ status: 'unknownOid' }),
      },
    });
    const hang: typeof fetch = (input, init) => {
      if (!String(input).endsWith('/exchange')) return server.fetch(input, init);
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    };
    const venue = createHedgeVenue({ network: 'mainnet', agentPrivateKey: agent.privateKey, fetch: hang, timeoutMs: 30 });
    const outcome = await venue.place(order());
    expect(outcome).toMatchObject({ ok: false, status: 'unknown' });
    expect(outcome.error).toContain('timed out after 30 ms');
  });
});

describe('place: refusing to send', () => {
  const neverSent = async (outcome: Promise<unknown>, server: ReturnType<typeof setup>['server']) => {
    const settled = await outcome;
    expect(settled).toMatchObject({ ok: false, status: 'notSent', filledLots: 0, avgPx: null, oid: null, replayed: false });
    expect(server.sent('exchange')).toHaveLength(0);
    return settled as { error: string };
  };
  const unreachable: Handler = () => {
    throw new Error('the exchange endpoint must not be called');
  };

  it('rejects malformed requests without touching the network', async () => {
    const bad: Partial<OrderRequest>[] = [
      { lots: 0 },
      { lots: -3 },
      { lots: 1.5 },
      { lots: Number.NaN },
      { limitPx: 0 },
      { limitPx: -1 },
      { limitPx: Number.POSITIVE_INFINITY },
      { limitPx: 1e-9 },
      { cloid: '0x1234' },
      { cloid: 'not-hex-at-all-but-34-chars-long!!' as `0x${string}` },
      { side: 'short' as 'sell' },
      { user: '0x1234' },
    ];
    for (const overrides of bad) {
      const { venue, server } = setup(unreachable);
      const outcome = await neverSent(venue.place(order(overrides)), server);
      expect(outcome.error, JSON.stringify(overrides)).toBeTruthy();
    }
  });

  it('needs an agent key', async () => {
    const server = fakeHyperliquid({ exchange: unreachable });
    const venue = createHedgeVenue({ network: 'mainnet', fetch: server.fetch });
    const outcome = await venue.place(order());
    expect(outcome).toMatchObject({ ok: false, status: 'notSent' });
    expect(outcome.error).toContain('no agent key');
    expect(server.calls).toHaveLength(0);
  });

  it('refuses when the agent acts for a different account', async () => {
    const other = '0x00000000000000000000000000000000000000aa';
    const { venue, server } = setup(unreachable, { userRole: () => ({ role: 'agent', data: { user: other } }) });
    const outcome = await neverSent(venue.place(order()), server);
    expect(outcome.error).toContain(`agent ${agent.address} is not approved to trade for ${USER}`);
  });

  it('refuses when Hyperliquid does not know the agent', async () => {
    for (const role of [{ role: 'missing' }, { role: 'user' }, { role: 'subAccount', data: { master: USER } }]) {
      const { venue, server } = setup(unreachable, { userRole: () => role });
      const outcome = await neverSent(venue.place(order()), server);
      expect(outcome.error).toContain('is not approved');
    }
  });

  it('asks again next time after a failed agent check', async () => {
    let role: unknown = { role: 'missing' };
    const { venue, server } = setup(() => filled('0.05', '1224.1'), { userRole: () => role });
    expect(await venue.place(order())).toMatchObject({ status: 'notSent' });
    role = { role: 'agent', data: { user: USER.toUpperCase().replace('0X', '0x') } };
    expect(await venue.place(order())).toMatchObject({ status: 'filled' });
    expect(server.sent('info', 'userRole')).toHaveLength(2);
  });

  it('refuses when any of the checks cannot be made', async () => {
    for (const type of ['metaAndAssetCtxs', 'userRole', 'orderStatus']) {
      const { venue, server } = setup(unreachable, { [type]: () => text('upstream unavailable', 503) });
      const outcome = await neverSent(venue.place(order()), server);
      expect(outcome.error, type).toContain(`info ${type}: HTTP 503`);
    }
  });

  it('refuses when the cloid lookup answers something unreadable', async () => {
    const { venue, server } = setup(unreachable, { orderStatus: () => ({ status: 'order' }) });
    const outcome = await neverSent(venue.place(order()), server);
    expect(outcome.error).toContain('orderStatus');
  });

  it('refuses a coin that does not trade in 0.01 steps', async () => {
    const server = fakeHyperliquid({ info: { metaAndAssetCtxs: () => fixtures.market }, exchange: unreachable });
    const venue = createHedgeVenue({ network: 'mainnet', coin: 'BTC', agentPrivateKey: agent.privateKey, fetch: server.fetch });
    const outcome = await venue.place(order());
    expect(outcome).toMatchObject({ ok: false, status: 'notSent' });
    expect(outcome.error).toContain('BTC trades in steps of 5 decimals');
  });
});

describe('place: one cloid, one attempt', () => {
  const unreachable: Handler = () => {
    throw new Error('the exchange endpoint must not be called');
  };

  it('reports the earlier fill instead of trading again', async () => {
    const { venue, server } = setup(unreachable, {
      orderStatus: () => filledOrder,
      userFillsByTime: () => filledOrderFills,
    });
    const cloid = filledOrder.order.order.cloid as `0x${string}`;
    expect(await venue.place(order({ lots: 4, cloid }))).toEqual({
      ok: true,
      status: 'filled',
      filledLots: 4,
      avgPx: 1227.5,
      oid: '570527861065',
      error: null,
      replayed: true,
    });
    expect(server.sent('exchange')).toHaveLength(0);
    expect(server.sent('info', 'userFillsByTime')[0]?.body).toMatchObject({
      user: USER,
      startTime: filledOrder.order.order.timestamp - 60_000,
    });
  });

  it('averages the price over every fill of the earlier order and ignores other orders', async () => {
    const [fill] = filledOrderFills;
    if (fill === undefined) throw new Error('fixture is empty');
    const fills = [
      { ...fill, sz: '0.01', px: '1227.5', tid: 1 },
      { ...fill, sz: '0.03', px: '1227.1', tid: 2 },
      { ...fill, sz: '9.99', px: '1000', tid: 3, oid: 1 },
    ];
    const { venue } = setup(unreachable, { orderStatus: () => filledOrder, userFillsByTime: () => fills });
    const outcome = await venue.place(order({ lots: 4 }));
    expect(outcome).toMatchObject({ ok: true, status: 'filled', filledLots: 4, replayed: true });
    expect(outcome.avgPx).toBeCloseTo(1227.2, 9);
  });

  it('reports an earlier partial fill as partial', async () => {
    const partial = clone(filledOrder);
    partial.order.order.sz = '0.06';
    partial.order.order.origSz = '0.1';
    const { venue } = setup(unreachable, { orderStatus: () => partial, userFillsByTime: () => filledOrderFills });
    expect(await venue.place(order({ lots: 10 }))).toMatchObject({ ok: true, status: 'partial', filledLots: 4, replayed: true });
  });

  it('falls back to the order sizes when a filled order has no fills listed yet', async () => {
    const partial = clone(filledOrder);
    partial.order.order.sz = '0.01';
    partial.order.order.origSz = '0.05';
    const { venue } = setup(unreachable, { orderStatus: () => partial });
    expect(await venue.place(order({ lots: 5 }))).toEqual({
      ok: true,
      status: 'partial',
      filledLots: 4,
      avgPx: null,
      oid: '570527861065',
      error: null,
      replayed: true,
    });
  });

  it('does not resend a cloid whose earlier order was rejected', async () => {
    const { venue, server } = setup(unreachable, { orderStatus: () => rejectedOrder });
    const outcome = await venue.place(order());
    expect(outcome).toMatchObject({ ok: false, status: 'rejected', filledLots: 0, oid: '557661194000', replayed: true });
    expect(outcome.error).toContain('minTradeNtlRejected');
    expect(server.sent('exchange')).toHaveLength(0);
  });

  it('reports an order that is somehow still open as resting', async () => {
    const open = clone(filledOrder);
    open.order.status = 'open';
    open.order.order.sz = '0.04';
    const { venue } = setup(unreachable, { orderStatus: () => open });
    expect(await venue.place(order())).toMatchObject({ ok: false, status: 'resting', replayed: true });
  });

  it('fails without sending when the fills of the earlier order cannot be read', async () => {
    const { venue, server } = setup(unreachable, {
      orderStatus: () => filledOrder,
      userFillsByTime: () => text('upstream unavailable', 503),
    });
    const outcome = await venue.place(order());
    expect(outcome).toMatchObject({ ok: false, status: 'notSent' });
    expect(server.sent('exchange')).toHaveLength(0);
  });

  it('resends the identical signed bytes after an attempt that got no answer', async () => {
    let attempts = 0;
    const { venue, server, advance } = setup(() => {
      attempts += 1;
      if (attempts === 1) throw new TypeError('fetch failed');
      return filled('0.05', '1224.1');
    });
    const cloid = cloidFor('org_1', 7, 0);
    expect(await venue.place(order({ cloid }))).toMatchObject({ status: 'unknown' });
    advance(45_000);
    expect(await venue.place(order({ cloid }))).toMatchObject({ ok: true, status: 'filled', filledLots: 5 });

    const [first, second] = server.sent('exchange').map((call) => JSON.stringify(call.body));
    expect(second).toBe(first);
    expect(server.sent('exchange')[1]?.body.nonce).toBe(NOW);
    // The retry also asked whether the first attempt had landed.
    expect(server.sent('info', 'orderStatus')).toHaveLength(2);
  });

  it('stops reusing the nonce once the lookup by cloid has had time to catch up', async () => {
    const answers: unknown[] = [text('Bad Gateway', 502), filled('0.05', '1224.1')];
    const { venue, server, advance } = setup(() => answers.shift());
    const cloid = cloidFor('org_1', 11, 0);
    expect(await venue.place(order({ cloid }))).toMatchObject({ status: 'unknown' });
    advance(11 * 60_000);
    expect(await venue.place(order({ cloid }))).toMatchObject({ ok: true, status: 'filled' });
    expect(server.sent('exchange').map((call) => call.body.nonce)).toEqual([NOW, NOW + 11 * 60_000]);
  });

  it('does not call a refused resend a clean rejection', async () => {
    // Hyperliquid's wording for a nonce it has already seen is not documented; any action-level error will do.
    const refusal = 'stand-in for the refusal of a reused nonce';
    let attempts = 0;
    const { venue } = setup(() => {
      attempts += 1;
      if (attempts === 1) return text('Bad Gateway', 502);
      return { status: 'err', response: refusal };
    });
    const cloid = cloidFor('org_1', 8, 0);
    expect(await venue.place(order({ cloid }))).toMatchObject({ status: 'unknown' });
    const retry = await venue.place(order({ cloid }));
    expect(retry).toMatchObject({ ok: false, status: 'unknown', filledLots: 0 });
    expect(retry.error).toContain(refusal);
    expect(retry.error).toContain('the first attempt may have traded');
  });

  it('takes a per-order answer to a resend at face value and then lets go of the nonce', async () => {
    const answers: unknown[] = [
      text('Bad Gateway', 502),
      orderReply({ error: 'Order could not immediately match against any resting orders. asset=214' }),
      filled('0.05', '1224.1'),
    ];
    const { venue, server } = setup(() => answers.shift());
    const cloid = cloidFor('org_1', 9, 0);
    expect(await venue.place(order({ cloid }))).toMatchObject({ status: 'unknown' });
    expect(await venue.place(order({ cloid }))).toMatchObject({ ok: false, status: 'rejected' });
    expect(await venue.place(order({ cloid }))).toMatchObject({ ok: true, status: 'filled' });
    expect(server.sent('exchange').map((call) => call.body.nonce)).toEqual([NOW, NOW, NOW + 1]);
  });

  it('gives different cloids different nonces and signatures', async () => {
    const { venue, server } = setup(() => filled('0.05', '1224.1'));
    await venue.place(order({ cloid: cloidFor('org_1', 10, 0) }));
    await venue.place(order({ cloid: cloidFor('org_1', 10, 1) }));
    const [first, second] = server.sent('exchange').map((call) => call.body);
    expect(first?.nonce).not.toBe(second?.nonce);
    expect(first?.signature.r).not.toBe(second?.signature.r);
  });
});

describe('place: never throws', () => {
  it('turns every failure into a result', async () => {
    const failing: typeof fetch = () => {
      throw new Error('synchronous failure inside fetch');
    };
    const venue = createHedgeVenue({ network: 'mainnet', agentPrivateKey: agent.privateKey, fetch: failing });
    const outcome = await venue.place(order());
    expect(outcome).toMatchObject({ ok: false, status: 'notSent', filledLots: 0 });
    expect(outcome.error).toContain('synchronous failure inside fetch');
  });
});
