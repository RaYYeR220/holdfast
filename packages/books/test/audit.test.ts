import { describe, expect, it } from 'vitest';
import {
  type AuditScope,
  buildLedger,
  buildStatement,
  entryModules,
  type LedgerEntry,
  scopeStatement,
  stringifyExact,
  toCsv,
  toJson,
} from '../src/index';
import {
  ARRIVAL_TX,
  CLOID,
  GRANT_MEMO,
  NOW,
  POLICY,
  RECEIPT_TX,
  SPEND_TX,
  SWAP_ID,
  deposit,
  historyWithPayouts,
  receiptNote,
  solanaRun,
  tempoRun,
} from './fixtures';

const history = historyWithPayouts();
const ledger = buildLedger(history.records);
const statement = buildStatement({ ledger, journal: history.journal, policy: POLICY, now: NOW, monthlyBurnUsd: 4, seriesStep: 'entry' });
const scoped = (scope: AuditScope) => scopeStatement(statement, ledger, scope);
const EVERYTHING: AuditScope = { from: null, to: null, modules: ['treasury', 'hedge', 'swaps', 'payouts'] };
const at = (iso: string) => Date.parse(iso);

describe('scoping a statement for an auditor', () => {
  it('changes nothing when the scope covers everything', () => {
    const all = scoped(EVERYTHING);
    expect(all.statement).toEqual(statement);
    expect(all.ledger).toEqual(ledger);
    expect(all.scope).toEqual(EVERYTHING);
  });

  it('leaves only payouts in a payouts scope', () => {
    const { statement: s, ledger: entries } = scoped({ from: null, to: null, modules: ['payouts'] });
    expect(entries.map((e) => e.id)).toEqual(['payout:HF-2026-10-0001:1', 'payout:HF-2026-10-0001:2', 'payout:HF-2026-11-0001:1']);
    expect(s.payouts).toEqual(statement.payouts);
    expect(s).toMatchObject({
      treasury: null,
      hedge: null,
      lock: null,
      receipts: null,
      payments: null,
      swapped: null,
      funding: null,
      fees: { networkZat: null, networkUsd: null, tradeUsd: null, swapUsd: null, totalUsd: null },
      runwayMonths: null,
      monthlyBurnUsd: null,
      series: [],
      unpriced: [],
    });
  });

  it('carries nothing of what is outside the scope, anywhere in the result', () => {
    const text = stringifyExact(scoped({ from: null, to: null, modules: ['payouts'] }));
    for (const secret of [RECEIPT_TX, SPEND_TX, ARRIVAL_TX, CLOID, SWAP_ID, GRANT_MEMO, '1975000', '1030000']) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain(tempoRun.tx);
  });

  it('removes entries outside the dates, and the references to them', () => {
    const october = scoped({ from: at('2026-10-10T00:00:00Z'), to: at('2026-10-31T23:59:59Z'), modules: EVERYTHING.modules });
    expect(october.ledger.every((e) => e.ts >= at('2026-10-10T00:00:00Z') && e.ts <= at('2026-10-31T23:59:59Z'))).toBe(true);
    expect(october.ledger.map((e) => e.kind)).toEqual(['receipt', 'change', 'swap_out', 'network_fee', 'swap_in', 'payout', 'payout']);
    const ids = new Set(october.ledger.map((e) => e.id));
    expect(october.ledger.flatMap((e) => e.linked).every((id) => ids.has(id))).toBe(true);

    const s = october.statement;
    expect(s.range).toEqual({ from: at('2026-10-10T00:00:00Z'), to: at('2026-10-31T23:59:59Z') });
    expect(s.payouts).toMatchObject({ usd: 750, count: 2 });
    expect(s.receipts).toMatchObject({ zat: 250_000_000n, count: 1 });
    // A balance needs the history before the scope, and a current reading needs the scope to reach today.
    expect(s).toMatchObject({ treasury: null, hedge: null, lock: null, runwayMonths: null, series: [] });
    expect(stringifyExact(october)).not.toContain(RECEIPT_TX);
  });

  it('gives the balance at the end of a scope that starts at the beginning', () => {
    const early = scoped({ from: null, to: at('2026-10-09T12:00:00Z'), modules: ['treasury'] });
    expect(early.ledger.map((e) => e.id)).toEqual([`zcash:${receiptNote.id}`]);
    expect(early.statement.treasury).toEqual({ zat: 1_975_000n, untrackedZat: 0n, asOf: null, px: null, pxAt: null, usd: null });
    expect(early.statement.hedge).toBeNull();
  });

  it('keeps current figures when the scope reaches the present', () => {
    const s = scoped({ from: null, to: null, modules: ['treasury', 'hedge'] }).statement;
    expect(s.treasury).toEqual(statement.treasury);
    expect(s.hedge).toEqual(statement.hedge);
    expect(s.funding).toEqual(statement.funding);
    expect(s.fees).toMatchObject({ networkZat: statement.fees.networkZat, tradeUsd: statement.fees.tradeUsd, swapUsd: null, totalUsd: null });
    // Value, drift and runway add the payout float in, which this scope does not show.
    expect(s).toMatchObject({ lock: null, runwayMonths: null, series: [], payouts: null });
  });

  it('shows a swap whole in a swaps scope: the deposit, the arrival and the cost', () => {
    const { ledger: entries, statement: s } = scoped({ from: null, to: null, modules: ['swaps'] });
    expect(entries.map((e) => [e.source, e.kind])).toEqual([
      ['zcash', 'swap_out'],
      ['swap', 'swap_in'],
      ['zcash', 'swap_out'],
      ['swap', 'swap_in'],
    ]);
    // The deposit's fee and change belong to the treasury and are not referred to.
    expect(entries[0]?.linked).toEqual([`swap:${SWAP_ID}:in`]);
    expect(s.fees.swapUsd).toBeCloseTo(statement.fees.swapUsd as number, 9);
    expect(s.fees.networkZat).toBeNull();
    expect(s.treasury).toBeNull();
  });

  it('cuts the series to the dates', () => {
    const cut = scoped({ ...EVERYTHING, from: null, to: at('2026-10-09T14:10:00Z') });
    expect(cut.statement.series.map((p) => p.seq)).toEqual([1, 2]);
    expect(cut.statement.lock).toBeNull();
  });

  it('keeps only the staleness of sources it shows', () => {
    const late = buildStatement({ ledger, journal: history.journal, policy: POLICY, now: NOW + 3_600_000, monthlyBurnUsd: 4 });
    expect(late.stale.map((s) => s.source)).toEqual(['journal', 'zcash', 'hyperliquid', 'reference']);
    expect(scopeStatement(late, ledger, { from: null, to: null, modules: ['payouts'] }).statement.stale.map((s) => s.source)).toEqual(['journal']);
    expect(scopeStatement(late, ledger, { from: null, to: null, modules: ['hedge'] }).statement.stale.map((s) => s.source)).toEqual(['journal', 'hyperliquid', 'reference']);
  });

  it('shows nothing for a scope with no modules, or with ones it does not know', () => {
    const none = scoped({ from: null, to: null, modules: [] });
    expect(none.ledger).toEqual([]);
    expect(none.statement.payouts).toBeNull();
    const unknown = scoped({ from: null, to: null, modules: ['everything'] as unknown as AuditScope['modules'] });
    expect(unknown.ledger).toEqual([]);
  });

  it('places every entry in a module', () => {
    const byId = (id: string) => entryModules(ledger.find((e) => e.id === id) as LedgerEntry);
    expect(byId(`zcash:${receiptNote.id}`)).toEqual(['treasury']);
    expect(byId(`zcash:${deposit.id}`)).toEqual(['treasury', 'swaps']);
    expect(byId(`swap:${SWAP_ID}:in`)).toEqual(['swaps']);
    expect(byId('payout:HF-2026-11-0001:1')).toEqual(['payouts']);
    expect(entryModules(ledger.find((e) => e.kind === 'funding') as LedgerEntry)).toEqual(['hedge']);
  });
});

/** A reader for RFC 4180, to check the writer against. */
function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i] as string;
    if (quoted) {
      if (c === '"' && csv[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && csv[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += c;
  }
  return rows;
}

const entry = (over: Partial<LedgerEntry>): LedgerEntry => ({ ...(ledger[0] as LedgerEntry), ...over });

describe('the ledger as CSV', () => {
  it('writes a header and one CRLF-terminated line per entry', () => {
    const csv = toCsv(ledger);
    const rows = parseCsv(csv);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/);
    expect(rows).toHaveLength(ledger.length + 1);
    expect(rows[0]).toEqual([
      'id', 'time', 'source', 'kind', 'asset', 'amount', 'base_units', 'usd', 'usd_price', 'usd_price_time',
      'reference', 'counterparty_name', 'counterparty_address', 'chain', 'tx', 'block', 'url', 'linked',
    ]);
    expect(rows.every((row) => row.length === 18)).toBe(true);
  });

  it('writes the grant as a row an accountant can read', () => {
    const [, grant] = parseCsv(toCsv(ledger));
    expect(grant).toEqual([
      `zcash:${receiptNote.id}`,
      '2026-10-09T10:12:31.000Z',
      'zcash',
      'receipt',
      'ZEC',
      '0.01975',
      '1975000',
      String(0.01975 * 1219.5),
      '1219.5',
      '2026-10-09T10:00:00.000Z',
      GRANT_MEMO,
      '',
      '',
      'zcash',
      RECEIPT_TX,
      '3512410',
      `https://mainnet.zcashexplorer.app/transactions/${RECEIPT_TX}`,
      '',
    ]);
  });

  it('keeps a negative amount a number', () => {
    const line = toCsv(ledger).split('\r\n').find((l) => l.startsWith(`zcash:${deposit.id},`)) as string;
    expect(line.split(',').slice(5, 7)).toEqual(['-0.0093', '-930000']);
  });

  it('quotes cells that hold a comma, a quote or a line break, doubling the quotes', () => {
    const memo = 'Invoice 14, "rush"\r\nsecond line';
    const csv = toCsv([entry({ ref: memo })]);
    expect(csv).toContain(',"Invoice 14, ""rush""\r\nsecond line",');
    expect(parseCsv(csv)[1]?.[10]).toBe(memo);
  });

  it.each([
    ['=HYPERLINK("http://evil.example","refund")', `"'=HYPERLINK(""http://evil.example"",""refund"")"`],
    ['+1+1', "'+1+1"],
    ['-2+3', "'-2+3"],
    ['-5', "'-5"],
    ['@SUM(A1:A9)', "'@SUM(A1:A9)"],
    ['\tcmd', "'\tcmd"],
  ])('defuses a memo that would run as a formula: %j', (memo, cell) => {
    const line = toCsv([entry({ ref: memo })]).split('\r\n')[1] as string;
    expect(line).toContain(`,${cell},`);
  });

  it('defuses every text column, not just the memo', () => {
    const hostile = entry({
      id: '=id',
      asset: '+asset',
      counterparty: { name: '=cmd|" /C calc"!A0', address: '@address' },
      proof: { chain: '-chain', tx: '=tx', block: 7, url: '=url' },
      linked: ['=one', 'two'],
    });
    const [, row] = parseCsv(toCsv([hostile]));
    expect(row?.[0]).toBe("'=id");
    expect(row?.[4]).toBe("'+asset");
    expect(row?.[11]).toBe(`'=cmd|" /C calc"!A0`);
    expect(row?.[12]).toBe("'@address");
    expect(row?.[13]).toBe("'-chain");
    expect(row?.[14]).toBe("'=tx");
    expect(row?.[15]).toBe('7');
    expect(row?.[16]).toBe("'=url");
    expect(row?.[17]).toBe("'=one two");
  });

  it('leaves harmless text alone', () => {
    const [, row] = parseCsv(toCsv([entry({ ref: 'paid = in full - thanks @all' })]));
    expect(row?.[10]).toBe('paid = in full - thanks @all');
  });

  it('writes blanks where there is no value', () => {
    const [, row] = parseCsv(toCsv([entry({ usd: null, usdPrice: null, usdPriceAt: null, proof: { chain: 'hyperliquid', tx: null, block: null, url: null } })]));
    expect(row?.slice(7, 10)).toEqual(['', '', '']);
    expect(row?.slice(14, 17)).toEqual(['', '', '']);
  });

  it('formats every chain in its own decimals', () => {
    const rows = parseCsv(toCsv(ledger));
    const amountOf = (id: string) => rows.find((row) => row[0] === id)?.slice(4, 7);
    expect(amountOf(`swap:${SWAP_ID}:in`)).toEqual(['USDC', '11.020977', '1102097700']);
    expect(amountOf('payout:HF-2026-11-0001:1')).toEqual(['USDC', '-125.5', '-125500000']);
    expect(amountOf('payout:HF-2026-10-0001:2')).toEqual(['pathUSD', '-300', '-300000000']);
  });
});

describe('the ledger as JSON', () => {
  it('writes amounts as decimal strings and loses nothing else', () => {
    const parsed = JSON.parse(toJson(ledger)) as Record<string, unknown>[];
    expect(parsed).toHaveLength(ledger.length);
    expect(parsed.map((e) => e.amount)).toEqual(ledger.map((e) => e.amount.toString()));
    expect(parsed.map((e) => ({ ...e, amount: BigInt(e.amount as string) }))).toEqual(ledger);
    expect(parsed.find((e) => e.id === 'payout:HF-2026-11-0001:1')).toMatchObject({ amount: '-125500000', ref: solanaRun.lines[0]?.memo });
  });
});
