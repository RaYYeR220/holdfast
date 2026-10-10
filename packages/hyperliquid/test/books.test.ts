import { describe, expect, it } from 'vitest';
import { createHedgeVenue, HyperliquidResponseError, HyperliquidTransportError } from '../src/index';
import builderFills from './fixtures/orderStatus-filled-fills.json';
import { type Body, fakeHyperliquid, fixtures, json, text } from './support';

const USER = '0xda22459d4776c240e9182be9e569f07617cef664';
const HOUR = 3_600_000;
/** Half an hour after the newest recorded funding sample. */
const NOW = 1_791_633_600_025 + HOUR / 2;

function venueWith(info: Record<string, (body: Body) => unknown>, now = NOW) {
  const server = fakeHyperliquid({ info });
  const venue = createHedgeVenue({ network: 'mainnet', fetch: server.fetch, now: () => now });
  return { venue, server };
}

describe('fundingAprBps', () => {
  it('annualises the trailing mean of the recorded hourly rates', async () => {
    const { venue, server } = venueWith({ fundingHistory: () => fixtures.fundingHistory });
    expect(await venue.fundingAprBps(72)).toBe(1095);
    expect(server.calls.map((call) => call.body)).toEqual([{ type: 'fundingHistory', coin: 'ZEC', startTime: NOW - 72 * HOUR }]);
  });

  it('is positive when shorts are paid and negative when they pay', async () => {
    const sample = (rate: string, hoursAgo: number) => ({ coin: 'ZEC', fundingRate: rate, premium: '0.0', time: NOW - hoursAgo * HOUR });
    const paid = venueWith({ fundingHistory: () => [sample('0.00005', 2), sample('0.00003', 1)] });
    expect(await paid.venue.fundingAprBps(2)).toBe(3504);
    const paying = venueWith({ fundingHistory: () => [sample('-0.00005', 2), sample('-0.00003', 1)] });
    expect(await paying.venue.fundingAprBps(2)).toBe(-3504);
  });

  it('asks for the configured coin', async () => {
    const server = fakeHyperliquid({ info: { fundingHistory: () => fixtures.fundingHistory } });
    const venue = createHedgeVenue({ network: 'mainnet', coin: 'SOL', fetch: server.fetch, now: () => NOW });
    await venue.fundingAprBps(24);
    expect(server.calls[0]?.body).toEqual({ type: 'fundingHistory', coin: 'SOL', startTime: NOW - 24 * HOUR });
  });

  it('follows the 500-row pages of a long window', async () => {
    const start = NOW - 600 * HOUR;
    const all = Array.from({ length: 600 }, (_, i) => ({
      coin: 'ZEC',
      fundingRate: i < 500 ? '0.00001' : '0.00004',
      premium: '0.0',
      time: start + (i + 1) * HOUR - 1_000,
    }));
    const { venue, server } = venueWith({
      fundingHistory: (body) => all.filter((sample) => sample.time >= body.startTime).slice(0, 500),
    });
    // (500 * 0.00001 + 100 * 0.00004) / 600 = 0.000015 an hour.
    expect(await venue.fundingAprBps(600)).toBe(1314);
    expect(server.calls.map((call) => call.body.startTime)).toEqual([start, all[499]?.time]);
  });

  it('treats an empty or stale history as an error, never as a rate of zero', async () => {
    const empty = venueWith({ fundingHistory: () => [] });
    await expect(empty.venue.fundingAprBps(72)).rejects.toBeInstanceOf(HyperliquidResponseError);

    const stale = venueWith({ fundingHistory: () => fixtures.fundingHistory }, NOW + 3 * HOUR);
    await expect(stale.venue.fundingAprBps(100)).rejects.toThrow('no recent funding sample for ZEC');
  });

  it('surfaces the 500 Hyperliquid answers for a coin it does not know', async () => {
    const { venue } = venueWith({ fundingHistory: () => json(null, 500) });
    const failure = await venue.fundingAprBps(72).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HyperliquidTransportError);
    expect(failure).toMatchObject({ httpStatus: 500 });
  });

  it('rejects a window that is not a positive number of hours', async () => {
    const { venue, server } = venueWith({ fundingHistory: () => fixtures.fundingHistory });
    for (const hours of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(venue.fundingAprBps(hours), String(hours)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    expect(server.calls).toHaveLength(0);
  });

  it('rejects samples it cannot read', async () => {
    for (const history of [null, {}, [{ time: NOW - HOUR }], [{ fundingRate: 'high', time: NOW - HOUR }], [{ fundingRate: '0.1', time: 'now' }]]) {
      const { venue } = venueWith({ fundingHistory: () => json(history) });
      await expect(venue.fundingAprBps(72), JSON.stringify(history)).rejects.toBeInstanceOf(HyperliquidResponseError);
    }
  });
});

describe('userFunding', () => {
  it('normalises the recorded payments', async () => {
    const { venue, server } = venueWith({ userFunding: () => fixtures.userFunding });
    const payments = await venue.userFunding(USER, 1_791_600_000_000);
    expect(payments).toHaveLength(4);
    expect(payments[0]).toEqual({ time: 1_791_622_800_012, coin: 'ZEC', usd: 0.031091, size: -2.03, fundingRate: 0.0000125 });
    expect(payments.map((payment) => payment.usd)).toEqual([0.031091, 0.064193, 0.030791, 0.031179]);
    expect(server.calls.map((call) => call.body)).toEqual([{ type: 'userFunding', user: USER, startTime: 1_791_600_000_000 }]);
  });

  it('keeps the sign: a long paying funding is a negative amount', async () => {
    const row = { time: NOW, hash: `0x${'0'.repeat(64)}`, delta: { type: 'funding', coin: 'ZEC', usdc: '-1.25', szi: '80.0', fundingRate: '0.0000125', nSamples: null } };
    const { venue } = venueWith({ userFunding: () => [row] });
    expect(await venue.userFunding(USER, 0)).toEqual([{ time: NOW, coin: 'ZEC', usd: -1.25, size: 80, fundingRate: 0.0000125 }]);
  });

  it('keeps payments of different coins that share a timestamp', async () => {
    const row = (coin: string) => ({ time: NOW, hash: `0x${'0'.repeat(64)}`, delta: { type: 'funding', coin, usdc: '1.0', szi: '-1.0', fundingRate: '0.0000125', nSamples: null } });
    const { venue } = venueWith({ userFunding: () => [row('ZEC'), row('BTC')] });
    expect((await venue.userFunding(USER, 0)).map((payment) => payment.coin)).toEqual(['ZEC', 'BTC']);
  });

  it('validates the account and the start time', async () => {
    const { venue, server } = venueWith({ userFunding: () => [] });
    await expect(venue.userFunding('nobody', 0)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(venue.userFunding(USER, -1)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(venue.userFunding(USER, 1.5)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(server.calls).toHaveLength(0);
  });
});

describe('userFills', () => {
  it('normalises the recorded fills', async () => {
    const { venue, server } = venueWith({ userFillsByTime: () => fixtures.userFills });
    const fills = await venue.userFills(USER, 1_791_400_000_000);
    expect(fills).toHaveLength(4);
    expect(fills[0]).toEqual({
      time: 1_791_486_562_046,
      coin: 'ZEC',
      side: 'sell',
      direction: 'Open Short',
      size: 0.18,
      px: 1143.1,
      fee: -0.002057,
      feeToken: 'USDC',
      closedPnlUsd: 0,
      oid: '569124035074',
      cloid: '0xda22459d4776c240000205025de88224',
      tid: '615832413558277',
      crossed: false,
    });
    expect(fills[3]).toMatchObject({ side: 'buy', direction: 'Close Short', size: 0.02, px: 1143.6, closedPnlUsd: -0.006904 });
    expect(server.calls.map((call) => call.body)).toEqual([
      { type: 'userFillsByTime', user: USER, startTime: 1_791_400_000_000, aggregateByTime: false },
    ]);
  });

  it('reports the total fee of a taker fill routed through a builder', async () => {
    const { venue } = venueWith({ userFillsByTime: () => builderFills });
    expect(await venue.userFills(USER, 0)).toEqual([
      {
        time: 1_791_635_338_038,
        coin: 'ZEC',
        side: 'sell',
        direction: 'Open Short',
        size: 0.04,
        px: 1227.5,
        fee: 0.045761,
        feeToken: 'USDC',
        closedPnlUsd: 0,
        oid: '570527861065',
        cloid: '0x5048120a000002587211f6e3dd5fa44f',
        tid: '6116702773395',
        crossed: true,
      },
    ]);
  });

  it('reports a fill without a cloid as null', async () => {
    const [template] = fixtures.userFills;
    const { cloid: _cloid, ...bare } = template ?? { cloid: '' };
    const { venue } = venueWith({ userFillsByTime: () => [bare] });
    expect((await venue.userFills(USER, 0))[0]?.cloid).toBeNull();
  });

  it('follows the 2000-row pages and counts the overlap once', async () => {
    const [template] = fixtures.userFills;
    const all = Array.from({ length: 2500 }, (_, i) => ({ ...template, tid: 1_000 + i, time: 1_791_000_000_000 + Math.floor(i / 2) * 1_000 }));
    const { venue, server } = venueWith({
      userFillsByTime: (body) => all.filter((fill) => fill.time >= body.startTime).slice(0, 2000),
    });
    const fills = await venue.userFills(USER, 1_791_000_000_000);
    expect(fills).toHaveLength(2500);
    expect(new Set(fills.map((fill) => fill.tid)).size).toBe(2500);
    expect(fills.every((fill, i) => i === 0 || (fills[i - 1]?.time ?? 0) <= fill.time)).toBe(true);
    // The second page starts at the last timestamp of the first, so its neighbours in that millisecond are not lost.
    expect(server.calls.map((call) => call.body.startTime)).toEqual([1_791_000_000_000, all[1999]?.time]);
  });

  it('returns fills oldest first even when a page arrives unordered', async () => {
    const reversed = [...fixtures.userFills].reverse();
    const { venue } = venueWith({ userFillsByTime: () => reversed });
    const times = (await venue.userFills(USER, 0)).map((fill) => fill.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('gives up instead of looping when the history never ends', async () => {
    const [template] = fixtures.userFills;
    const { venue, server } = venueWith({
      userFillsByTime: (body) => Array.from({ length: 2000 }, (_, i) => ({ ...template, tid: i, time: body.startTime })),
    });
    await expect(venue.userFills(USER, 5)).rejects.toThrow('did not end within 40 pages');
    expect(server.calls).toHaveLength(40);
    expect(server.calls.at(-1)?.body.startTime).toBe(44);
  });

  it('rejects rows it cannot read', async () => {
    const [template] = fixtures.userFills;
    for (const broken of [{ ...template, side: 'X' }, { ...template, sz: 'big' }, { ...template, oid: '12' }, { ...template, time: null }, 'fill']) {
      const { venue } = venueWith({ userFillsByTime: () => [broken] });
      await expect(venue.userFills(USER, 0), JSON.stringify(broken)).rejects.toBeInstanceOf(HyperliquidResponseError);
    }
    const notAList = venueWith({ userFillsByTime: () => ({ fills: [] }) });
    await expect(notAList.venue.userFills(USER, 0)).rejects.toBeInstanceOf(HyperliquidResponseError);
  });

  it('surfaces an HTTP failure as a transport error', async () => {
    const { venue } = venueWith({ userFillsByTime: () => text('rate limited', 429) });
    await expect(venue.userFills(USER, 0)).rejects.toMatchObject({ code: 'TRANSPORT', httpStatus: 429 });
  });
});
