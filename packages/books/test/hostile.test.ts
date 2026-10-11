import { DEFAULT_POLICY, digest } from '@holdfast/core';
import { describe, expect, it } from 'vitest';
import {
  buildLedger,
  buildPublishedStatement,
  buildStatement,
  type LedgerEntry,
  parseExact,
  parsePublishedStatement,
  policyInForce,
  type PublishedOrg,
  reconcile,
  type Reconciliation,
  serializePublishedStatement,
  stringifyExact,
} from '../src/index';
import {
  BIRTHDAY,
  CLOID,
  HL_ACCOUNT,
  NOW,
  OID,
  ORG,
  PAYOUTS_NOW,
  POLICY,
  SPEND_HEIGHT,
  SWAP_ID,
  deposit,
  historyWithPayouts,
  journalOf,
  openShort,
  realHistory,
  realTicks,
  receiptNote,
  tempoRun,
} from './fixtures';

/**
 * A ledger that was written to be believed rather than built from records.
 * Each case changes one thing that used to go unnoticed.
 */
const history = historyWithPayouts();
const honest = buildLedger(history.records);
const books = (ledger: LedgerEntry[]) => ({ ledger, journal: history.journal, payouts: history.payouts, swaps: [...history.records.swaps] });
const edit = (id: string, change: (entry: LedgerEntry) => Partial<LedgerEntry>) => honest.map((e) => (e.id === id ? { ...e, ...change(e) } : e));
const kinds = (result: Reconciliation) => result.problems.filter((p) => p.severity === 'error').map((p) => p.kind);
const detail = (result: Reconciliation, kind: string) => result.problems.find((p) => p.kind === kind)?.detail;

const PAYOUT = 'payout:HF-2026-10-0001:1';
const ARRIVAL = `swap:${SWAP_ID}:in`;
const DEPOSIT = `zcash:${deposit.id}`;
const FILL_FEE = `hl:fee:${OID}:${openShort.tid}`;

describe('an entry whose fields do not answer for each other', () => {
  it('is honest to begin with', () => {
    expect(reconcile(books(honest)).problems).toEqual([]);
  });

  it('cannot shrink a payout by claiming more decimals for its token', () => {
    const shrunk = edit(PAYOUT, () => ({ decimals: 9, usd: -0.45 }));
    const result = reconcile(books(shrunk));
    expect(kinds(result)).toEqual(['payout_ledger_mismatch']);
    expect(detail(result, 'payout_ledger_mismatch')).toBe(`ledger entry ${PAYOUT} differs from its payout line in its decimals`);
  });

  it('cannot state a dollar value that is not the amount at the price', () => {
    const result = reconcile(books(edit(PAYOUT, () => ({ usd: -4.5 }))));
    expect(kinds(result)).toEqual(['malformed_entry', 'payout_ledger_mismatch']);
    expect(detail(result, 'malformed_entry')).toBe(`ledger entry ${PAYOUT} carries a dollar value that is not its amount at its price`);
  });

  it('cannot price a stablecoin away from a dollar', () => {
    const result = reconcile(books(edit(PAYOUT, () => ({ usd: -900, usdPrice: 2 }))));
    expect(detail(result, 'malformed_entry')).toBe(`ledger entry ${PAYOUT} prices a stablecoin away from one dollar`);
  });

  it('cannot move a payout into another month, or onto another payee', () => {
    const moved = reconcile(books(edit(PAYOUT, (e) => ({ ts: e.ts + 40 * 86_400_000 }))));
    expect(detail(moved, 'payout_ledger_mismatch')).toBe(`ledger entry ${PAYOUT} differs from its payout line in its date`);
    const renamed = reconcile(books(edit(PAYOUT, (e) => ({ counterparty: { name: 'Somebody Else', address: e.counterparty!.address } }))));
    expect(detail(renamed, 'payout_ledger_mismatch')).toBe(`ledger entry ${PAYOUT} differs from its payout line in its counterparty name`);
    const rerouted = reconcile(books(edit(PAYOUT, () => ({ source: 'solana' }))));
    expect(detail(rerouted, 'payout_ledger_mismatch')).toBe(`ledger entry ${PAYOUT} differs from its payout line in its source`);
  });

  it('cannot give a swap arrival the decimals of another chain', () => {
    const result = reconcile(books(edit(ARRIVAL, () => ({ decimals: 6, usd: 1102.0977 }))));
    expect(kinds(result)).toEqual(['swap_arrival_mismatch']);
    expect(detail(result, 'swap_arrival_mismatch')).toContain('in its decimals');
  });

  it('cannot book a deposit against a swap under another deposit address', () => {
    const result = reconcile(books(edit(DEPOSIT, () => ({ counterparty: { name: null, address: 't1SomewhereElse' } }))));
    expect(kinds(result)).toEqual(['swap_ledger_mismatch']);
  });

  it('cannot carry a fee or a profit that belongs to no fill', () => {
    const orphan = { ...(honest.find((e) => e.id === FILL_FEE) as LedgerEntry), id: 'hl:fee:1:1', amount: 5_000_000_000n, usd: 50, kind: 'realized_pnl' as const };
    const result = reconcile(books([...honest, orphan]));
    expect(detail(result, 'malformed_entry')).toBe('ledger entry hl:fee:1:1 belongs to no fill in the ledger');
  });

  it('cannot book change with an amount, or an inflow with a minus', () => {
    const change = honest.find((e) => e.kind === 'change') as LedgerEntry;
    expect(detail(reconcile(books(edit(change.id, () => ({ amount: 5n })))), 'malformed_entry')).toContain('is change booked with an amount');
    expect(detail(reconcile(books(edit(ARRIVAL, (e) => ({ amount: -e.amount, usd: -(e.usd as number) })))), 'malformed_entry')).toContain('is a swap_in with a negative amount');
  });

  it('cannot pay in a token nobody here knows the decimals of', () => {
    const unlisted = { ...tempoRun, token: '0x1111111111111111111111111111111111111111' };
    const ledger = buildLedger({ ...history.records, payoutRuns: [unlisted, history.records.payoutRuns[1]!], assets: { [unlisted.token]: { symbol: 'pathUSD', decimals: 6, chain: 'tempo', usdPegged: true } } });
    const result = reconcile({ ...books(ledger), payouts: history.payouts.map((p) => (p.run.id === tempoRun.id ? { ...p, run: unlisted } : p)) });
    expect(kinds(result)).toContain('unknown_token');
    // The caller's own directory is a different matter from one the records could bring along.
    const known = reconcile({ ...books(ledger), payouts: history.payouts.map((p) => (p.run.id === tempoRun.id ? { ...p, run: unlisted } : p)), assets: { [unlisted.token]: { symbol: 'pathUSD', decimals: 6, chain: 'tempo', usdPegged: true } } });
    expect(known.problems).toEqual([]);
  });
});

describe('an entry of a kind its source does not produce', () => {
  const real = realHistory();
  const ledger = buildLedger(real.records);
  const statementOf = (entries: LedgerEntry[]) => buildStatement({ ledger: entries, journal: real.journal, policy: POLICY, now: NOW, monthlyBurnUsd: 4 });
  const receipt = ledger.find((e) => e.kind === 'receipt') as LedgerEntry;
  // Not from the Zcash scan, so no chain check would ever look at them.
  const fakePayment: LedgerEntry = { ...receipt, id: 'swap:fake:payment', source: 'swap', kind: 'payment', amount: -400_000n, usd: -4.9, ts: NOW - 60_000, proof: { ...receipt.proof, block: null } };
  const fakeReceipt: LedgerEntry = { ...receipt, id: 'tempo:fake:receipt', source: 'tempo', amount: 900_000_000n, usd: 11_000 };

  it('is reported', () => {
    const result = reconcile({ ledger: [...ledger, fakePayment, fakeReceipt], journal: real.journal, swaps: real.records.swaps });
    expect(kinds(result)).toEqual(['malformed_entry', 'malformed_entry']);
    expect(detail(result, 'malformed_entry')).toBe('ledger entry swap:fake:payment is a payment from swap, which that source does not produce');
  });

  it('counts towards no figure', () => {
    const clean = statementOf(ledger);
    const padded = statementOf([...ledger, fakePayment, fakeReceipt]);
    expect(padded.receipts).toEqual(clean.receipts);
    expect(padded.payments).toEqual(clean.payments);
    expect(padded.treasury).toEqual(clean.treasury);
    // A payment since the lock would have been taken out of the drift as money leaving on purpose.
    expect(padded.lock).toEqual(clean.lock);
  });
});

describe('swaps', () => {
  const real = realHistory();
  const unfunded = buildLedger({ ...real.records, outgoing: [] });
  const leg = `swap:${SWAP_ID}:out`;

  it('decides whether a swap was paid in ZEC from the swap record, not from the label on its leg', () => {
    const relabelled = unfunded.map((e) => (e.id === leg ? { ...e, asset: 'USDC' } : e));
    const result = reconcile({ ledger: relabelled, journal: real.journal, swaps: real.records.swaps });
    expect(kinds(result)).toContain('unfunded_swap');
  });

  it('pairs the legs of a swap by the swap, not by what an entry says it is linked to', () => {
    const both = buildLedger(history.records);
    const smallDeposit = both.find((e) => e.kind === 'swap_out' && e.ref === SWAP_ID) as LedgerEntry;
    const bigArrival = both.find((e) => e.kind === 'swap_in' && e.ref !== SWAP_ID) as LedgerEntry;
    const relinked = both.map((e) => (e.id === bigArrival.id ? { ...e, linked: [smallDeposit.id] } : e));
    const at = { journal: history.journal, policy: POLICY, now: PAYOUTS_NOW, monthlyBurnUsd: null };
    expect(buildStatement({ ...at, ledger: relinked }).fees.swapUsd).toBe(buildStatement({ ...at, ledger: both }).fees.swapUsd);
  });
});

describe('balances', () => {
  const real = realHistory();
  const ledger = buildLedger(real.records);

  it('cannot be put beyond checking by one note the key cannot follow', () => {
    // The fee is dropped from the ledger, and a single zatoshi of untraceable income is added to blur the balance.
    const dust: LedgerEntry = { ...(ledger.find((e) => e.kind === 'receipt') as LedgerEntry), id: 'zcash:dust', kind: 'receipt_untracked', amount: 1n, usd: 0.0000122, ref: '' };
    const blurred = [...ledger.filter((e) => e.kind !== 'network_fee'), dust];
    const result = reconcile({ ledger: blurred, journal: real.journal, swaps: real.records.swaps });
    expect(kinds(result)).toEqual(['balance_mismatch']);
    expect(detail(result, 'balance_mismatch')).toContain('between 1045000 and 1045001 zat (-15000)');
  });

  it('places a balance within what untraceable notes allow, and says how loosely', () => {
    const sapling = { ...receiptNote, id: 'tx-sapling:sapling:0', txid: 'tx-sapling', pool: 'sapling' as const, nullifier: null, spent: false, zat: 400_000n, height: SPEND_HEIGHT + 5, time: 0 };
    const result = reconcile({ ledger: buildLedger({ ...real.records, notes: [...real.records.notes, sapling] }), journal: real.journal, swaps: real.records.swaps });
    expect(kinds(result)).toEqual([]);
    expect(detail(result, 'balance_unverifiable')).toContain('400000 zat were received in a pool whose spends a viewing key cannot follow');
  });

  it('must reach every treasury entry', () => {
    const late = { ...receiptNote, id: 'tx-late:orchard:0', txid: 'tx-late', height: SPEND_HEIGHT + 5_000, time: NOW + 3_600_000, zat: 77n, spent: false, nullifier: 'ff'.repeat(32) };
    const result = reconcile({ ledger: buildLedger({ ...real.records, notes: [...real.records.notes, late] }), journal: real.journal, swaps: real.records.swaps });
    expect(kinds(result)).toEqual(['balance_unrecorded']);
    expect(result.problems[0]).toMatchObject({ severity: 'error', refs: ['zcash:tx-late:orchard:0'] });
    expect(result.problems[0]?.detail).toBe('1 treasury entry lies beyond any balance in the journal (the last balance the journal recorded is in entry 5): nothing recorded at the time confirms them');
  });

  it('cannot be avoided by a journal that never read the treasury', () => {
    const blind = journalOf(realTicks.map(({ at, venue }) => ({ at, venue, treasury: null })));
    const result = reconcile({ ledger: ledger.filter((e) => e.source === 'zcash'), journal: blind });
    expect(kinds(result)).toContain('balance_unrecorded');
    expect(detail(result, 'balance_unrecorded')).toContain('the journal recorded no balance at all');
  });
});

describe('orders', () => {
  it('does not take a fill in another market for an order of the controller', () => {
    const real = realHistory();
    const elsewhere = buildLedger({ ...real.records, fills: [{ ...openShort, coin: 'BTC' }] });
    const result = reconcile({ ledger: elsewhere, journal: real.journal, swaps: real.records.swaps });
    expect(kinds(result).sort()).toEqual(['fill_without_order', 'order_without_fill']);
    expect(detail(result, 'fill_without_order')).toContain('is in BTC-PERP, a market the controller does not trade');
    expect(CLOID).toBe(openShort.cloid);
  });
});

const org: PublishedOrg = {
  id: ORG,
  name: 'Holdfast demo treasury',
  zcash: { network: 'mainnet', address: 'u1demotreasuryaddress0qxyz', birthday: BIRTHDAY, scannedTo: SPEND_HEIGHT + 117 },
  hyperliquid: { account: HL_ACCOUNT, since: Date.parse('2026-10-01T00:00:00Z'), through: NOW },
  payoutAccounts: [],
};

describe('publishing', () => {
  const real = realHistory();
  const input = { org, policy: POLICY, ledger: buildLedger(real.records), journal: real.journal, swaps: real.records.swaps, payouts: [], now: NOW, monthlyBurnUsd: 4 };

  it('names the treasury a viewing key has to belong to', () => {
    const read = parsePublishedStatement(serializePublishedStatement(buildPublishedStatement(input)));
    expect(read.org.zcash.address).toBe('u1demotreasuryaddress0qxyz');
    const without = parseExact(serializePublishedStatement(buildPublishedStatement(input))) as { org: { zcash: Record<string, unknown> } };
    delete without.org.zcash.address;
    expect(() => parsePublishedStatement(stringifyExact(without))).toThrow('statement file.org.zcash.address: missing');
  });

  it('refuses a file that states two different moments', () => {
    const file = parseExact(serializePublishedStatement(buildPublishedStatement(input))) as { generatedAt: number };
    file.generatedAt += 86_400_000;
    expect(() => parsePublishedStatement(stringifyExact(file))).toThrow('generatedAt: differs from statement.asOf');
  });

  it('judges staleness by the policy, with no way to ask for a longer leash', () => {
    const late = buildPublishedStatement({ ...input, now: NOW + 600_000 });
    expect(late.statement.staleAfterMs).toBe(POLICY.maxDataAgeMs);
    expect(late.statement.stale.map((s) => s.source)).toEqual(['journal', 'zcash', 'hyperliquid', 'reference']);
    expect(late.statement.hedge).toBeNull();
  });

  it('refuses to publish a secret it was told about, wherever it sits in the journal', () => {
    const rpc = 'https://lightwalletd.example/v1/3f9c2a77d1e04b5a';
    const journal = journalOf(realTicks.map((tick, i) => (i === 1 ? { ...tick, treasury: null } : tick)));
    journal[1]!.errors = [{ source: 'treasury', message: `no Zcash endpoint answered: ${rpc} (deadline exceeded)` }];
    expect(() => buildPublishedStatement({ ...input, journal, secrets: ['', rpc] })).toThrow('refusing to publish: the export would contain secret number 2');
    expect(() => buildPublishedStatement({ ...input, journal, secrets: ['something-else'] })).not.toThrow();
  });

  it('refuses to publish anything that looks like a viewing key', () => {
    const key = `uview1${'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(3)}`;
    const journal = structuredClone(real.journal);
    journal[0]!.errors = [{ source: 'treasury', message: `scan failed for ${key}` }];
    expect(() => buildPublishedStatement({ ...input, journal })).toThrow('refusing to publish: the export would contain a viewing key');
  });

  it('builds the statement under the policy the journal shows to be in force', () => {
    const lockOff = { ...DEFAULT_POLICY, hedgeRatioBps: 0 };
    const journal = journalOf(realTicks.slice(0, 2), lockOff);
    expect(policyInForce(DEFAULT_POLICY, journal)).toEqual(lockOff);
    expect(policyInForce(DEFAULT_POLICY, real.journal)).toEqual(DEFAULT_POLICY);
    expect(policyInForce({ ...DEFAULT_POLICY, maxSlippageBps: 31 }, real.journal)).toBeNull();
    expect(journal.at(-1)?.policyDigest).toBe(digest(lockOff));

    // The published ratio says 100%; the controller is running at zero, and the target says so.
    const published = buildPublishedStatement({ ...input, journal, ledger: buildLedger({ notes: real.records.notes, outgoing: real.records.outgoing, fees: real.records.fees, swaps: [] }), swaps: [], now: realTicks[1]!.at + 1_000 });
    expect(published.policy.hedgeRatioBps).toBe(10_000);
    expect(published.statement.hedge).toMatchObject({ targetLots: 0, coverageBps: null });
  });
});

describe('amounts read from a file', () => {
  it('are bounded: a run of digits longer than any chain amount is not one', () => {
    expect(parseExact(`{"zat":{"$bigint":"${'9'.repeat(78)}"}}`)).toEqual({ zat: BigInt('9'.repeat(78)) });
    expect(() => parseExact(`{"zat":{"$bigint":"${'9'.repeat(79)}"}}`)).toThrow('malformed amount');
    expect(() => parseExact(`{"zat":{"$bigint":"${'9'.repeat(200_000)}"}}`)).toThrow('malformed amount');
  });

  it('are not tags inside tags', () => {
    expect(() => parseExact('{"zat":{"$bigint":{"$bigint":"5"}}}')).toThrow('malformed amount');
  });
});
