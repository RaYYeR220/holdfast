import { ZERO_ROOT } from '@holdfast/core';
import { verifyChain } from '@holdfast/engine';
import { describe, expect, it } from 'vitest';
import {
  buildLedger,
  buildPublishedStatement,
  buildStatement,
  parseExact,
  parsePublishedStatement,
  PUBLISHED_STATEMENT_VERSION,
  type PublishedOrg,
  PublishedStatementError,
  reconcile,
  serializePublishedStatement,
  stringifyExact,
} from '../src/index';
import { BIRTHDAY, HL_ACCOUNT, NOW, ORG, PAYOUTS_NOW, POLICY, SOLANA_USDC_MINT, SPEND_HEIGHT, TEMPO_PATH_USD, historyWithPayouts, realHistory } from './fixtures';

const TREASURY_ADDRESS = 'u1demotreasuryaddress0qxyz';

const org: PublishedOrg = {
  id: ORG,
  name: 'Holdfast demo treasury',
  zcash: { network: 'mainnet', address: TREASURY_ADDRESS, birthday: BIRTHDAY, scannedTo: SPEND_HEIGHT + 117 },
  hyperliquid: { account: HL_ACCOUNT, since: Date.parse('2026-10-01T00:00:00Z'), through: NOW },
  payoutAccounts: [
    { chain: 'tempo', account: '0x52908400098527886E0F7030069857D2E4169EE7', token: TEMPO_PATH_USD },
    { chain: 'solana', account: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', token: SOLANA_USDC_MINT },
  ],
};

function publish(history = historyWithPayouts()) {
  return buildPublishedStatement({
    org,
    policy: POLICY,
    ledger: buildLedger(history.records),
    journal: history.journal,
    swaps: history.records.swaps,
    payouts: history.payouts,
    now: PAYOUTS_NOW,
    monthlyBurnUsd: 4,
  });
}

describe('exact JSON', () => {
  it('gives back the amounts it was given', () => {
    const value = { zat: 1_975_000n, big: 2n ** 80n, negative: -15_000n, nested: [{ amount: 0n }], px: 1226.4, text: '12', none: null };
    expect(parseExact(stringifyExact(value))).toEqual(value);
    expect(stringifyExact({ zat: 5n })).toBe('{"zat":{"$bigint":"5"}}');
  });

  it('refuses a tag that does not hold an amount', () => {
    expect(() => parseExact('{"zat":{"$bigint":"12.5"}}')).toThrow('malformed amount');
    expect(() => parseExact('{"zat":{"$bigint":7}}')).toThrow('malformed amount');
  });

  it('leaves an ordinary object with other keys alone', () => {
    expect(parseExact('{"a":{"$bigint":"1","b":2}}')).toEqual({ a: { $bigint: '1', b: 2 } });
  });
});

describe('a published statement', () => {
  it('holds the organisation, the policy, the records and the figures derived from them', () => {
    const history = historyWithPayouts();
    const ledger = buildLedger(history.records);
    const published = publish(history);
    expect(published.version).toBe(PUBLISHED_STATEMENT_VERSION);
    expect(published.generatedAt).toBe(PAYOUTS_NOW);
    expect(published.org).toEqual(org);
    expect(published.policy).toEqual(POLICY);
    expect(published.ledger).toEqual(ledger);
    expect(published.journal).toEqual(history.journal);
    expect(published.swaps).toEqual(history.records.swaps);
    expect(published.payouts).toEqual(history.payouts);
    expect(published.statement).toEqual(buildStatement({ ledger, journal: history.journal, policy: POLICY, now: PAYOUTS_NOW, monthlyBurnUsd: 4 }));
  });

  it('passes on the options the statement was built with', () => {
    const history = realHistory();
    const published = buildPublishedStatement({
      org,
      policy: POLICY,
      ledger: buildLedger(history.records),
      journal: history.journal,
      swaps: history.records.swaps,
      payouts: [],
      now: NOW,
      monthlyBurnUsd: null,
      range: { from: 0, to: NOW },
      seriesStep: 'entry',
    });
    expect(published.statement).toMatchObject({ range: { from: 0, to: NOW }, staleAfterMs: POLICY.maxDataAgeMs, seriesStep: 'entry', monthlyBurnUsd: null });
    expect(published.statement.series).toHaveLength(5);
  });

  it('survives being written to a file and read back, amounts and digests intact', () => {
    const published = publish();
    const read = parsePublishedStatement(serializePublishedStatement(published));
    expect(read).toEqual(published);
    expect(verifyChain(read.journal, ZERO_ROOT)).toEqual({ ok: true });
    expect(typeof read.ledger[0]?.amount).toBe('bigint');
    expect(reconcile(read).problems).toEqual([]);
  });

  it('publishes only the fields it names, whatever else the rows carry', () => {
    const history = historyWithPayouts();
    const rows = {
      org: { ...org, ufvk: 'uview1secretsecretsecretsecret', keys: ['0xprivate'] },
      swaps: history.records.swaps.map((swap) => ({ ...swap, orgId: ORG, quote: { signature: 'ed25519:quote-signature' } })),
      payouts: history.payouts.map(({ run, onChain }) => ({
        run: { ...run, orgId: ORG, signedTx: '0xsigned-transaction', error: 'internal note', lines: run.lines.map((line) => ({ ...line, reconciled: true })) },
        onChain,
      })),
      ledger: buildLedger(history.records).map((entry) => ({ ...entry, internal: 'scratch' })),
    };
    const published = buildPublishedStatement({ ...rows, policy: POLICY, journal: history.journal, now: PAYOUTS_NOW, monthlyBurnUsd: 4 });
    const text = serializePublishedStatement(published);
    for (const leak of ['uview1', '0xprivate', 'quote-signature', '0xsigned-transaction', 'internal note', 'reconciled', 'scratch']) {
      expect(text).not.toContain(leak);
    }
    expect(published).toEqual(publish(history));
  });

  it('does not share its journal with the caller', () => {
    const history = realHistory();
    const published = publish(history);
    history.journal[0]!.snapshot.now = 0;
    expect(published.journal[0]?.snapshot.now).not.toBe(0);
  });
});

describe('reading a statement file', () => {
  const text = () => serializePublishedStatement(publish());
  const tampered = (change: (file: Record<string, unknown>) => void) => {
    const file = parseExact(text()) as Record<string, unknown>;
    change(file);
    return stringifyExact(file);
  };
  const faultsOf = (json: string): string[] => {
    try {
      parsePublishedStatement(json);
    } catch (e) {
      if (e instanceof PublishedStatementError) return e.faults;
      throw e;
    }
    return [];
  };

  it('refuses a file that is not JSON', () => {
    expect(faultsOf('{"version": 1,')[0]).toMatch(/^not valid JSON/);
    expect(() => parsePublishedStatement('')).toThrow(PublishedStatementError);
  });

  it('refuses a version it does not understand', () => {
    expect(faultsOf(tampered((file) => (file.version = 2)))).toEqual(['version 2 is not supported; this reader understands version 1']);
    expect(faultsOf('[]')).toEqual(['version missing is not supported; this reader understands version 1']);
    expect(faultsOf('null')[0]).toContain('version missing');
  });

  it('says what is missing', () => {
    const faults = faultsOf(
      tampered((file) => {
        delete file.ledger;
        delete (file.org as Record<string, unknown>).hyperliquid;
      }),
    );
    expect(faults).toEqual(['statement file.org.hyperliquid: missing', 'statement file.ledger: missing']);
  });

  it('says which entry is malformed, and how', () => {
    const faults = faultsOf(
      tampered((file) => {
        const ledger = file.ledger as Record<string, unknown>[];
        ledger[0]!.amount = 1975000;
        ledger[1]!.kind = 'gift';
        (ledger[2]!.proof as Record<string, unknown>).block = 'high';
        (file.journal as Record<string, unknown>[])[0]!.seq = '1';
        (file.swaps as Record<string, unknown>[])[0]!.amountOut = '5';
        delete (file.policy as Record<string, unknown>).maxLeverage;
      }),
    );
    expect(faults).toEqual([
      'statement file.policy.maxLeverage: missing',
      'statement file.ledger[0].amount: expected an amount',
      expect.stringMatching(/^statement file\.ledger\[1\]\.kind: expected one of receipt, /),
      'statement file.ledger[2].proof.block: expected a whole number',
      'statement file.journal[0].seq: expected a whole number',
      'statement file.swaps[0].amountOut: expected an amount',
    ]);
  });

  it('summarises a long list of faults in its message', () => {
    const json = tampered((file) => {
      for (const entry of file.ledger as Record<string, unknown>[]) entry.ts = 'yesterday';
    });
    expect(() => parsePublishedStatement(json)).toThrow(/^not a published statement: .* and \d+ more$/);
  });

  it('accepts fields it does not know about', () => {
    const json = tampered((file) => {
      file.note = 'added by a later version';
      (file.org as Record<string, unknown>).website = 'https://example.org';
    });
    expect(parsePublishedStatement(json).org.id).toBe(ORG);
  });
});
