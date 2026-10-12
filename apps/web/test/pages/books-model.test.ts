import type { LedgerEntry } from '@holdfast/books';
import { describe, expect, it } from 'vitest';
import { formatSignedUnits, formatSignedUsd, formatUnits, formatZat, usdDigits } from '../../src/app/_sections/books/amounts';
import { failureCopy } from '../../src/app/_sections/books/failures';
import {
  ALL_TIME,
  MODULES,
  agreementOf,
  checkAuditLink,
  dayStart,
  ledgerRows,
  linkState,
  monthName,
  monthRange,
  overallVerdict,
  periodOf,
  realisedOnHedge,
  scopeDates,
  verdictOf,
} from '../../src/app/_sections/books/model';
import { ClientError } from '../../src/client/errors';
import type { ReconciliationCheck } from '../../src/server/pages/books';

describe('amounts', () => {
  it('are written from base units without passing through a float', () => {
    expect(formatUnits(1_250_000n, 6)).toBe('1.25');
    expect(formatUnits(750_000n, 6, 2)).toBe('0.75');
    expect(formatUnits(400_000n, 6, 2)).toBe('0.40');
    expect(formatUnits(0n, 6, 2)).toBe('0.00');
    expect(formatUnits(0n, 8)).toBe('0');
    expect(formatUnits(123_456_789_000_000n, 6)).toBe('123,456,789');
    expect(formatUnits(-930_000n, 8)).toBe('−0.0093');
    expect(formatUnits(5n, 0)).toBe('5');
    expect(formatUnits(9_007_199_254_740_993_000_001n, 6)).toBe('9,007,199,254,740,993.000001');
    expect(formatZat(1_030_000n)).toBe('0.0103');
    expect(formatZat(1_975_000n)).toBe('0.01975');
  });

  it('carry their sign where the direction is the point, and none for nothing', () => {
    expect(formatSignedUnits(1_975_000n, 8)).toBe('+0.01975');
    expect(formatSignedUnits(-400_000n, 6, 2)).toBe('−0.40');
    expect(formatSignedUnits(0n, 8, 2)).toBe('0.00');
    expect(formatSignedUsd(0.2623)).toBe('+$0.26');
    expect(formatSignedUsd(-1.5)).toBe('−$1.50');
    expect(formatSignedUsd(0)).toBe('$0.00');
    // A figure that rounds to nothing is not given a sign it does not have.
    expect(formatSignedUsd(-0.004)).toBe('$0.00');
    expect(formatSignedUsd(12_345.678)).toBe('+$12,345.68');
  });

  it('take as many decimals as a figure under a cent needs to be read, and no more than six', () => {
    expect(usdDigits(12.26)).toBe(2);
    expect(usdDigits(0)).toBe(2);
    expect(usdDigits(0.01)).toBe(2);
    expect(usdDigits(0.005518)).toBe(4);
    expect(usdDigits(-0.000157)).toBe(5);
    expect(usdDigits(0.000000012)).toBe(6);
  });
});

describe('the period of a statement', () => {
  it('is a whole UTC month, to the millisecond', () => {
    expect(monthRange('2026-10')).toEqual({ from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 10, 1) - 1 });
    expect(monthRange('2026-12')).toEqual({ from: Date.UTC(2026, 11, 1), to: Date.UTC(2027, 0, 1) - 1 });
    expect(monthRange('2028-02')?.to).toBe(Date.UTC(2028, 1, 29, 23, 59, 59, 999));
    expect(monthName('2026-10')).toBe('October 2026');
  });

  it('is the whole of the books for anything that is not a month', () => {
    expect(periodOf('2026-10')).toEqual({ id: '2026-10', range: monthRange('2026-10') });
    for (const param of [undefined, '', 'all', '2026-13', '2026-1', '26-10', 'October', ['2026-10', '2026-11']]) expect(periodOf(param)).toBe(ALL_TIME);
    expect(ALL_TIME.range).toEqual({ from: null, to: null });
  });
});

const HOUR = 3_600_000;
const DAY_ONE = Date.UTC(2026, 9, 10);

function entry(over: Partial<LedgerEntry> & Pick<LedgerEntry, 'id' | 'kind'>): LedgerEntry {
  return {
    ts: DAY_ONE,
    source: 'hyperliquid',
    asset: 'USDC',
    decimals: 8,
    amount: 0n,
    usd: 0,
    usdPrice: 1,
    usdPriceAt: DAY_ONE,
    ref: '',
    counterparty: null,
    proof: { chain: 'hyperliquid', tx: null, block: null, url: null },
    linked: [],
    ...over,
  };
}

describe('the ledger as rows', () => {
  const ledger: LedgerEntry[] = [
    entry({ id: 'zcash:a', kind: 'receipt', source: 'zcash', asset: 'ZEC', amount: 1_975_000n, usd: null, usdPrice: null, ts: DAY_ONE + 17 * HOUR, ref: 'ZCG grant, milestone 2 of 4', proof: { chain: 'zcash', tx: '2747', block: 3_513_140, url: 'https://explorer.test/2747' } }),
    entry({ id: 'hl:fill:1', kind: 'hedge_open', asset: 'ZEC-PERP', amount: -1_000_000n, usd: -12.264, usdPrice: 1226.4, ts: DAY_ONE + 20 * HOUR, ref: '0xd5ce6801a6783b879b84d9c8a4be53ab' }),
    entry({ id: 'f1', kind: 'funding', amount: 15_700n, usd: 0.000157, ts: DAY_ONE + 21 * HOUR }),
    entry({ id: 'f2', kind: 'funding', amount: 15_000n, usd: 0.00015, ts: DAY_ONE + 22 * HOUR }),
    entry({ id: 'f3', kind: 'funding', amount: -5_000n, usd: -0.00005, ts: DAY_ONE + 23 * HOUR }),
    entry({ id: 'f4', kind: 'funding', amount: 16_000n, usd: 0.00016, ts: DAY_ONE + 24 * HOUR }),
    entry({ id: 'payout:HF-1:1', kind: 'payout', source: 'tempo', asset: 'USDC.e', decimals: 6, amount: -400_000n, usd: -0.4, ts: DAY_ONE + 21 * HOUR + 1, ref: 'HF-1/1', counterparty: { name: 'Contractor A', address: '0x7EB7' }, proof: { chain: 'tempo', tx: '0x379f', block: null, url: 'https://explore.test/0x379f' } }),
  ];

  it('are newest first, with one day’s funding added up into a row that says how many it holds', () => {
    const rows = ledgerRows(ledger);
    expect(rows.map((row) => [row.what, row.entries, row.amount, row.asset])).toEqual([
      ['Funding', 1, '+0.00016', 'USDC'],
      ['Funding, 3 hourly payments', 3, '+0.000257', 'USDC'],
      ['Payout', 1, '−0.40', 'USDC.e'],
      ['Short opened', 1, '−0.01', 'ZEC-PERP'],
      ['Payment received', 1, '+0.01975', 'ZEC'],
    ]);
    const folded = rows[1];
    expect(folded?.ts).toBe(DAY_ONE + 23 * HOUR);
    expect(folded?.usd).toBeCloseTo(0.000257, 9);
    expect(folded?.proof).toBeNull();
  });

  it('keep what each entry carries: a memo as text, an order id as an identifier, a payee, a transaction', () => {
    const rows = ledgerRows(ledger);
    const byWhat = (what: string) => rows.find((row) => row.what === what);
    expect(byWhat('Payment received')).toMatchObject({ detail: { kind: 'text', value: 'ZCG grant, milestone 2 of 4' }, usd: null, notional: false, proof: { chain: 'zcash', tx: '2747', block: 3_513_140 } });
    expect(byWhat('Short opened')).toMatchObject({ detail: { kind: 'id', value: '0xd5ce6801a6783b879b84d9c8a4be53ab' }, usd: -12.264, notional: true, proof: null });
    expect(byWhat('Payout')).toMatchObject({ payee: 'Contractor A', detail: { kind: 'text', value: 'HF-1/1' }, notional: false });
  });

  it('leave a day of funding without a dollar total when one of its payments has none', () => {
    const rows = ledgerRows([entry({ id: 'f1', kind: 'funding', amount: 10n, usd: 0.0000001 }), entry({ id: 'f2', kind: 'funding', amount: 10n, usd: null, ts: DAY_ONE + HOUR })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entries: 2, usd: null, amount: '+0.0000002' });
  });

  it('add up what the hedge realised, and say when it cannot be added', () => {
    expect(realisedOnHedge(ledger)).toEqual({ usd: 0, count: 0 });
    const closes = [entry({ id: 'p1', kind: 'realized_pnl', usd: 1.25 }), entry({ id: 'p2', kind: 'realized_pnl', usd: -0.5 }), entry({ id: 'x', kind: 'realized_pnl', source: 'swap', usd: 99 })];
    expect(realisedOnHedge(closes)).toEqual({ usd: 0.75, count: 2 });
    expect(realisedOnHedge([...closes, entry({ id: 'p3', kind: 'realized_pnl', usd: null })])).toEqual({ usd: null, count: 3 });
  });
});

describe('a reconciliation check on the page', () => {
  const check = (over: Partial<ReconciliationCheck> & Pick<ReconciliationCheck, 'id'>): ReconciliationCheck => ({ matched: [], problems: [], ...over });

  it('agrees, differs, is not settled, or had nothing to compare', () => {
    expect(verdictOf(check({ id: 'payouts', matched: [{ kind: 'payout_line', refs: ['a'] }] }))).toBe('agrees');
    expect(verdictOf(check({ id: 'swaps' }))).toBe('nothing');
    // The check of the records pairs nothing and passes by finding no fault.
    expect(verdictOf(check({ id: 'records' }))).toBe('agrees');
    expect(verdictOf(check({ id: 'payouts', matched: [{ kind: 'payout_line', refs: ['a'] }], problems: [{ kind: 'run_unsettled', severity: 'warning', detail: 'd', refs: [] }] }))).toBe('warned');
    expect(verdictOf(check({ id: 'balances', matched: [{ kind: 'balance', refs: ['journal:1'] }], problems: [{ kind: 'balance_mismatch', severity: 'error', detail: 'd', refs: [] }] }))).toBe('differs');
  });

  it('gives the whole reconciliation the worst of its checks', () => {
    const agrees = check({ id: 'orders', matched: [{ kind: 'order', refs: ['journal:2'] }] });
    const warned = check({ id: 'payouts', problems: [{ kind: 'run_unsettled', severity: 'warning', detail: 'd', refs: [] }] });
    const differs = check({ id: 'records', problems: [{ kind: 'malformed_entry', severity: 'error', detail: 'd', refs: [] }] });
    expect(overallVerdict([agrees, check({ id: 'swaps' })])).toBe('agrees');
    expect(overallVerdict([agrees, warned])).toBe('warned');
    expect(overallVerdict([agrees, warned, differs])).toBe('differs');
    expect(overallVerdict([check({ id: 'swaps' }), check({ id: 'orders' })])).toBe('nothing');
  });

  it('says what agreed, naming the journal entries a balance covers', () => {
    expect(agreementOf(check({ id: 'payouts', matched: [{ kind: 'payout_line', refs: ['a'] }] }))).toBe('One line was found on chain with the recorded payee and amount.');
    expect(agreementOf(check({ id: 'payouts', matched: [{ kind: 'payout_line', refs: ['a'] }, { kind: 'payout_line', refs: ['b'] }] }))).toBe('2 lines were found on chain with the recorded payee and amount.');
    expect(agreementOf(check({ id: 'balances', matched: [{ kind: 'balance', refs: ['journal:1', 'journal:164'] }] }))).toBe('Journal entries 1 to 164: the recorded balance is what the ledger adds up to.');
    expect(agreementOf(check({ id: 'balances', matched: [{ kind: 'balance', refs: ['journal:7'] }] }))).toBe('Journal entry 7: the recorded balance is what the ledger adds up to.');
    expect(agreementOf(check({ id: 'swaps' }))).toBeNull();
    expect(agreementOf(check({ id: 'records' }))).toBe('No record is malformed and none appears twice.');
    expect(agreementOf(check({ id: 'records', problems: [{ kind: 'duplicate_record', severity: 'error', detail: 'd', refs: [] }] }))).toBeNull();
  });
});

describe('a new auditor link', () => {
  const NOW = Date.UTC(2026, 9, 12, 12);
  const fields = { label: 'Q4 audit', from: '', to: '', modules: MODULES, expires: '' };

  it('covers whole UTC days and expires at the end of the day named', () => {
    expect(dayStart('2026-10-01')).toBe(Date.UTC(2026, 9, 1));
    expect(checkAuditLink({ ...fields, label: '  Q4 audit ', from: '2026-10-01', to: '2026-10-31', modules: ['payouts', 'payouts', 'hedge'], expires: '2026-12-31' }, NOW)).toEqual({
      ok: true,
      input: { label: 'Q4 audit', scope: { from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 10, 1) - 1, modules: ['payouts', 'hedge'] }, expiresAt: Date.UTC(2027, 0, 1) - 1 },
    });
    expect(checkAuditLink(fields, NOW)).toEqual({ ok: true, input: { label: 'Q4 audit', scope: { from: null, to: null, modules: [...MODULES] }, expiresAt: null } });
    // One day is a scope: it starts and ends on the same date.
    expect(checkAuditLink({ ...fields, from: '2026-10-10', to: '2026-10-10' }, NOW)).toMatchObject({ ok: true });
    // A link may expire later today.
    expect(checkAuditLink({ ...fields, expires: '2026-10-12' }, NOW)).toMatchObject({ ok: true, input: { expiresAt: Date.UTC(2026, 9, 13) - 1 } });
  });

  it('is refused here for whatever the server would refuse it for', () => {
    const errorsOf = (over: Partial<typeof fields>) => {
      const checked = checkAuditLink({ ...fields, ...over }, NOW);
      return checked.ok ? {} : checked.errors;
    };
    expect(Object.keys(errorsOf({ label: '   ' }))).toEqual(['label']);
    expect(Object.keys(errorsOf({ label: 'x'.repeat(121) }))).toEqual(['label']);
    expect(errorsOf({ label: 'x'.repeat(120) })).toEqual({});
    expect(Object.keys(errorsOf({ modules: [] }))).toEqual(['modules']);
    expect(errorsOf({ from: '2026-11-01', to: '2026-10-31' })).toEqual({ to: 'The scope ends before it starts.' });
    expect(errorsOf({ expires: '2026-10-11' })).toEqual({ expires: 'The link would have expired before it was made.' });
    expect(Object.keys(errorsOf({ from: '2026-02-30', to: 'soon', expires: '12/31/2026' })).sort()).toEqual(['expires', 'from', 'to']);
    expect(dayStart('2026-02-30')).toBeNull();
    expect(dayStart('2026-13-01')).toBeNull();
  });

  it('works, has expired, was revoked, or opens nothing', () => {
    const scope = { from: null, to: null, modules: ['payouts'] };
    expect(linkState({ scope, expiresAt: null, revokedAt: null }, NOW)).toBe('live');
    expect(linkState({ scope, expiresAt: NOW + 1, revokedAt: null }, NOW)).toBe('live');
    expect(linkState({ scope, expiresAt: NOW, revokedAt: null }, NOW)).toBe('expired');
    expect(linkState({ scope, expiresAt: NOW - 1, revokedAt: NOW - 5 }, NOW)).toBe('revoked');
    expect(linkState({ scope: null, expiresAt: null, revokedAt: null }, NOW)).toBe('unreadable');
  });

  it('has its dates said in words', () => {
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    expect(scopeDates({ from: null, to: null }, day)).toBe('Every date, from the first entry onwards');
    expect(scopeDates({ from: Date.UTC(2026, 9, 1), to: null }, day)).toBe('Everything from 2026-10-01 onwards');
    expect(scopeDates({ from: null, to: Date.UTC(2026, 9, 31) }, day)).toBe('Everything up to 2026-10-31');
    expect(scopeDates({ from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 9, 31) }, day)).toBe('From 2026-10-01 to 2026-10-31');
  });
});

describe('a failed action', () => {
  it('is said in the wallet’s or the server’s own words, with what it leaves to do', () => {
    expect(failureCopy(new ClientError('wallet_rejected', 'sending the transaction was declined in the wallet'))).toEqual({
      kind: 'refusal',
      title: 'Declined in the wallet',
      body: 'Sending the transaction was declined in the wallet. Nothing was signed and nothing was sent.',
      detail: null,
    });
    expect(failureCopy(new ClientError('wallet_failed', 'sending the transaction failed in the wallet: insufficient funds for gas'))).toMatchObject({ kind: 'warning', body: 'Sending the transaction failed in the wallet: insufficient funds for gas. Nothing changed on chain.' });
    expect(failureCopy(new ClientError('refused', 'the organisation has no Tempo account yet; set one in its profile first', { status: 409 }))).toEqual({
      kind: 'refusal',
      title: 'The server would not do it',
      body: 'The organisation has no Tempo account yet; set one in its profile first.',
      detail: null,
    });
    expect(failureCopy(new ClientError('unavailable', 'Hyperliquid is unavailable: fetch failed', { status: 503, details: { source: 'Hyperliquid' } }))).toMatchObject({ kind: 'warning', title: 'It could not be done now', body: 'Hyperliquid is unavailable: fetch failed. Nothing was changed.' });
    expect(failureCopy(new ClientError('invalid_input', 'the body is not valid', { status: 400, details: { problems: ['body.label: too long', 'body.scope: required'] } })).body).toBe('The body is not valid. Body.label: too long. Body.scope: required.');
    expect(failureCopy(new ClientError('unauthenticated', 'sign in first', { status: 401 }))).toMatchObject({ title: 'The session has run out' });
  });

  it('shows the first sentences of a message that runs long, and keeps the whole of it', () => {
    const dump =
      'sending the transaction failed in the wallet: An unknown RPC error occurred. Details: Execution reverted with reason: gas required exceeds allowance (0). Request Arguments: from: 0x96664E011e2E2B8b609a36a024A8B2eE754c24BC to: 0xa6aFA5c68146BbD4C49510987847C7C38837824E value: 0 ETH data: 0x9daf85ab000000000000000000000000430f164b8580f76c90adfd245dfc7504364645c9 Version: viem@2.57.4';
    const failed = failureCopy(new ClientError('wallet_failed', dump));
    expect(failed.body).toBe('Sending the transaction failed in the wallet: An unknown RPC error occurred. Details: Execution reverted with reason: gas required exceeds allowance (0). Nothing changed on chain.');
    expect(failed.detail).toBe(dump);
    // One with no sentence to stop at is cut at a word.
    const run = failureCopy(new ClientError('wallet_failed', `the node said ${'0xabcdef '.repeat(40)}`));
    expect(run.body.length).toBeLessThan(260);
    expect(run.body).toMatch(/ …\. Nothing changed on chain\.$/);
    expect(run.detail).not.toBeNull();
  });

  it('tells the holder of an auditor link that the link has stopped working, and an owner only that nothing was found', () => {
    const gone = new ClientError('not_found', 'not found', { status: 404 });
    expect(failureCopy(gone, 'audit')).toMatchObject({ kind: 'refusal', title: 'This link no longer opens anything' });
    expect(failureCopy(gone)).toMatchObject({ kind: 'refusal', title: 'Not found' });
    expect(failureCopy(new ClientError('network', 'the server could not be reached')).body).toContain('not known');
  });
});
