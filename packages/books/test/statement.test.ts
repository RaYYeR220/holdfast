import type { OutgoingPayment, OwnedNote } from '@holdfast/core';
import { describe, expect, it } from 'vitest';
import { buildLedger, buildStatement, isTreasuryZec, type LedgerEntry, type Statement, type SwapRecord, sumAmounts } from '../src/index';
import { CLOID, NOW, PAYOUTS_NOW, POLICY, USDC_SOLANA_ID, ZEC_ID, historyWithPayouts, journalOf, realHistory, realTicks, solanaRun, tempoRun } from './fixtures';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const lastTick = realTicks.at(-1)!;
const lockTick = realTicks[2]!;

function statementOf(history = realHistory(), over: Partial<Parameters<typeof buildStatement>[0]> = {}): Statement {
  return buildStatement({ ledger: buildLedger(history.records), journal: history.journal, policy: POLICY, now: NOW, monthlyBurnUsd: 4, ...over });
}

const NAV_AT_LOCK = 0.0103 * 1227.1 + 11.020977;
const EQUITY_NOW = lastTick.venue!.equity;
const NAV_NOW = 0.0103 * 1228.6 + EQUITY_NOW;

describe('the statement of the demo treasury', () => {
  const s = statementOf();

  it('reports the treasury and what it is worth now', () => {
    expect(s.treasury).toEqual({
      zat: 1_030_000n,
      untrackedZat: 0n,
      asOf: lastTick.at,
      px: 1228.6,
      pxAt: lastTick.at,
      usd: 0.0103 * 1228.6,
    });
  });

  it('reports the hedge from the latest journal snapshot', () => {
    expect(s.hedge).toEqual({
      asOf: lastTick.at,
      shortLots: 1,
      markPx: 1228.6,
      notionalUsd: 12.286,
      accountValueUsd: EQUITY_NOW,
      marginRatioBps: Math.round((EQUITY_NOW / 12.286) * 10_000),
      targetLots: 1,
      coverageBps: 10_000,
      fundingAprBps: 1_095,
    });
  });

  it('measures value at the lock against value now', () => {
    expect(s.lock).toMatchObject({ lockedAt: lockTick.at, lockedSeq: 3, externalFlowsUsd: 0 });
    expect(s.lock?.navAtLockUsd).toBeCloseTo(NAV_AT_LOCK, 9);
    expect(s.lock?.navNowUsd).toBeCloseTo(NAV_NOW, 9);
    expect(s.lock?.driftUsd).toBeCloseTo(NAV_NOW - NAV_AT_LOCK, 9);
    // Unhedged, the same holdings would simply have followed the price.
    expect(s.lock?.unhedgedNowUsd).toBeCloseTo((NAV_AT_LOCK / 1227.1) * 1228.6, 9);
    expect(s.lock?.unhedgedDriftUsd).toBeCloseTo(NAV_AT_LOCK * (1228.6 / 1227.1 - 1), 9);
  });

  it('explains the drift by what the lock cost and the sliver it leaves unhedged', () => {
    const fee = 0.005518;
    // The value at lock was read at the 1227.1 mark; the order then sold at 1226.4.
    const entrySlippage = 0.01 * (1227.1 - 1226.4);
    // 0.0103 ZEC are held against a short of 0.01, and the price rose by 1.5.
    const unhedgedSliver = 0.0003 * (1228.6 - 1227.1);
    const funding = 0.000307;
    expect(s.lock?.driftUsd).toBeCloseTo(unhedgedSliver + funding - fee - entrySlippage, 9);
    expect(s.lock!.unhedgedDriftUsd!).toBeGreaterThan(0.02);
  });

  it('reports what came in, what was swapped and what it cost', () => {
    expect(s.receipts).toEqual({ zat: 1_975_000n, usd: 0.01975 * 1219.5, count: 1 });
    expect(s.payments).toEqual({ zat: 0n, usd: 0, count: 0 });
    expect(s.swapped?.zat).toBe(930_000n);
    expect(s.swapped?.usd).toBeCloseTo(0.0093 * 1225.2, 12);
    expect(s.funding?.count).toBe(2);
    expect(s.funding?.usd).toBeCloseTo(0.000307, 12);
    expect(s.fees.networkZat).toBe(15_000n);
    expect(s.fees.networkUsd).toBeCloseTo(0.00015 * 1225.2, 12);
    expect(s.fees.tradeUsd).toBe(0.005518);
    expect(s.fees.swapUsd).toBeCloseTo(0.0093 * 1225.2 - 11.020977, 9);
    expect(s.fees.totalUsd).toBeCloseTo(0.00015 * 1225.2 + 0.005518 + 0.0093 * 1225.2 - 11.020977, 9);
    expect(s.payouts).toEqual({ usd: 0, count: 0, byPeriod: [], byPayee: [], byAsset: [] });
  });

  it('divides the value by the monthly burn', () => {
    expect(s.runwayMonths).toBeCloseTo(NAV_NOW / 4, 9);
    expect(statementOf(realHistory(), { monthlyBurnUsd: null }).runwayMonths).toBeNull();
    expect(statementOf(realHistory(), { monthlyBurnUsd: 0 }).runwayMonths).toBeNull();
  });

  it('has nothing stale and nothing unpriced', () => {
    expect(s.stale).toEqual([]);
    expect(s.unpriced).toEqual([]);
    expect(s).toMatchObject({ asOf: NOW, range: { from: null, to: null }, staleAfterMs: POLICY.maxDataAgeMs, seriesStep: 'day', monthlyBurnUsd: 4 });
  });
});

describe('conservation', () => {
  it('accounts for the balance: received, less swapped, paid and fees', () => {
    for (const [history, now] of [[realHistory(), NOW], [historyWithPayouts(), PAYOUTS_NOW]] as const) {
      const s = statementOf(history, { now });
      const ledger = buildLedger(history.records);
      const held = history.records.notes.filter((n) => !n.spent).reduce((sum, n) => sum + n.zat, 0n);
      expect(s.treasury?.zat).toBe(held);
      expect(s.treasury?.zat).toBe(sumAmounts(ledger.filter(isTreasuryZec)));
      expect(s.receipts!.zat - s.swapped!.zat - s.payments!.zat - s.fees.networkZat!).toBe(held);
    }
  });

  it('reports totals that are the sums of the ledger', () => {
    const history = historyWithPayouts();
    const ledger = buildLedger(history.records);
    const s = statementOf(history, { now: PAYOUTS_NOW });
    const usdOf = (kind: LedgerEntry['kind']) => ledger.filter((e) => e.kind === kind).reduce((sum, e) => sum + (e.usd ?? Number.NaN), 0);

    expect(s.funding?.usd).toBeCloseTo(usdOf('funding'), 12);
    expect(s.fees.tradeUsd).toBeCloseTo(-usdOf('trade_fee'), 12);
    expect(s.fees.networkUsd).toBeCloseTo(-usdOf('network_fee'), 12);
    expect(s.payouts?.usd).toBeCloseTo(-usdOf('payout'), 9);
    expect(s.payouts?.count).toBe(ledger.filter((e) => e.kind === 'payout').length);

    const sum = (rows: { usd: number | null }[]) => rows.reduce((total, row) => total + (row.usd ?? Number.NaN), 0);
    expect(sum(s.payouts!.byPeriod)).toBeCloseTo(s.payouts!.usd!, 9);
    expect(sum(s.payouts!.byPayee)).toBeCloseTo(s.payouts!.usd!, 9);
    expect(s.payouts!.byAsset.reduce((total, row) => total + row.amount, 0n)).toBe(-sumAmounts(ledger.filter((e) => e.kind === 'payout')));
  });
});

describe('payouts', () => {
  const s = statementOf(historyWithPayouts(), { now: PAYOUTS_NOW });

  it('groups them by month, by payee and by token', () => {
    expect(s.payouts).toEqual({
      usd: 875.5,
      count: 3,
      byPeriod: [
        { period: '2026-10', usd: 750, count: 2 },
        { period: '2026-11', usd: 125.5, count: 1 },
      ],
      byPayee: [
        { payee: 'Ada Reyes', addresses: ['0x8ba1f109551bD432803012645Ac136ddd64DBA72', '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'], usd: 575.5, count: 2 },
        { payee: 'Kofi Mensah', addresses: ['0x2546BcD3c84621e976D8185a91A922aE77ECEc30'], usd: 300, count: 1 },
      ],
      byAsset: [
        { chain: 'solana', asset: 'USDC', decimals: 6, amount: 125_500_000n },
        { chain: 'tempo', asset: 'pathUSD', decimals: 6, amount: 750_000_000n },
      ],
    });
  });

  it('limits the period figures to the range asked for', () => {
    const october = statementOf(historyWithPayouts(), { now: PAYOUTS_NOW, range: { from: Date.parse('2026-10-10T00:00:00Z'), to: Date.parse('2026-10-31T23:59:59Z') } });
    expect(october.payouts).toMatchObject({ usd: 750, count: 2, byPeriod: [{ period: '2026-10', usd: 750, count: 2 }] });
    expect(october.receipts).toMatchObject({ zat: 250_000_000n, count: 1 });
    expect(october.funding).toEqual({ usd: 0, count: 0 });
    expect(october.fees.networkZat).toBe(10_000n);
    expect(october.series.map((p) => p.seq)).toEqual([6]);
    // The balance is what the treasury holds now, whatever period is reported on.
    expect(october.treasury?.zat).toBe(s.treasury?.zat);
  });

  it('leaves a total unknown when one of its payouts has no dollar value', () => {
    const history = historyWithPayouts();
    const unlisted = { ...tempoRun, token: '0x1111111111111111111111111111111111111111' };
    const partial = statementOf({ ...history, records: { ...history.records, payoutRuns: [unlisted, solanaRun] } }, { now: PAYOUTS_NOW });
    expect(partial.payouts).toMatchObject({ usd: null, count: 3 });
    expect(partial.payouts?.byPeriod).toEqual([
      { period: '2026-10', usd: null, count: 2 },
      { period: '2026-11', usd: 125.5, count: 1 },
    ]);
    expect(partial.unpriced).toEqual(['payout:HF-2026-10-0001:1', 'payout:HF-2026-10-0001:2']);
  });
});

describe('unpriced entries', () => {
  it('names them and leaves the totals they belong to unknown', () => {
    const history = realHistory();
    const s = statementOf({ ...history, records: { ...history.records, prices: history.records.prices.slice(1) } });
    expect(s.unpriced).toEqual([`zcash:${history.records.notes[0]?.id}`]);
    expect(s.receipts).toEqual({ zat: 1_975_000n, usd: null, count: 1 });
    expect(s.fees.networkUsd).not.toBeNull();
  });

  it('cannot cost a swap whose deposit has no price', () => {
    const history = realHistory();
    const s = statementOf({ ...history, records: { ...history.records, prices: [] } });
    expect(s.fees).toMatchObject({ networkZat: 15_000n, networkUsd: null, tradeUsd: 0.005518, swapUsd: null, totalUsd: null });
  });
});

describe('sources that are stale or missing', () => {
  it('reports nothing current once the journal has stopped', () => {
    const s = statementOf(realHistory(), { now: NOW + 10 * MINUTE });
    expect(s.stale.map((x) => x.source)).toEqual(['journal', 'zcash', 'hyperliquid', 'reference']);
    expect(s.stale[0]).toEqual({ source: 'journal', asOf: lastTick.at, detail: 'the last entry is 630 s old, over the 180 s allowed' });
    expect(s.treasury).toEqual({ zat: null, untrackedZat: null, asOf: lastTick.at, px: null, pxAt: null, usd: null });
    expect(s.hedge).toBeNull();
    expect(s.runwayMonths).toBeNull();
    expect(s.lock).toMatchObject({ lockedSeq: 3, navNowUsd: null, externalFlowsUsd: null, driftUsd: null, unhedgedNowUsd: null, unhedgedDriftUsd: null });
    expect(s.lock?.navAtLockUsd).toBeCloseTo(NAV_AT_LOCK, 9);
    // What the ledger records is not a reading and stays.
    expect(s.receipts?.zat).toBe(1_975_000n);
    expect(s.fees.networkZat).toBe(15_000n);
  });

  it('accepts a longer allowance when given one', () => {
    const s = statementOf(realHistory(), { now: NOW + 10 * MINUTE, staleAfterMs: 15 * MINUTE });
    expect(s.stale).toEqual([]);
    expect(s.treasury?.zat).toBe(1_030_000n);
    expect(s.staleAfterMs).toBe(15 * MINUTE);
  });

  it('drops the hedge when the venue stops answering, and keeps the treasury', () => {
    const dark = [4, 5, 6, 7].map((minutes) => ({ at: lastTick.at + minutes * MINUTE, treasury: { zat: 1_030_000n, scannedTo: 3_512_720 + minutes }, venue: null }));
    const history = { ...realHistory(), journal: journalOf([...realTicks, ...dark]) };
    const s = statementOf(history, { now: lastTick.at + 7 * MINUTE + 5_000 });

    expect(s.stale.map((x) => x.source)).toEqual(['hyperliquid', 'reference']);
    expect(s.stale[0]).toMatchObject({ asOf: lastTick.at });
    expect(s.hedge).toBeNull();
    expect(s.treasury).toMatchObject({ zat: 1_030_000n, px: null, usd: null });
    expect(s.lock).toMatchObject({ lockedSeq: 3, navNowUsd: null, driftUsd: null });
    expect(s.runwayMonths).toBeNull();
  });

  it('still uses a venue reading from a tick or two ago', () => {
    const blip = { at: lastTick.at + MINUTE, treasury: { zat: 1_030_000n, scannedTo: 3_512_712 }, venue: null };
    const s = statementOf({ ...realHistory(), journal: journalOf([...realTicks, blip]) }, { now: lastTick.at + MINUTE + 5_000 });
    expect(s.stale).toEqual([]);
    expect(s.hedge).toMatchObject({ asOf: lastTick.at, shortLots: 1 });
    expect(s.lock?.navNowUsd).toBeCloseTo(NAV_NOW, 9);
  });

  it('values the treasury at the reference price when only the venue is gone', () => {
    const journal = structuredClone(realHistory().journal);
    journal.at(-1)!.snapshot.hl = null;
    const s = statementOf({ ...realHistory(), journal }, { now: lastTick.at + 4 * MINUTE, staleAfterMs: 5 * MINUTE });
    journal.at(-2)!.snapshot.hl = null;
    const gone = statementOf({ ...realHistory(), journal }, { now: lastTick.at + MINUTE });
    expect(s.hedge).toBeNull();
    expect(gone.stale.map((x) => x.source)).toEqual(['hyperliquid']);
    expect(gone.treasury).toMatchObject({ px: 1228.6, pxAt: lastTick.at, usd: 0.0103 * 1228.6 });
  });

  it('names every source when there is no journal at all', () => {
    const s = statementOf({ ...realHistory(), journal: [] });
    expect(s.stale).toEqual([
      { source: 'journal', asOf: null, detail: 'the journal holds no entry' },
      { source: 'zcash', asOf: null, detail: 'the journal holds no treasury reading' },
      { source: 'hyperliquid', asOf: null, detail: 'the journal holds no venue reading' },
      { source: 'reference', asOf: null, detail: 'the journal holds no reference price' },
    ]);
    expect(s.treasury).toEqual({ zat: null, untrackedZat: null, asOf: null, px: null, pxAt: null, usd: null });
    expect(s.hedge).toBeNull();
    expect(s.lock).toBeNull();
    expect(s.series).toEqual([]);
    expect(s.receipts?.zat).toBe(1_975_000n);
  });

  it('does not take a reading dated after the statement for a fresh one', () => {
    const s = statementOf(realHistory(), { now: lastTick.at - 10 * MINUTE });
    expect(s.stale.map((x) => x.detail)).toContain('the last venue reading is dated after the statement');
    expect(s.hedge).toBeNull();
  });

  it('refuses a venue reading that makes no sense', () => {
    const journal = structuredClone(realHistory().journal);
    journal.at(-1)!.snapshot.hl!.markPx = 0;
    const s = statementOf({ ...realHistory(), journal });
    expect(s.hedge).toBeNull();
    expect(s.stale).toEqual([{ source: 'hyperliquid', asOf: lastTick.at, detail: 'the last venue reading is malformed' }]);
  });
});

describe('the series', () => {
  it('has one point per journal entry when asked', () => {
    const s = statementOf(realHistory(), { seriesStep: 'entry' });
    expect(s.series.map((p) => [p.seq, p.t, p.px])).toEqual(realTicks.map((tick, i) => [i + 1, tick.at, tick.venue!.markPx]));

    const [received, inTransit, locking, locked] = s.series;
    // Before the lock nothing is hedged, so the two lines are one.
    expect(received?.lockedUsd).toBeCloseTo(0.01975 * 1219.8, 9);
    expect(received?.unhedgedUsd).toBe(received?.lockedUsd);
    // The deposit has left and the swap has not arrived: the value in transit is in neither leg.
    expect(inTransit?.lockedUsd).toBeCloseTo(0.0103 * 1225.6, 9);
    expect(locking?.lockedUsd).toBeCloseTo(NAV_AT_LOCK, 9);
    expect(locking?.unhedgedUsd).toBe(locking?.lockedUsd);
    expect(locked?.unhedgedUsd).toBeCloseTo((NAV_AT_LOCK / 1227.1) * 1227.0, 9);
    expect(locked?.lockedUsd).toBeCloseTo(0.0103 * 1227.0 + realTicks[3]!.venue!.equity, 9);
  });

  it('keeps the last point of each UTC day by default', () => {
    const nextDay = [
      { at: Date.parse('2026-10-09T23:59:00Z'), treasury: { zat: 1_030_000n, scannedTo: 3_513_000 }, venue: { markPx: 1230, shortLots: 1, equity: 10.98 } },
      { at: Date.parse('2026-10-10T00:00:00Z'), treasury: { zat: 1_030_000n, scannedTo: 3_513_001 }, venue: { markPx: 1231, shortLots: 1, equity: 10.97 } },
      { at: Date.parse('2026-10-10T08:00:00Z'), treasury: { zat: 1_030_000n, scannedTo: 3_513_400 }, venue: { markPx: 1215, shortLots: 1, equity: 11.13 } },
    ];
    const s = statementOf({ ...realHistory(), journal: journalOf([...realTicks, ...nextDay]) }, { now: Date.parse('2026-10-10T08:00:30Z') });
    expect(s.series.map((p) => [p.seq, p.px])).toEqual([
      [6, 1230],
      [8, 1215],
    ]);
    const firstDayOnly = statementOf({ ...realHistory(), journal: journalOf([...realTicks, ...nextDay]) }, { now: Date.parse('2026-10-10T08:00:30Z'), range: { from: null, to: Date.parse('2026-10-09T23:59:59Z') } });
    expect(firstDayOnly.series.map((p) => p.seq)).toEqual([6]);
  });

  it('leaves a gap where a leg could not be read', () => {
    const blind = { at: lastTick.at + MINUTE, treasury: null, venue: { markPx: 1229, shortLots: 1, equity: 11.0 } };
    const s = statementOf({ ...realHistory(), journal: journalOf([...realTicks, blind]) }, { now: lastTick.at + MINUTE, seriesStep: 'entry' });
    expect(s.series.at(-1)).toMatchObject({ seq: 6, px: 1229, lockedUsd: null });
    expect(s.series.at(-1)?.unhedgedUsd).toBeCloseTo((NAV_AT_LOCK / 1227.1) * 1229, 9);
  });
});

describe('money arriving and leaving after the lock', () => {
  const T = Date.parse('2026-08-03T09:00:00Z');
  const ZEC = 100_000_000n;
  const note = (name: string, height: number, time: number, zat: bigint, over: Partial<OwnedNote> = {}): OwnedNote => ({
    id: `${name}:orchard:0`,
    txid: name,
    height,
    time,
    zat,
    memo: '',
    pool: 'orchard',
    kind: 'incoming',
    nullifier: `nf-${name}`,
    spent: false,
    ...over,
  });
  const floatDeposit: OutgoingPayment = { id: 'spend:transparent', txid: 'spend', height: 120, time: T + 150_000, zat: 2n * ZEC, memo: '', pool: 'transparent' };
  const floatSwap: SwapRecord = {
    id: 'float-1',
    purpose: 'payout_float',
    originAsset: ZEC_ID,
    destinationAsset: USDC_SOLANA_ID,
    amountIn: 2n * ZEC,
    minAmountOut: 2_100_000_000n,
    amountOut: 2_150_000_000n,
    depositAddress: 't1deposit',
    recipient: 'team-solana-account',
    state: 'SUCCESS',
    originTxs: [],
    destinationTxs: ['sol-tx'],
    createdAt: T + 140_000,
    updatedAt: T + 160_000,
  };
  const run = { ...tempoRun, id: 'RUN-1', chain: 'solana' as const, token: 'usdc-mint', total: 1_100_000_000n, executedAt: T + 170_000, lines: [{ ...tempoRun.lines[0]!, amount: 1_100_000_000n, memo: 'RUN-1/1' }] };

  const ledger = buildLedger({
    notes: [
      note('grant-a', 100, T - HOUR, 100n * ZEC),
      note('grant-b', 110, T + 100_000, 10n * ZEC, { spent: true }),
      note('spend', 120, T + 150_000, 799_990_000n, { kind: 'change' }),
    ],
    outgoing: [floatDeposit],
    fees: [{ txid: 'spend', zat: 10_000n, height: 120 }],
    swaps: [floatSwap],
    payoutRuns: [run],
    prices: [
      { ts: T - HOUR, px: 1000 },
      { ts: T + 90_000, px: 1100 },
    ],
    assets: { 'usdc-mint': { symbol: 'USDC', decimals: 6, chain: 'solana', usdPegged: true } },
  });

  const journal = journalOf([
    // 100 ZEC and $5,000 of margin: two-times leverage carries 1,000 of the 10,000 lots, and the lock opens with those.
    {
      at: T,
      treasury: { zat: 100n * ZEC, scannedTo: 105 },
      venue: { markPx: 1000, shortLots: 0, equity: 5_000 },
      fill: { cloid: CLOID, result: { ok: true, filledLots: 1_000, avgPx: 1000, oid: '1', error: null } },
    },
    { at: T + MINUTE, treasury: { zat: 100n * ZEC, scannedTo: 106 }, venue: { markPx: 1000, shortLots: 1_000, equity: 5_000 } },
    // 10 ZEC arrive and the price is up 10%: the short of 10 ZEC has lost $1,000.
    { at: T + 2 * MINUTE, treasury: { zat: 110n * ZEC, scannedTo: 112 }, venue: { markPx: 1100, shortLots: 1_000, equity: 4_000 } },
    // 2 ZEC were swapped into $2,150 of float, and $1,100 of it was paid out.
    { at: T + 3 * MINUTE, treasury: { zat: 10_799_990_000n, scannedTo: 121 }, venue: { markPx: 1100, shortLots: 1_000, equity: 4_000 } },
  ]);

  /** The statement as it stood after each tick, from the ledger as it stood then. */
  const at = (minutes: number) => {
    const now = T + minutes * MINUTE;
    return buildStatement({ ledger: ledger.filter((e) => e.ts <= now), journal: journal.slice(0, minutes + 1), policy: POLICY, now, monthlyBurnUsd: 10_000, seriesStep: 'entry' });
  };

  it('starts with no drift at the entry that opened the lock', () => {
    expect(at(0).lock).toEqual({
      lockedAt: T,
      lockedSeq: 1,
      navAtLockUsd: 105_000,
      navNowUsd: 105_000,
      externalFlowsUsd: 0,
      driftUsd: 0,
      unhedgedNowUsd: 105_000,
      unhedgedDriftUsd: 0,
    });
  });

  it('does not count a receipt as drift', () => {
    const { lock, hedge, treasury } = at(2);
    expect(lock).toMatchObject({ navAtLockUsd: 105_000, navNowUsd: 125_000, externalFlowsUsd: 11_000 });
    // 90 of the 100 ZEC were unhedged and gained $100 each.
    expect(lock?.driftUsd).toBeCloseTo(9_000, 6);
    // Unhedged, all 105 ZEC-worth would have gained.
    expect(lock?.unhedgedNowUsd).toBeCloseTo(126_500, 6);
    expect(lock?.unhedgedDriftUsd).toBeCloseTo(10_500, 6);
    expect(hedge).toMatchObject({ shortLots: 1_000, targetLots: 11_000, coverageBps: 909, marginRatioBps: 3_636 });
    expect(treasury?.zat).toBe(110n * ZEC);
  });

  it('does not count a payout as drift, and counts the float as value', () => {
    const s = at(3);
    // 107.9999 ZEC, $4,000 on the venue and $1,050 of float left.
    expect(s.lock?.navNowUsd).toBeCloseTo(107.9999 * 1100 + 4_000 + 1_050, 6);
    expect(s.lock?.externalFlowsUsd).toBeCloseTo(11_000 - 1_100, 9);
    // What the swap and the network fee cost is the only change since: $50 and $0.11.
    expect(s.lock?.driftUsd).toBeCloseTo(9_000 - 50 - 0.11, 6);
    // Unhedged, the payout would have cost one ZEC at $1,100.
    expect(s.lock?.unhedgedNowUsd).toBeCloseTo(114 * 1100, 6);
    expect(s.lock?.unhedgedDriftUsd).toBeCloseTo(10_500, 6);
    expect(s.runwayMonths).toBeCloseTo((107.9999 * 1100 + 5_050) / 10_000, 9);
    expect(s.fees.swapUsd).toBeCloseTo(50, 9);
    expect(s.series.map((p) => Math.round(p.lockedUsd ?? Number.NaN))).toEqual([105_000, 105_000, 125_000, 123_850]);
  });

  it('reports no lock once the short has been bought back in full', () => {
    const closed = journalOf([
      { at: T, treasury: { zat: 100n * ZEC, scannedTo: 105 }, venue: { markPx: 1000, shortLots: 0, equity: 5_000 }, fill: { cloid: CLOID, result: { ok: true, filledLots: 1_000, avgPx: 1000, oid: '1', error: null } } },
      { at: T + MINUTE, treasury: { zat: 100n * ZEC, scannedTo: 106 }, venue: { markPx: 1000, shortLots: 1_000, equity: 5_000 } },
      { at: T + 2 * MINUTE, treasury: { zat: 100n * ZEC, scannedTo: 107 }, venue: { markPx: 1000, shortLots: 0, equity: 5_000 } },
    ]);
    const s = buildStatement({ ledger, journal: closed, policy: { ...POLICY, hedgeRatioBps: 0 }, now: T + 2 * MINUTE, monthlyBurnUsd: null, seriesStep: 'entry' });
    expect(s.lock).toBeNull();
    expect(s.series.map((p) => p.unhedgedUsd === p.lockedUsd)).toEqual([true, true, true]);
    expect(s.hedge).toMatchObject({ shortLots: 0, marginRatioBps: null, targetLots: 0, coverageBps: null });
  });
});
