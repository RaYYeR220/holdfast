import type { OwnedNote } from '@holdfast/core';
import { describe, expect, it } from 'vitest';
import { buildLedger, type HedgeFill, isReceipt, isTreasuryZec, type LedgerEntry, sumAmounts } from '../src/index';
import {
  ARRIVAL_TX,
  CLOID,
  DEPOSIT_ADDRESS,
  FILL_TIME,
  GRANT_MEMO,
  HL_ACCOUNT,
  OID,
  RECEIPT_HEIGHT,
  RECEIPT_TIME,
  RECEIPT_TX,
  SPEND_HEIGHT,
  SPEND_TIME,
  SPEND_TX,
  SWAP_ID,
  changeNote,
  deposit,
  historyWithPayouts,
  marginSwap,
  openShort,
  realHistory,
  receiptNote,
  solanaRun,
  tempoRun,
} from './fixtures';

const ledger = () => buildLedger(realHistory().records);
const find = (entries: LedgerEntry[], id: string) => {
  const entry = entries.find((e) => e.id === id);
  if (entry === undefined) throw new Error(`no entry ${id}`);
  return entry;
};

const RECEIPT_ID = `zcash:${receiptNote.id}`;
const CHANGE_ID = `zcash:${changeNote.id}`;
const DEPOSIT_ID = `zcash:${deposit.id}`;
const FEE_ID = `zcash:${SPEND_TX}:fee`;
const ARRIVAL_ID = `swap:${SWAP_ID}:in`;
const FILL_ID = `hl:fill:${OID}:${openShort.tid}`;
const FILL_FEE_ID = `hl:fee:${OID}:${openShort.tid}`;

describe('the demo treasury on mainnet', () => {
  it('books the day in the order it happened', () => {
    expect(ledger().map((e) => [e.source, e.kind, e.asset, e.amount])).toEqual([
      ['zcash', 'receipt', 'ZEC', 1_975_000n],
      ['zcash', 'change', 'ZEC', 0n],
      ['zcash', 'swap_out', 'ZEC', -930_000n],
      ['zcash', 'network_fee', 'ZEC', -15_000n],
      ['swap', 'swap_in', 'USDC', 1_102_097_700n],
      ['hyperliquid', 'hedge_open', 'ZEC-PERP', -1_000_000n],
      ['hyperliquid', 'trade_fee', 'USDC', -551_800n],
      ['hyperliquid', 'funding', 'USDC', 15_300n],
      ['hyperliquid', 'funding', 'USDC', 15_400n],
    ]);
  });

  it('records the grant with its memo, its price and where to check it', () => {
    expect(find(ledger(), RECEIPT_ID)).toEqual({
      id: RECEIPT_ID,
      ts: RECEIPT_TIME,
      source: 'zcash',
      kind: 'receipt',
      asset: 'ZEC',
      decimals: 8,
      amount: 1_975_000n,
      usd: 0.01975 * 1219.5,
      usdPrice: 1219.5,
      usdPriceAt: Date.parse('2026-10-09T10:00:00Z'),
      ref: GRANT_MEMO,
      counterparty: null,
      proof: { chain: 'zcash', tx: RECEIPT_TX, block: RECEIPT_HEIGHT, url: `https://mainnet.zcashexplorer.app/transactions/${RECEIPT_TX}` },
      linked: [],
    });
  });

  it('does not count change as income', () => {
    const entries = ledger();
    const income = entries.filter(isReceipt);
    expect(income.map((e) => e.id)).toEqual([RECEIPT_ID]);
    expect(sumAmounts(income)).toBe(1_975_000n);
    expect(find(entries, CHANGE_ID)).toMatchObject({ kind: 'change', amount: 0n, usd: 0, usdPrice: null });
  });

  it('nets the spend and its change to what actually left', () => {
    const spend = ledger().filter((e) => e.proof.tx === SPEND_TX);
    expect(spend.map((e) => e.kind).sort()).toEqual(['change', 'network_fee', 'swap_out']);
    expect(sumAmounts(spend)).toBe(-(930_000n + 15_000n));
  });

  it('adds up to what the unspent notes hold', () => {
    const { notes } = realHistory().records;
    const held = notes.filter((n) => !n.spent).reduce((sum, n) => sum + n.zat, 0n);
    expect(held).toBe(1_030_000n);
    expect(sumAmounts(ledger().filter(isTreasuryZec))).toBe(held);
    expect(sumAmounts(ledger().filter((e) => e.asset === 'ZEC'))).toBe(held);
  });

  it('books the deposit as the input of the swap it paid for, not as a payment', () => {
    const entries = ledger();
    expect(entries.some((e) => e.kind === 'payment')).toBe(false);
    expect(find(entries, DEPOSIT_ID)).toMatchObject({
      source: 'zcash',
      kind: 'swap_out',
      amount: -930_000n,
      ref: SWAP_ID,
      counterparty: { name: null, address: DEPOSIT_ADDRESS },
      proof: { chain: 'zcash', tx: SPEND_TX, block: SPEND_HEIGHT },
      linked: [ARRIVAL_ID, CHANGE_ID, FEE_ID].sort(),
    });
    expect(entries.some((e) => e.id === `swap:${SWAP_ID}:out`)).toBe(false);
  });

  it('books the arrival in the units of the chain it arrived on', () => {
    expect(find(ledger(), ARRIVAL_ID)).toMatchObject({
      source: 'swap',
      kind: 'swap_in',
      asset: 'USDC',
      decimals: 8,
      amount: 1_102_097_700n,
      usd: 11.020977,
      usdPrice: 1,
      usdPriceAt: marginSwap.updatedAt,
      ref: SWAP_ID,
      counterparty: { name: null, address: HL_ACCOUNT },
      proof: { chain: 'hyperliquid', tx: ARRIVAL_TX, block: null, url: `https://app.hyperliquid.xyz/explorer/tx/${ARRIVAL_TX}` },
      linked: [DEPOSIT_ID],
    });
  });

  it('books the fill as a position and its fee as cash', () => {
    const entries = ledger();
    const fill = find(entries, FILL_ID);
    expect(fill).toMatchObject({
      ts: FILL_TIME,
      kind: 'hedge_open',
      asset: 'ZEC-PERP',
      decimals: 8,
      amount: -1_000_000n,
      usdPrice: 1226.4,
      usdPriceAt: FILL_TIME,
      ref: CLOID,
      proof: { chain: 'hyperliquid', tx: null, url: null },
      linked: [FILL_FEE_ID],
    });
    expect(fill.usd).toBeCloseTo(-12.264, 9);
    expect(find(entries, FILL_FEE_ID)).toMatchObject({ kind: 'trade_fee', asset: 'USDC', decimals: 8, amount: -551_800n, usd: -0.005518, usdPrice: 1, linked: [FILL_ID] });
  });

  it('prices the spend at the price of its own hour', () => {
    const out = find(ledger(), DEPOSIT_ID);
    expect(out.usdPrice).toBe(1225.2);
    expect(out.usd).toBeCloseTo(-0.0093 * 1225.2, 12);
    expect(find(ledger(), FEE_ID)).toMatchObject({ ts: SPEND_TIME, usdPrice: 1225.2, proof: { block: SPEND_HEIGHT } });
  });
});

describe('ordering and identity', () => {
  it('gives the same ledger whatever order the records come in', () => {
    const { records } = historyWithPayouts();
    const shuffled = {
      ...records,
      notes: [...records.notes].reverse(),
      outgoing: [...records.outgoing].reverse(),
      fees: [...records.fees].reverse(),
      fills: [...records.fills].reverse(),
      funding: [...records.funding].reverse(),
      swaps: [...records.swaps].reverse(),
      payoutRuns: [...records.payoutRuns].reverse(),
      prices: [...records.prices].reverse(),
    };
    expect(buildLedger(shuffled)).toEqual(buildLedger(records));
  });

  it('is sorted by time and gives every entry its own id', () => {
    const entries = buildLedger(historyWithPayouts().records);
    expect(entries.map((e) => e.ts)).toEqual([...entries.map((e) => e.ts)].sort((a, b) => a - b));
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
  });

  it('orders the entries of one transaction the same way every time', () => {
    const spend = ledger().filter((e) => e.ts === SPEND_TIME);
    expect(spend.map((e) => e.kind)).toEqual(['change', 'swap_out', 'network_fee']);
  });

  it('treats a record given twice as one record', () => {
    const { records } = realHistory();
    const twice = { ...records, notes: [...records.notes, receiptNote], fills: [...records.fills, openShort], swaps: [...records.swaps, marginSwap] };
    expect(buildLedger(twice)).toEqual(buildLedger(records));
  });

  it('builds an empty ledger from nothing', () => {
    expect(buildLedger({})).toEqual([]);
  });
});

describe('prices', () => {
  it('leaves an entry unpriced when no price is recent enough, and never uses a later one', () => {
    const { records } = realHistory();
    const late = buildLedger({ ...records, prices: [{ ts: RECEIPT_TIME + 1, px: 1300 }] });
    expect(find(late, RECEIPT_ID)).toMatchObject({ usd: null, usdPrice: null, usdPriceAt: null });

    const old = buildLedger({ ...records, prices: [{ ts: RECEIPT_TIME - 2 * 3_600_000, px: 1300 }] });
    expect(find(old, RECEIPT_ID).usd).toBeNull();
    const allowed = buildLedger({ ...records, prices: [{ ts: RECEIPT_TIME - 2 * 3_600_000, px: 1300 }], priceMaxAgeMs: 3 * 3_600_000 });
    expect(find(allowed, RECEIPT_ID).usdPrice).toBe(1300);
  });

  it('takes a price recorded for the event itself', () => {
    const { records } = realHistory();
    const exact = buildLedger({ ...records, prices: [...records.prices, { ts: RECEIPT_TIME, px: 1221.75 }] });
    expect(find(exact, RECEIPT_ID)).toMatchObject({ usdPrice: 1221.75, usdPriceAt: RECEIPT_TIME });
  });

  it('ignores prices that are not prices', () => {
    const { records } = realHistory();
    const junk = buildLedger({ ...records, prices: [{ ts: RECEIPT_TIME, px: 0 }, { ts: RECEIPT_TIME, px: Number.NaN }, { ts: RECEIPT_TIME, px: -4 }] });
    expect(find(junk, RECEIPT_ID).usd).toBeNull();
  });
});

describe('zcash records', () => {
  const sapling: OwnedNote = { ...receiptNote, id: `${'6b'.repeat(32)}:sapling:0`, txid: '6b'.repeat(32), pool: 'sapling', nullifier: null, spent: false, zat: 400_000n };

  it('marks a receipt the viewing key cannot follow', () => {
    const entries = buildLedger({ notes: [sapling] });
    expect(entries.map((e) => [e.kind, e.amount])).toEqual([['receipt_untracked', 400_000n]]);
    expect(isReceipt(entries[0] as LedgerEntry)).toBe(true);
  });

  it('does not count a note the treasury sent to itself as income', () => {
    // The grant note is spent into a note at the treasury's own address, with change and a fee.
    const tx = 'ad'.repeat(32);
    const toSelf: OwnedNote = { ...receiptNote, id: `${tx}:orchard:self`, txid: tx, height: SPEND_HEIGHT, time: SPEND_TIME, zat: 1_000_000n, memo: 'to the new address', nullifier: 'b1'.repeat(32), spent: false };
    const change: OwnedNote = { ...changeNote, id: `${tx}:orchard:change`, txid: tx, zat: 965_000n };
    const entries = buildLedger({ notes: [receiptNote, toSelf, change], fees: [{ txid: tx, zat: 10_000n, height: SPEND_HEIGHT }] });

    expect(entries.map((e) => [e.kind, e.amount])).toEqual([
      ['receipt', 1_975_000n],
      ['change', 0n],
      ['change', 0n],
      ['network_fee', -10_000n],
    ]);
    expect(sumAmounts(entries)).toBe(toSelf.zat + change.zat);
    expect(sumAmounts(entries.filter(isReceipt))).toBe(1_975_000n);
  });

  it('books a payment to somebody else as a payment, with its memo', () => {
    const invoice = { ...deposit, id: `${SPEND_TX}:orchard:${'d1'.repeat(32)}`, pool: 'orchard' as const, memo: 'Invoice 14', zat: 400_000n };
    const entries = buildLedger({ outgoing: [invoice] });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'payment', amount: -400_000n, ref: 'Invoice 14', counterparty: null });
  });

  it('dates a fee by its transaction, or by the nearest block it knows when the transaction left nothing else', () => {
    const orphan = { txid: 'ee'.repeat(32), zat: 10_000n, height: SPEND_HEIGHT + 3 };
    const entries = buildLedger({ notes: [receiptNote, changeNote], fees: [orphan] });
    expect(find(entries, `zcash:${orphan.txid}:fee`)).toMatchObject({ ts: SPEND_TIME, amount: -10_000n, proof: { block: SPEND_HEIGHT + 3 }, linked: [] });

    const timed = buildLedger({ fees: [{ txid: 'ee'.repeat(32), zat: 10_000n, time: 1_791_000_000_000 }] });
    expect(timed[0]).toMatchObject({ ts: 1_791_000_000_000, proof: { block: null } });
  });
});

describe('swaps', () => {
  it('books the input from the swap record when the treasury shows no deposit for it', () => {
    const { records } = realHistory();
    const entries = buildLedger({ ...records, outgoing: [] });
    const out = find(entries, `swap:${SWAP_ID}:out`);
    expect(out).toMatchObject({ source: 'swap', kind: 'swap_out', asset: 'ZEC', amount: -930_000n, ref: SWAP_ID, proof: { chain: 'zcash', tx: SPEND_TX }, linked: [ARRIVAL_ID] });
    expect(find(entries, ARRIVAL_ID).linked).toEqual([out.id]);
  });

  it('books nothing for a quote nobody paid into', () => {
    const quoted = { ...marginSwap, state: 'PENDING_DEPOSIT', amountOut: null, originTxs: [], destinationTxs: [] };
    expect(buildLedger({ swaps: [quoted] })).toEqual([]);
  });

  it('books only the input while a swap is still on its way', () => {
    const { records } = realHistory();
    const pending = { ...marginSwap, state: 'PROCESSING', amountOut: null, destinationTxs: [] };
    const entries = buildLedger({ ...records, swaps: [pending] });
    expect(find(entries, DEPOSIT_ID)).toMatchObject({ kind: 'swap_out', linked: [CHANGE_ID, FEE_ID].sort() });
    expect(entries.some((e) => e.kind === 'swap_in')).toBe(false);
  });

  it('keeps an asset it does not know in raw units and without a dollar value', () => {
    const exotic = { ...marginSwap, destinationAsset: 'nep141:eth.omft.near', amountOut: 5_000n };
    const arrival = find(buildLedger({ swaps: [exotic] }), ARRIVAL_ID);
    expect(arrival).toMatchObject({ asset: 'nep141:eth.omft.near', decimals: 0, amount: 5_000n, usd: null, proof: { chain: 'unknown', url: null } });
  });

  it('is not fooled by an asset id that names a built-in property', () => {
    const odd = { ...marginSwap, destinationAsset: 'constructor', amountOut: 7n };
    expect(find(buildLedger({ swaps: [odd] }), ARRIVAL_ID)).toMatchObject({ asset: 'constructor', decimals: 0, usd: null });
  });
});

describe('hedge records', () => {
  const close: HedgeFill = { ...openShort, side: 'buy', direction: 'Close Short', px: 1210.0, closedPnlUsd: 0.164, fee: -0.000242, tid: '318274650999999', hash: '0xfeed' };

  it('books a closing fill with its realised profit and a rebate as money in', () => {
    const entries = buildLedger({ fills: [close] });
    expect(entries.map((e) => [e.kind, e.asset, e.amount])).toEqual([
      ['hedge_close', 'ZEC-PERP', 1_000_000n],
      ['realized_pnl', 'USDC', 16_400_000n],
      ['trade_fee', 'USDC', 24_200n],
    ]);
    expect(entries[0]?.proof).toEqual({ chain: 'hyperliquid', tx: '0xfeed', block: null, url: 'https://app.hyperliquid.xyz/explorer/tx/0xfeed' });
    expect(entries[0]?.linked).toHaveLength(2);
  });

  it('falls back on the side when the venue label says neither open nor close', () => {
    const odd = buildLedger({ fills: [{ ...openShort, direction: 'Short > Long', side: 'buy' }] });
    expect(odd[0]?.kind).toBe('hedge_close');
  });

  it('leaves a fee charged in another token without a dollar value', () => {
    const entries = buildLedger({ fills: [{ ...openShort, feeToken: 'HYPE' }] });
    expect(entries.find((e) => e.kind === 'trade_fee')).toMatchObject({ asset: 'HYPE', usd: null, usdPrice: null });
  });

  it('keeps a fill without a client order id', () => {
    const manual = buildLedger({ fills: [{ ...openShort, cloid: null }] });
    expect(manual[0]).toMatchObject({ kind: 'hedge_open', ref: '' });
  });
});

describe('payouts', () => {
  const entries = () => buildLedger(historyWithPayouts().records);

  it('books one entry per paid line, in the token of its chain', () => {
    const payouts = entries().filter((e) => e.kind === 'payout');
    expect(payouts.map((e) => [e.id, e.source, e.asset, e.decimals, e.amount, e.usd, e.ref, e.counterparty?.name])).toEqual([
      ['payout:HF-2026-10-0001:1', 'tempo', 'pathUSD', 6, -450_000_000n, -450, 'HF-2026-10-0001/1', 'Ada Reyes'],
      ['payout:HF-2026-10-0001:2', 'tempo', 'pathUSD', 6, -300_000_000n, -300, 'HF-2026-10-0001/2', 'Kofi Mensah'],
      ['payout:HF-2026-11-0001:1', 'solana', 'USDC', 6, -125_500_000n, -125.5, 'October retainer', 'Ada Reyes'],
    ]);
    expect(payouts[0]?.proof).toEqual({ chain: 'tempo', tx: tempoRun.tx, block: null, url: `https://explore.tempo.xyz/tx/${tempoRun.tx}` });
    expect(payouts[2]?.ts).toBe(solanaRun.executedAt);
  });

  it('books nothing for a run that has not been paid', () => {
    for (const status of ['draft', 'approved', 'sending', 'failed', 'refused']) {
      expect(buildLedger({ payoutRuns: [{ ...tempoRun, status }] })).toEqual([]);
    }
  });

  it('keeps a token it does not know in raw units and without a dollar value', () => {
    const [line] = buildLedger({ payoutRuns: [tempoRun] });
    expect(line).toMatchObject({ asset: tempoRun.token, decimals: 0, amount: -450_000_000n, usd: null });
  });

  it('keeps the two swaps and their deposits apart', () => {
    const swaps = entries().filter((e) => e.kind === 'swap_out' || e.kind === 'swap_in');
    expect(swaps.map((e) => [e.source, e.kind, e.asset, e.decimals, e.amount])).toEqual([
      ['zcash', 'swap_out', 'ZEC', 8, -930_000n],
      ['swap', 'swap_in', 'USDC', 8, 1_102_097_700n],
      ['zcash', 'swap_out', 'ZEC', 8, -100_000_000n],
      ['swap', 'swap_in', 'USDC', 6, 1_201_350_000n],
    ]);
  });
});
