import { describe, expect, it } from 'vitest';
import { RUN_STATE, addressUrl, chainName, durationWords, formatAhead, formatSol, formatUnits, parseAmount, periodWords, receiptPath, tokenAmount, tokenText } from '../../src/app/_sections/payouts/format';

describe('amounts as the Payouts pages write them', () => {
  it('writes base units with at least two decimals, and further ones only as far as they are not zero', () => {
    expect(formatUnits(1_250_000n, 6)).toBe('1.25');
    expect(formatUnits(400_000n, 6)).toBe('0.40');
    expect(formatUnits(750_000_000n, 6)).toBe('750.00');
    expect(formatUnits(1n, 6)).toBe('0.000001');
    expect(formatUnits(1_234_567_891_234n, 6)).toBe('1,234,567.891234');
    expect(formatUnits(0n, 6)).toBe('0.00');
    expect(formatUnits(-1_500_000n, 6)).toBe('−1.50');
  });

  it('writes a token without decimals as whole units', () => {
    expect(formatUnits(42n, 0)).toBe('42');
    expect(formatUnits(5n, 1)).toBe('0.5');
  });

  it('gives an amount its unit, and says base units where the decimals of an old run were not kept', () => {
    expect(tokenAmount(750_000n, { symbol: 'USDC', decimals: 6 })).toEqual({ figure: '0.75', unit: 'USDC' });
    expect(tokenText(750_000n, { symbol: 'USDC.e', decimals: 6 })).toBe('0.75 USDC.e');
    expect(tokenAmount(750_000n, { symbol: null, decimals: 6 })).toEqual({ figure: '0.75', unit: 'tokens' });
    expect(tokenAmount(750_000n, { symbol: 'USDC', decimals: null })).toEqual({ figure: '750,000', unit: 'base units of USDC' });
    expect(tokenAmount(750_000n, { symbol: null, decimals: null })).toEqual({ figure: '750,000', unit: 'base units' });
  });

  it('writes lamports as SOL with at least four decimals', () => {
    expect(formatSol(5_008_120n)).toBe('0.00500812');
    expect(formatSol(1_000_000_000n)).toBe('1.0000');
    expect(formatSol(897_840n)).toBe('0.00089784');
    expect(formatSol(0n)).toBe('0.0000');
  });
});

describe('a typed amount', () => {
  it('is read as base units without rounding', () => {
    expect(parseAmount('250', 6)).toEqual({ ok: true, units: 250_000_000n });
    expect(parseAmount(' 0.40 ', 6)).toEqual({ ok: true, units: 400_000n });
    expect(parseAmount('0.000001', 6)).toEqual({ ok: true, units: 1n });
    expect(parseAmount('12.', 6)).toEqual({ ok: true, units: 12_000_000n });
  });

  it('is refused with the reason when it is empty, not a plain number, too fine for the token, or nothing', () => {
    expect(parseAmount('', 6)).toEqual({ ok: false, reason: 'Enter an amount.' });
    expect(parseAmount('1,000', 6)).toMatchObject({ ok: false });
    expect(parseAmount('-5', 6)).toMatchObject({ ok: false });
    expect(parseAmount('1e6', 6)).toMatchObject({ ok: false });
    expect(parseAmount('.5', 6)).toMatchObject({ ok: false });
    expect(parseAmount('0.0000001', 6)).toEqual({ ok: false, reason: 'The token has 6 decimals; this amount has 7.' });
    expect(parseAmount('0', 6)).toEqual({ ok: false, reason: 'The amount has to be more than nothing.' });
    expect(parseAmount('0.000', 6)).toMatchObject({ ok: false });
  });
});

describe('periods, chains and moments ahead', () => {
  it('writes a length of time in the largest unit that divides it', () => {
    expect(durationWords(30 * 86_400)).toBe('30 days');
    expect(durationWords(86_400)).toBe('1 day');
    expect(durationWords(3_600)).toBe('1 hour');
    expect(durationWords(5_400)).toBe('90 minutes');
    expect(durationWords(61)).toBe('61 seconds');
    expect(durationWords(3_650 * 86_400)).toBe('3,650 days');
  });

  it('tells a limit that refills from one that is given once', () => {
    expect(periodWords(0)).toBe('once, with no refill');
    expect(periodWords(7 * 86_400)).toBe('in every period of 7 days');
  });

  it('names a chain with its network when that is not the main one', () => {
    expect(chainName('tempo', 'mainnet')).toBe('Tempo');
    expect(chainName('tempo', 'moderato')).toBe('Tempo Moderato testnet');
    expect(chainName('solana', 'mainnet-beta')).toBe('Solana');
    expect(chainName('solana', 'devnet')).toBe('Solana devnet');
  });

  it('says how far ahead a moment lies, and nothing for one that is not ahead', () => {
    const now = 1_800_000_000_000;
    expect(formatAhead(now + 40_000, now)).toBe('in 40 s');
    expect(formatAhead(now + 12 * 60_000, now)).toBe('in 12 min');
    expect(formatAhead(now + 5 * 3_600_000, now)).toBe('in 5 h');
    expect(formatAhead(now + 28 * 86_400_000, now)).toBe('in 28 d');
    expect(formatAhead(now, now)).toBeNull();
    expect(formatAhead(now - 1_000, now)).toBeNull();
  });
});

describe('runs and links', () => {
  it('gives every status of a run a fill, a word and what it means for the money', () => {
    expect(RUN_STATE.paid).toMatchObject({ fill: 'locked', word: 'Paid' });
    expect(RUN_STATE.draft).toMatchObject({ fill: 'limit', word: 'Draft' });
    expect(RUN_STATE.refused).toMatchObject({ fill: 'refused', word: 'Refused' });
    expect(RUN_STATE.failed).toMatchObject({ fill: 'refused', word: 'Failed' });
    // A run whose attempt was not seen to end is never worded as unpaid.
    expect(RUN_STATE.sending.word).toBe('Not settled');
    expect(RUN_STATE.sending.meaning).toContain('must not be treated as unpaid');
  });

  it('builds the link of an address from what the server says comes before and after it', () => {
    expect(addressUrl({ before: 'https://explorer.solana.com/address/', after: '?cluster=devnet' }, 'B1zT')).toBe('https://explorer.solana.com/address/B1zT?cluster=devnet');
    expect(addressUrl({ before: 'https://explore.tempo.xyz/address/', after: '' }, '0x43E6')).toBe('https://explore.tempo.xyz/address/0x43E6');
    expect(receiptPath('CTpVTsWQGwj9hKk6yQiGjZah3K7hqtRl3rEbh0X65e8')).toBe('/receipts/CTpVTsWQGwj9hKk6yQiGjZah3K7hqtRl3rEbh0X65e8');
  });
});
