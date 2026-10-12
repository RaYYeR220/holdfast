import { describe, expect, it } from 'vitest';
import { accountsFor, deliveredText, formatUnits, looksTransparent, purposeWords, readZec, swapWords, withFees, zecText } from '../../src/app/_sections/treasury/figures';
import { quoteCostUsd, readFunding } from '../../src/app/_sections/treasury/funding';

describe('amounts in base units', () => {
  it('writes them as decimals with separators and at least two decimals', () => {
    expect(formatUnits(1_102_097_700n, 8)).toBe('11.020977');
    expect(formatUnits('750000', 6)).toBe('0.75');
    expect(formatUnits(2_500_000_000n, 6)).toBe('2,500.00');
    expect(formatUnits(1n, 6)).toBe('0.000001');
    expect(formatUnits(-1_500_000n, 6)).toBe('−1.50');
    expect(formatUnits(42n, 0)).toBe('42');
  });

  it('writes zatoshi as ZEC with every digit the amount has and none it has not', () => {
    expect(zecText(1_975_000n)).toBe('0.01975');
    expect(zecText('930000')).toBe('0.0093');
    expect(zecText(100_000_000n)).toBe('1');
    expect(zecText(123_456_789_012n)).toBe('1,234.56789012');
  });

  it('reads an amount of ZEC as a treasurer types it', () => {
    expect(readZec('0.5')).toEqual({ ok: true, zat: 50_000_000n });
    expect(readZec(' 0,0093 ')).toEqual({ ok: true, zat: 930_000n });
    expect(readZec('12')).toEqual({ ok: true, zat: 1_200_000_000n });
    expect(readZec('0.00000001')).toEqual({ ok: true, zat: 1n });
  });

  it('refuses what is not an amount, and says why', () => {
    expect(readZec('')).toEqual({ ok: false, error: 'An amount is needed.' });
    expect(readZec('abc')).toMatchObject({ ok: false });
    expect(readZec('1e3')).toMatchObject({ ok: false });
    expect(readZec('-1')).toMatchObject({ ok: false });
    expect(readZec('0')).toEqual({ ok: false, error: 'The amount has to be more than zero.' });
    expect(readZec('0.000000001')).toEqual({ ok: false, error: 'ZEC has eight decimals at most.' });
    expect(readZec('21000001')).toEqual({ ok: false, error: 'That is more ZEC than exists.' });
  });

  it('tells a transparent address from the others by its shape', () => {
    expect(looksTransparent('t1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC')).toBe(true);
    expect(looksTransparent(`u1${'q'.repeat(70)}`)).toBe(false);
    expect(looksTransparent('t1short')).toBe(false);
    expect(looksTransparent('0xC7e7BAAFb0C822d0A934BbB2268F15A7eD8485bc')).toBe(false);
  });
});

describe('what the rows add up to', () => {
  it('accounts for the balance when received, less sent and fees, is what is held', () => {
    expect(accountsFor({ receivedZat: 1_975_000n, sentZat: 930_000n, feesZat: 15_000n }, 1_030_000n)).toBe(true);
    expect(accountsFor({ receivedZat: 1_975_000n, sentZat: 930_000n, feesZat: 15_000n }, 1_030_001n)).toBe(false);
    expect(accountsFor({ receivedZat: 0n, sentZat: 0n, feesZat: 0n }, 0n)).toBe(true);
  });

  it('puts each fee beside the first payment of its transaction and returns the others apart', () => {
    const sent = [
      { id: 'a:0', txid: 'a' },
      { id: 'a:1', txid: 'a' },
      { id: 'b:0', txid: 'b' },
    ];
    const fees = [
      { txid: 'a', zat: 15_000n },
      { txid: 'c', zat: 10_000n },
    ];
    const { rows, otherFees } = withFees(sent, fees);
    expect(rows.map((row) => [row.id, row.fee?.zat ?? null])).toEqual([
      ['a:0', 15_000n],
      ['a:1', null],
      ['b:0', null],
    ]);
    expect(otherFees).toEqual([{ txid: 'c', zat: 10_000n }]);
  });
});

describe('a swap in words', () => {
  it('names what each purpose delivers, where, and with how many decimals', () => {
    expect(purposeWords('margin')).toMatchObject({ short: 'Margin', chain: 'hyperliquid', decimals: 8 });
    expect(purposeWords('payout_float')).toMatchObject({ short: 'Payout float', chain: 'solana', decimals: 6 });
    expect(purposeWords('something_new')).toMatchObject({ short: 'something_new', chain: null, decimals: null });
  });

  it('writes what arrives in the decimals of where it arrives', () => {
    // 11.020977 USDC as HyperCore states it, with eight decimals.
    expect(deliveredText(1_102_097_700n, purposeWords('margin'))).toBe('11.020977 USDC');
    expect(deliveredText('750000', purposeWords('payout_float'))).toBe('0.75 USDC');
    expect(deliveredText(5n, purposeWords('something_new'))).toBe('5 base units');
  });

  it('says where each state of the swap service stands', () => {
    expect(swapWords('PENDING_DEPOSIT')).toMatchObject({ label: 'Waiting for the deposit', state: 'limit', step: 0 });
    expect(swapWords('PROCESSING')).toMatchObject({ label: 'Swapping', step: 1 });
    expect(swapWords('SUCCESS')).toMatchObject({ label: 'Delivered', state: 'locked', step: 2 });
    expect(swapWords('INCOMPLETE_DEPOSIT')).toMatchObject({ state: 'limit', step: 0 });
    expect(swapWords('REFUNDED')).toMatchObject({ label: 'Refunded', state: 'refused', step: null });
    expect(swapWords('FAILED')).toMatchObject({ label: 'Failed', state: 'refused', step: null });
  });

  it('shows a state it does not know as that state, and as unavailable', () => {
    expect(swapWords('KNOWN_DEPOSIT_TX')).toMatchObject({ label: 'KNOWN_DEPOSIT_TX', state: 'stale', step: null });
  });
});

describe('the funding form', () => {
  const REFUND = 't1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC';
  const text = { purpose: 'margin' as const, amount: '0.02', refundTo: REFUND, slippageBps: '100' };

  it('reads into what the server takes', () => {
    expect(readFunding(text, { payoutFloat: false })).toEqual({ ok: true, body: { purpose: 'margin', amountZat: 2_000_000n, refundTo: REFUND, slippageBps: 100 } });
    expect(readFunding({ ...text, slippageBps: '300', refundTo: ` ${REFUND} ` }, { payoutFloat: false })).toMatchObject({ ok: true, body: { slippageBps: 300, refundTo: REFUND } });
  });

  it('falls back to the default slippage for a value the form does not offer', () => {
    expect(readFunding({ ...text, slippageBps: '9999' }, { payoutFloat: false })).toMatchObject({ ok: true, body: { slippageBps: 100 } });
  });

  it('refuses a payout float where there is no wallet to deliver it to', () => {
    const read = readFunding({ ...text, purpose: 'payout_float' }, { payoutFloat: false });
    expect(read).toMatchObject({ ok: false, errors: { purpose: expect.stringContaining('no Solana wallet yet') } });
    expect(readFunding({ ...text, purpose: 'payout_float' }, { payoutFloat: true })).toMatchObject({ ok: true });
  });

  it('refuses a refund address that is not transparent, and an amount that is not one, each at its field', () => {
    const read = readFunding({ ...text, amount: 'abc', refundTo: `u1${'q'.repeat(70)}` }, { payoutFloat: true });
    expect(read).toMatchObject({ ok: false, errors: { amount: expect.any(String), refundTo: expect.stringContaining('not a transparent Zcash address') } });
    expect(readFunding({ ...text, refundTo: '' }, { payoutFloat: true })).toMatchObject({ ok: false, errors: { refundTo: expect.stringContaining('A refund address is needed') } });
  });

  it('states what a quote takes, in dollars', () => {
    expect(quoteCostUsd({ amountInUsd: 24.55, amountOutUsd: 24.16, costBps: 160 })).toBeCloseTo(0.39, 6);
    expect(quoteCostUsd({ amountInUsd: 10, amountOutUsd: 10.02, costBps: 0 })).toBe(0);
  });
});
