import { describe, expect, it } from 'vitest';
import { type AuditScope, buildLedger, buildStatement, type LedgerEntry, parseAuditScope, scopeStatement, stringifyExact, toCsv } from '../src/index';
import { DEPOSIT_ADDRESS, PAYOUTS_NOW, POLICY, SWAP_ID, deposit, floatSwap, historyWithPayouts } from './fixtures';

/**
 * What a scoped view must not give away. The statement is current and whole;
 * every case hands it to an auditor whose link covers less.
 */
const history = historyWithPayouts();
const ledger = buildLedger(history.records);
const statement = buildStatement({ ledger, journal: history.journal, policy: POLICY, now: PAYOUTS_NOW, monthlyBurnUsd: 4, seriesStep: 'entry' });
const at = (iso: string) => Date.parse(iso);
const ALL = ['treasury', 'hedge', 'swaps', 'payouts'] as const;

describe('the statement being scoped', () => {
  it('is current and has every figure', () => {
    expect(statement.stale).toEqual([]);
    expect(statement.treasury?.zat).toBe(151_020_000n);
    expect(statement.hedge).toMatchObject({ shortLots: 1, targetLots: 151, coverageBps: 66 });
    expect(statement.series).toHaveLength(7);
    expect(statement.lock).not.toBeNull();
  });
});

describe('a scope without the treasury', () => {
  it('does not show the hedge target, which is the treasury balance in lots', () => {
    const { statement: s } = scopeStatement(statement, ledger, { from: null, to: null, modules: ['hedge'] });
    expect(s.hedge).toMatchObject({ shortLots: 1, accountValueUsd: statement.hedge?.accountValueUsd, targetLots: null, coverageBps: null });
    expect(s.treasury).toBeNull();
    expect(stringifyExact(s)).not.toContain('151');
  });
});

describe('a scope that starts after the beginning', () => {
  const recent: AuditScope = { from: at('2026-10-20T00:00:00Z'), to: null, modules: ALL };
  const { statement: s, ledger: entries } = scopeStatement(statement, ledger, recent);

  it('still shows what happened inside it', () => {
    expect(entries.map((e) => e.kind)).toEqual(['payout', 'payout', 'payout']);
    expect(s.payouts).toMatchObject({ usd: 875.5, count: 3 });
  });

  it('shows no balance, position or value, each of which is the sum of what came before', () => {
    expect(s.treasury).toBeNull();
    expect(s.hedge).toBeNull();
    expect(s.lock).toBeNull();
    expect(s.runwayMonths).toBeNull();
  });

  it('shows no series: every point of it is the value of the whole history up to that day', () => {
    expect(statement.series.some((p) => p.t >= (recent.from as number))).toBe(true);
    expect(s.series).toEqual([]);
  });
});

describe('a scope that ends before the present', () => {
  const past: AuditScope = { from: null, to: at('2026-10-09T23:59:59Z'), modules: ALL };
  const { statement: s } = scopeStatement(statement, ledger, past);

  it('gives the balance of its own last day, summed from its own entries', () => {
    expect(s.treasury).toEqual({ zat: 1_030_000n, untrackedZat: 0n, asOf: null, px: null, pxAt: null, usd: null });
  });

  it('shows no current reading, and no word on which sources are stale now', () => {
    const late = buildStatement({ ledger, journal: history.journal, policy: POLICY, now: PAYOUTS_NOW + 3_600_000, monthlyBurnUsd: 4 });
    expect(late.stale).toHaveLength(4);
    const scoped = scopeStatement(late, ledger, past).statement;
    expect(scoped.hedge).toBeNull();
    expect(scoped.stale).toEqual([]);
  });

  it('keeps the series up to its end', () => {
    expect(s.series.map((p) => p.seq)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('a balance carried over from the whole ledger', () => {
  it('is never used: an entry dated past the end of the scope is not in the scoped balance', () => {
    // A block whose own clock runs a minute ahead of the statement.
    const ahead: LedgerEntry = { ...(ledger.find((e) => e.kind === 'receipt') as LedgerEntry), id: 'zcash:ahead', ts: PAYOUTS_NOW + 60_000, amount: 5_000n };
    const withAhead = [...ledger, ahead];
    const whole = buildStatement({ ledger: withAhead, journal: history.journal, policy: POLICY, now: PAYOUTS_NOW, monthlyBurnUsd: 4 });
    expect(whole.treasury?.zat).toBe(151_025_000n);

    const scoped = scopeStatement(whole, withAhead, { from: null, to: PAYOUTS_NOW, modules: ['treasury'] });
    expect(scoped.ledger.some((e) => e.id === 'zcash:ahead')).toBe(false);
    expect(scoped.statement.treasury?.zat).toBe(151_020_000n);
    expect(scoped.statement.treasury?.usd).toBeCloseTo(1.5102 * (whole.treasury?.px as number), 9);
  });
});

describe('a treasury scope without the swaps', () => {
  const { ledger: entries } = scopeStatement(statement, ledger, { from: null, to: null, modules: ['treasury'] });
  const deposits = entries.filter((e) => e.kind === 'swap_out');

  it('shows that ZEC went into a swap, and not which swap or to what deposit address', () => {
    expect(deposits.map((e) => [e.id, e.amount, e.ref, e.counterparty, e.linked.filter((id) => id.startsWith('swap:'))])).toEqual([
      [`zcash:${deposit.id}`, -930_000n, '', null, []],
      [expect.stringMatching(/:transparent$/), -100_000_000n, '', null, []],
    ]);
    const text = stringifyExact(entries);
    for (const hidden of [SWAP_ID, floatSwap.id, DEPOSIT_ADDRESS, floatSwap.depositAddress]) expect(text).not.toContain(hidden);
  });

  it('shows them to a scope that has the swaps', () => {
    const withSwaps = scopeStatement(statement, ledger, { from: null, to: null, modules: ['treasury', 'swaps'] }).ledger;
    expect(withSwaps.find((e) => e.id === `zcash:${deposit.id}`)).toMatchObject({ ref: SWAP_ID, counterparty: { address: DEPOSIT_ADDRESS } });
  });
});

describe('an entry that is not of a kind its source produces', () => {
  it('is shown under no module', () => {
    const stray: LedgerEntry = { ...(ledger.find((e) => e.kind === 'receipt') as LedgerEntry), id: 'tempo:stray', source: 'tempo' };
    for (const module of ALL) {
      const scoped = scopeStatement(statement, [...ledger, stray], { from: null, to: null, modules: [module] });
      expect(scoped.ledger.some((e) => e.id === 'tempo:stray')).toBe(false);
    }
  });
});

describe('a scope that is not a scope', () => {
  const stored = (value: unknown) => scopeStatement(statement, ledger, value as AuditScope);

  it('shows nothing when its modules are a string that happens to contain a module name', () => {
    const { ledger: entries, statement: s } = stored({ from: null, to: null, modules: 'treasury,hedge,swaps,payouts' });
    expect(entries).toEqual([]);
    expect(s).toMatchObject({ treasury: null, hedge: null, lock: null, payouts: null, series: [] });
  });

  it.each([
    ['a missing module list', { from: null, to: null }],
    ['a date that is not a number', { from: '2026-10-01', to: null, modules: ['payouts'] }],
    ['an open end written as undefined', { from: null, modules: ['payouts'] }],
    ['a date that is not finite', { from: null, to: Number.NaN, modules: ['payouts'] }],
    ['a module it does not know', { from: null, to: null, modules: ['payouts', 'everything'] }],
    ['no object at all', null],
  ])('shows nothing for %s', (_what, value) => {
    expect(stored(value).ledger).toEqual([]);
    expect(stored(value).scope).toEqual({ from: null, to: null, modules: [] });
  });

  it('is refused by name when read from where it was stored', () => {
    expect(() => parseAuditScope({ from: null, to: null, modules: 'payouts' })).toThrow('the modules of an audit scope must be among treasury, hedge, swaps, payouts');
    expect(() => parseAuditScope({ from: '1', to: null, modules: [] })).toThrow('the dates of an audit scope must be timestamps or null');
    expect(() => parseAuditScope([])).toThrow('an audit scope must be an object');
    expect(parseAuditScope({ from: 5, to: null, modules: ['payouts', 'payouts', 'hedge'], label: 'Q4 audit' })).toEqual({ from: 5, to: null, modules: ['payouts', 'hedge'] });
  });
});

describe('the ledger as CSV, from a ledger that was not checked first', () => {
  const entry = ledger[0] as LedgerEntry;
  const cells = (e: unknown) => (toCsv([e as LedgerEntry]).split('\r\n')[1] as string).split(',');

  it('defuses a formula sitting where a figure should be', () => {
    const row = cells({ ...entry, ref: 'memo', usd: '=1+1', usdPrice: '@SUM(A1)', proof: { ...entry.proof, block: '+7' } });
    expect(row[7]).toBe("'=1+1");
    expect(row[8]).toBe("'@SUM(A1)");
    expect(row[15]).toBe("'+7");
  });

  it('defuses the full-width signs a spreadsheet also takes for a formula, and one hidden behind blanks', () => {
    const wide = (code: number, rest: string) => String.fromCharCode(code) + rest;
    for (const memo of [wide(0xff1d, 'HYPERLINK("x")'), wide(0xff0b, '1'), wide(0xff0d, '1'), wide(0xff20, 'SUM(A1)'), '  =1+1', '\n=1+1']) {
      const csv = toCsv([{ ...entry, ref: memo }]);
      expect(csv).toContain(`'${memo.replaceAll('"', '""')}`);
    }
  });

  it('writes blanks, not a crash, for a date no calendar holds and decimals no asset has', () => {
    const row = cells({ ...entry, ref: 'memo', ts: 9e15, usdPriceAt: Number.NaN, decimals: -3 });
    expect(row[1]).toBe('');
    expect(row[5]).toBe('');
    expect(row[9]).toBe('');
  });
});
