import { describe, expect, it } from 'vitest';
import {
  createHedgeVenue,
  FractionalLotError,
  HyperliquidError,
  HyperliquidResponseError,
  HyperliquidTransportError,
  IsolatedPositionError,
  UnsupportedAccountModeError,
} from '../src/index';
import { type AccountFixture, accountRoutes, clone, fakeHyperliquid, fixtures, json, text } from './support';

const { accounts } = fixtures;
const NOW = 1_791_635_950_000;

function venueFor(account: AccountFixture, options: { coin?: string; now?: number } = {}) {
  const server = fakeHyperliquid({ info: accountRoutes(account) });
  const venue = createHedgeVenue({
    network: 'mainnet',
    fetch: server.fetch,
    now: () => options.now ?? NOW,
    ...(options.coin === undefined ? {} : { coin: options.coin }),
  });
  return { venue, server };
}

/** The recorded account with its ZEC position resized. */
function withZecSize(account: AccountFixture, szi: string): AccountFixture {
  const copy = clone(account) as AccountFixture & {
    clearinghouseState: { assetPositions: { position: { coin: string; szi: string } }[] };
  };
  const zec = copy.clearinghouseState.assetPositions.find((entry) => entry.position.coin === 'ZEC');
  if (zec === undefined) throw new Error('fixture has no ZEC position');
  zec.position.szi = szi;
  return copy;
}

describe('state: position', () => {
  it('reads a flat account that has never traded', async () => {
    const { venue } = venueFor(accounts.standardFlat);
    const state = await venue.state(accounts.standardFlat.user);
    expect(state).toEqual({
      asOf: 1_791_635_942_095,
      markPx: 1227.6,
      oraclePx: 1227.8,
      shortLots: 0,
      accountValueUsd: 0,
      coin: 'ZEC',
      mode: 'standard',
      abstraction: 'default',
    });
    expect(Object.is(state.shortLots, 0)).toBe(true);
  });

  it('reports a short as positive lots', async () => {
    const { venue } = venueFor(accounts.standardShort);
    const state = await venue.state(accounts.standardShort.user);
    expect(state.shortLots).toBe(111);
    expect(state.accountValueUsd).toBe(1893.077482);
    expect(state.markPx).toBe(1227.6);
    expect(state.oraclePx).toBe(1227.8);
  });

  it('reports a long as negative lots', async () => {
    const { venue } = venueFor(accounts.standardLong);
    const state = await venue.state(accounts.standardLong.user);
    expect(state.shortLots).toBe(-31);
    expect(state.accountValueUsd).toBe(44_499.840775);
  });

  it('ignores positions in other coins', async () => {
    const other = clone(accounts.standardLong) as AccountFixture & {
      clearinghouseState: { assetPositions: { position: { coin: string } }[] };
    };
    other.clearinghouseState.assetPositions = other.clearinghouseState.assetPositions.filter(
      (entry) => entry.position.coin !== 'ZEC',
    );
    expect(other.clearinghouseState.assetPositions.length).toBeGreaterThan(0);
    const state = await venueFor(other).venue.state(other.user);
    expect(state.shortLots).toBe(0);
    expect(state.accountValueUsd).toBe(44_499.840775);
  });

  it('throws a typed error when the position is not a whole number of lots', async () => {
    const odd = withZecSize(accounts.standardShort, '-1.115');
    const { venue } = venueFor(odd);
    await expect(venue.state(odd.user)).rejects.toBeInstanceOf(FractionalLotError);
    await expect(venue.state(odd.user)).rejects.toMatchObject({ code: 'FRACTIONAL_LOT', size: '-1.115' });
  });

  it('refuses an isolated hedge position, whose margin the account equity does not back', async () => {
    const { venue } = venueFor(accounts.unifiedIsolated);
    await expect(venue.state(accounts.unifiedIsolated.user)).rejects.toBeInstanceOf(IsolatedPositionError);
  });
});

describe('state: equity by account mode', () => {
  it('standard account: the cross account value of the perp balance', async () => {
    const { venue } = venueFor(accounts.standardShort);
    const state = await venue.state(accounts.standardShort.user);
    expect(state.mode).toBe('standard');
    expect(state.abstraction).toBe('disabled');
    expect(state.accountValueUsd).toBe(1893.077482);
  });

  it('unified account: the spot USDC balance, not the perp margin slice', async () => {
    const { venue } = venueFor(accounts.unifiedShort);
    const state = await venue.state(accounts.unifiedShort.user);
    expect(state.mode).toBe('unified');
    expect(state.abstraction).toBe('unifiedAccount');
    expect(state.shortLots).toBe(2);
    // The same account's perp marginSummary.accountValue was 219.589938 at that moment.
    expect(state.accountValueUsd).toBe(1150.487088);
  });

  it('unified account, long and fully used: spot total again', async () => {
    const { venue } = venueFor(accounts.unifiedLong);
    const state = await venue.state(accounts.unifiedLong.user);
    expect(state.mode).toBe('unified');
    expect(state.shortLots).toBe(-55_058);
    expect(state.accountValueUsd).toBe(279_664.2732808301);
  });

  it('unified account with no position still shows its collateral', async () => {
    const { venue } = venueFor(accounts.unifiedFlat);
    const state = await venue.state(accounts.unifiedFlat.user);
    expect(state).toMatchObject({ mode: 'unified', shortLots: 0, accountValueUsd: 5467.504013 });
  });

  it('the same balances read differently in the two modes', async () => {
    const asStandard = { ...clone(accounts.unifiedShort), userAbstraction: 'disabled' };
    const unified = await venueFor(accounts.unifiedShort).venue.state(accounts.unifiedShort.user);
    const standard = await venueFor(asStandard).venue.state(asStandard.user);
    expect(unified.accountValueUsd).toBe(1150.487088);
    expect(standard.accountValueUsd).toBe(219.589938);
    expect(standard.shortLots).toBe(unified.shortLots);
  });

  it('unified account: margin locked in isolated positions of other coins is taken out', async () => {
    const mixed = clone(accounts.unifiedShort) as AccountFixture & {
      clearinghouseState: {
        assetPositions: { position: { coin: string; marginUsed: string; leverage: Record<string, unknown> } }[];
      };
    };
    const btc = mixed.clearinghouseState.assetPositions.find((entry) => entry.position.coin === 'BTC');
    if (btc === undefined) throw new Error('fixture has no BTC position');
    btc.position.leverage = { type: 'isolated', value: 40, rawUsd: '-82.0' };
    btc.position.marginUsed = '50.487088';
    const state = await venueFor(mixed).venue.state(mixed.user);
    expect(state.accountValueUsd).toBeCloseTo(1100, 9);
  });

  it('standard account: isolated margin is already outside the cross account value', async () => {
    const mixed = { ...clone(accounts.unifiedIsolated), userAbstraction: 'disabled' } as AccountFixture & {
      clearinghouseState: { assetPositions: { position: { coin: string } }[] };
    };
    for (const entry of mixed.clearinghouseState.assetPositions) entry.position.coin = 'BTC';
    // marginSummary.accountValue is 34.032454 here, all of it isolated; cross is zero.
    const state = await venueFor(mixed).venue.state(mixed.user);
    expect(state).toMatchObject({ mode: 'standard', shortLots: 0, accountValueUsd: 0 });
  });

  it('treats "default" and the discontinued "dexAbstraction" as standard', async () => {
    for (const abstraction of ['default', 'dexAbstraction']) {
      const account = { ...clone(accounts.standardShort), userAbstraction: abstraction };
      const state = await venueFor(account).venue.state(account.user);
      expect(state).toMatchObject({ mode: 'standard', abstraction, accountValueUsd: 1893.077482 });
    }
  });

  it('refuses portfolio margin and any mode it does not know', async () => {
    const { venue } = venueFor(accounts.portfolioMargin);
    await expect(venue.state(accounts.portfolioMargin.user)).rejects.toBeInstanceOf(UnsupportedAccountModeError);
    await expect(venue.state(accounts.portfolioMargin.user)).rejects.toMatchObject({
      code: 'UNSUPPORTED_ACCOUNT_MODE',
      abstraction: 'portfolioMargin',
    });

    for (const abstraction of ['somethingNew', 'constructor', 'toString']) {
      const account = { ...clone(accounts.standardShort), userAbstraction: abstraction };
      await expect(venueFor(account).venue.state(account.user)).rejects.toBeInstanceOf(UnsupportedAccountModeError);
    }
  });
});

describe('state: reading', () => {
  it('asks for the market, the perp state, the mode and the spot state of the lowercased account', async () => {
    const { venue, server } = venueFor(accounts.standardShort);
    await venue.state(accounts.standardShort.user.toUpperCase().replace('0X', '0x'));
    const user = accounts.standardShort.user;
    expect(server.calls.map((call) => call.body).sort((a, b) => a.type.localeCompare(b.type))).toEqual([
      { type: 'clearinghouseState', user },
      { type: 'metaAndAssetCtxs' },
      { type: 'spotClearinghouseState', user },
      { type: 'userAbstraction', user },
    ]);
    expect(new Set(server.calls.map((call) => call.url))).toEqual(new Set(['https://api.hyperliquid.xyz/info']));
  });

  it('reads from the testnet API when configured for it', async () => {
    const server = fakeHyperliquid({ info: accountRoutes(accounts.standardFlat) });
    const venue = createHedgeVenue({ network: 'testnet', fetch: server.fetch, now: () => NOW });
    await venue.state(accounts.standardFlat.user);
    expect(new Set(server.calls.map((call) => call.url))).toEqual(new Set(['https://api.hyperliquid-testnet.xyz/info']));
  });

  it('stamps the state with the older of our clock and the venue clock', async () => {
    const venueTime = 1_791_635_941_491;
    const behind = await venueFor(accounts.standardShort, { now: venueTime + 4_000 }).venue.state(accounts.standardShort.user);
    expect(behind.asOf).toBe(venueTime);
    const ahead = await venueFor(accounts.standardShort, { now: venueTime - 250 }).venue.state(accounts.standardShort.user);
    expect(ahead.asOf).toBe(venueTime - 250);
  });

  it('rejects an address that is not one', async () => {
    const { venue, server } = venueFor(accounts.standardFlat);
    await expect(venue.state('0x1234')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(server.calls).toHaveLength(0);
  });

  it('fails for a coin that is not listed, is delisted, or does not trade in 0.01 steps', async () => {
    const user = accounts.standardFlat.user;
    await expect(venueFor(accounts.standardFlat, { coin: 'NOPE' }).venue.state(user)).rejects.toMatchObject({
      code: 'UNKNOWN_COIN',
    });
    await expect(venueFor(accounts.standardFlat, { coin: 'MATIC' }).venue.state(user)).rejects.toMatchObject({
      code: 'UNKNOWN_COIN',
    });
    await expect(venueFor(accounts.standardFlat, { coin: 'BTC' }).venue.state(user)).rejects.toMatchObject({
      code: 'UNSUPPORTED_LOT_SIZE',
    });
  });

  it('surfaces an HTTP failure as a transport error', async () => {
    const server = fakeHyperliquid({
      info: { ...accountRoutes(accounts.standardShort), clearinghouseState: () => text('upstream unavailable', 502) },
    });
    const venue = createHedgeVenue({ network: 'mainnet', fetch: server.fetch, now: () => NOW });
    const failure = await venue.state(accounts.standardShort.user).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HyperliquidTransportError);
    expect(failure).toMatchObject({ code: 'TRANSPORT', httpStatus: 502 });
    expect((failure as Error).message).toContain('clearinghouseState');
  });

  it('surfaces the 422 Hyperliquid sends for a request it cannot parse', async () => {
    const server = fakeHyperliquid({
      info: {
        ...accountRoutes(accounts.standardShort),
        userAbstraction: () => text('Failed to deserialize the JSON body into the target type', 422),
      },
    });
    const venue = createHedgeVenue({ network: 'mainnet', fetch: server.fetch, now: () => NOW });
    await expect(venue.state(accounts.standardShort.user)).rejects.toMatchObject({ code: 'TRANSPORT', httpStatus: 422 });
  });

  it('surfaces a dropped connection as a transport error', async () => {
    const venue = createHedgeVenue({
      network: 'mainnet',
      now: () => NOW,
      fetch: () => Promise.reject(new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND') })),
    });
    const failure = await venue.state(accounts.standardShort.user).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HyperliquidTransportError);
    expect(failure).toMatchObject({ httpStatus: null });
    expect((failure as Error).message).toContain('ENOTFOUND');
  });

  it('rejects answers that do not have the expected shape', async () => {
    const broken: Record<string, () => unknown> = {
      clearinghouseState: () => ({ assetPositions: 'none' }),
      spotClearinghouseState: () => json(null),
      userAbstraction: () => ({ mode: 'unifiedAccount' }),
      metaAndAssetCtxs: () => [{ universe: [{ name: 'ZEC', szDecimals: 2 }] }, [{ markPx: 'n/a', oraclePx: '1' }]],
    };
    for (const [type, handler] of Object.entries(broken)) {
      const server = fakeHyperliquid({ info: { ...accountRoutes(accounts.unifiedShort), [type]: handler } });
      const venue = createHedgeVenue({ network: 'mainnet', fetch: server.fetch, now: () => NOW });
      const failure = await venue.state(accounts.unifiedShort.user).catch((error: unknown) => error);
      expect(failure, type).toBeInstanceOf(HyperliquidResponseError);
      expect(failure, type).toBeInstanceOf(HyperliquidError);
    }
  });

  it('rejects a non-positive price', async () => {
    const market = clone(fixtures.market) as unknown as [unknown, { markPx: string }[]];
    const zec = market[1][3];
    if (zec === undefined) throw new Error('fixture has no ZEC context');
    zec.markPx = '0.0';
    const server = fakeHyperliquid({ info: { ...accountRoutes(accounts.standardShort), metaAndAssetCtxs: () => market } });
    const venue = createHedgeVenue({ network: 'mainnet', fetch: server.fetch, now: () => NOW });
    await expect(venue.state(accounts.standardShort.user)).rejects.toBeInstanceOf(HyperliquidResponseError);
  });
});
