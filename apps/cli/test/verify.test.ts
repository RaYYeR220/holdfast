import { type LedgerEntry, parsePublishedStatement, type PublishedStatement, serializePublishedStatement } from '@holdfast/books';
import { DEFAULT_POLICY } from '@holdfast/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { holdfast, NO_NETWORK, report, statuses, stepOf } from './harness';
import { BIRTHDAY, demoWorld, GRANT_MEMO, HL_ACCOUNT, RECEIPT_TX, TREASURY_ADDRESS, UFVK, type World } from './world';

const ALL_PASS = { journal: 'PASS', zcash: 'PASS', hyperliquid: 'PASS', reconciliation: 'PASS', arithmetic: 'PASS' };

let world: World;
beforeEach(async () => {
  world = await demoWorld();
});

function tampered(change: (statement: PublishedStatement) => void): string {
  const statement = parsePublishedStatement(world.file);
  change(statement);
  return serializePublishedStatement(statement);
}

const entry = (statement: PublishedStatement, match: (e: LedgerEntry) => boolean): LedgerEntry => {
  const found = statement.ledger.find(match);
  if (found === undefined) throw new Error('the fixture has no such entry');
  return found;
};

/** Verify with the viewing key, against the fake chain and venue. */
const online = (file: string, ...more: string[]) => holdfast(['verify', 'statement.json', '--json', '--ufvk', UFVK, ...more], { 'statement.json': file }, world.sources);
const offline = (file: string) => holdfast(['verify', 'statement.json', '--json', '--offline'], { 'statement.json': file });

describe('verifying a consistent statement', () => {
  it('passes every step and only then exits 0', async () => {
    const outcome = await online(world.file);
    expect(statuses(outcome)).toEqual(ALL_PASS);
    expect(outcome.code).toBe(0);
    expect(report(outcome)).toMatchObject({ ok: true, verdict: 'verified', ageMs: 300_000 });
  });

  it('says in one line what each step established', async () => {
    const outcome = await online(world.file);
    const scannedTo = world.published.org.zcash.scannedTo;
    expect(report(outcome).steps.map((s) => [s.title, s.reason])).toEqual([
      ['journal chain', '7 entries chain from the zero root, all decided under the published policy'],
      ['zcash', `blocks ${BIRTHDAY} to ${scannedTo}: all 4 entries match the chain, and the unspent notes hold the 1030000 zat the ledger adds up to`],
      ['hyperliquid', `account ${HL_ACCOUNT}: all 4 entries match 1 fills and 2 funding payments, and the short of 1 lot(s) they leave`],
      ['reconciliation', "the statement's records agree with each other in 5 places; nothing disagrees"],
      ['arithmetic', expect.stringMatching(/^all \d+ figures follow from the ledger and the journal$/)],
    ]);
  });

  it('says beside each pass what that pass still rests on', async () => {
    const outcome = await online(world.file);
    const scannedTo = world.published.org.zcash.scannedTo as number;
    expect(stepOf(outcome, 'zcash').details).toEqual([
      `the key is the key of ${TREASURY_ADDRESS}; that this is the address the organisation is paid at is for the reader to know`,
      `the scan starts at block ${BIRTHDAY}, which the statement gives as the treasury's first; name your own with --birthday if you know it`,
      `the chain is now at block ${scannedTo}, 0 blocks past the end of the statement`,
      '1 of the payments are booked as deposits into swaps; the chain shows the payments, not what they paid for',
    ]);
    expect(stepOf(outcome, 'hyperliquid').details).toEqual([
      'the account is the one the statement names; name the one you expect with --hyperliquid-account',
      'the account value the journal recorded at each moment is not something the venue can be asked for afterwards',
    ]);
    expect(stepOf(outcome, 'reconciliation').details).toEqual([
      'the 1 payout run(s) are held against the transfers the statement itself lists; Tempo and Solana were not read',
      "the 1 swap(s) are held against the statement's own swap records; the swap service was not asked",
    ]);
    expect(stepOf(outcome, 'arithmetic').details).toEqual([
      "runway is measured against a monthly burn of $4, which is the organisation's own figure",
      "the dollar price applied to each ZEC entry is the ledger's own; no price source was consulted",
    ]);
    expect(stepOf(outcome, 'journal').details).toEqual(['the chain shows the journal was not altered after it was written; nothing here shows it is the only journal ever written']);
  });

  it('prints a readable report by default', async () => {
    const outcome = await holdfast(['verify', 'statement.json', '--ufvk', UFVK], { 'statement.json': world.file }, world.sources);
    const lines = outcome.out.split('\n');
    expect(lines[0]).toBe('Statement statement.json');
    expect(lines[1]).toBe('  Holdfast demo treasury (holdfast-demo), as of 2026-10-09T16:30:30.000Z, 5 minutes ago');
    expect(lines.filter((line) => line.startsWith('  PASS    '))).toHaveLength(5);
    expect(lines.at(-1)).toBe('VERIFIED: all 5 steps passed.');
    expect(outcome.code).toBe(0);
    expect(outcome.err).toBe('');
  });

  it('accepts the birthday and the account the reader already knows', async () => {
    const outcome = await online(world.file, '--birthday', String(BIRTHDAY), '--hyperliquid-account', HL_ACCOUNT.toUpperCase().replace('0X', '0x'));
    expect(statuses(outcome)).toEqual(ALL_PASS);
    expect(stepOf(outcome, 'zcash').details[1]).toBe(`the scan starts at block ${BIRTHDAY}, as asked`);
    expect(stepOf(outcome, 'hyperliquid').details[0]).toBe('the account is the one asked for');
  });

  it('really is the demo history: the grant, the swap and the short', () => {
    const { ledger, statement } = world.published;
    expect(ledger.map((e) => `${e.kind} ${e.amount} ${e.asset}`)).toEqual([
      'receipt 1975000 ZEC',
      'change 0 ZEC',
      'swap_out -930000 ZEC',
      'network_fee -15000 ZEC',
      'swap_in 1102097700 USDC',
      'hedge_open -1000000 ZEC-PERP',
      'trade_fee -551800 USDC',
      'funding 15300 USDC',
      'payout -3000000 pathUSD',
      'payout -1500000 pathUSD',
      'funding 15300 USDC',
    ]);
    expect(entry(world.published, (e) => e.kind === 'receipt')).toMatchObject({ ref: GRANT_MEMO, proof: { tx: RECEIPT_TX } });
    expect(statement.treasury?.zat).toBe(1_030_000n);
    expect(statement.hedge).toMatchObject({ shortLots: 1, coverageBps: 10_000 });
    expect(statement.lock?.lockedSeq).toBe(4);
    expect(statement.stale).toEqual([]);
  });
});

describe('a journal that was touched', () => {
  it('fails on an edited entry, naming it', async () => {
    const file = tampered((s) => {
      s.journal[2]!.decision.reasons = ['nothing to see here'];
    });
    const outcome = await online(file);
    expect(statuses(outcome)).toEqual({ ...ALL_PASS, journal: 'FAIL' });
    expect(stepOf(outcome, 'journal').reason).toBe('entry 3 content does not match its digest');
    expect(outcome.code).toBe(1);
    expect(report(outcome)).toMatchObject({ ok: false, verdict: 'failed' });
  });

  it('fails on an entry whose recorded balance was changed', async () => {
    const file = tampered((s) => {
      s.journal[1]!.snapshot.treasury!.zat += 1n;
    });
    expect(statuses(await offline(file))).toMatchObject({ journal: 'FAIL', reconciliation: 'FAIL' });
  });

  it('fails on a missing entry', async () => {
    const file = tampered((s) => {
      s.journal.splice(2, 1);
    });
    expect(stepOf(await offline(file), 'journal')).toMatchObject({
      status: 'FAIL',
      reason: 'position 3 holds entry 4: the journal does not run 1, 2, 3 without a gap',
    });
  });

  it('fails on a journal that does not start at the beginning', async () => {
    const file = tampered((s) => {
      s.journal.shift();
      s.journal.forEach((e, i) => (e.seq = i + 1));
    });
    expect(stepOf(await offline(file), 'journal')).toMatchObject({ status: 'FAIL', reason: 'entry 1 does not follow the previous entry' });
  });

  it('fails when the published policy is not the one the controller ran under', async () => {
    const file = tampered((s) => {
      s.policy = { ...DEFAULT_POLICY, maxLeverage: 3, marginTargetBps: 4_500, deRiskRestoreBps: 2_800 };
    });
    const outcome = await offline(file);
    expect(stepOf(outcome, 'journal')).toMatchObject({ status: 'FAIL', reason: 'entry 7, the latest, was not decided under the published policy' });
    expect(stepOf(outcome, 'arithmetic').status).toBe('FAIL');
    expect(outcome.code).toBe(1);
  });

  it('fails on a journal that belongs to another organisation', async () => {
    const file = tampered((s) => {
      s.org.id = 'somebody-else';
    });
    expect(stepOf(await offline(file), 'journal').reason).toBe('entry 1 belongs to organisation holdfast-demo, not somebody-else');
  });
});

describe('a ledger that was touched', () => {
  it('fails on a changed treasury amount: it no longer adds up to what the journal recorded', async () => {
    const file = tampered((s) => {
      entry(s, (e) => e.kind === 'receipt').amount += 1n;
    });
    const outcome = await offline(file);
    expect(statuses(outcome)).toEqual({ journal: 'PASS', zcash: 'SKIPPED', hyperliquid: 'SKIPPED', reconciliation: 'FAIL', arithmetic: 'FAIL' });
    expect(stepOf(outcome, 'reconciliation').reason).toBe('1 error: balance_mismatch');
    expect(stepOf(outcome, 'reconciliation').details[0]).toContain('journal entries 2 to 7');
    expect(stepOf(outcome, 'arithmetic').details).toContain('treasury.zat: published 1030000, recomputed 1030001');
    expect(outcome.code).toBe(1);

    expect(statuses(await online(file))).toEqual({ ...ALL_PASS, zcash: 'FAIL', reconciliation: 'FAIL', arithmetic: 'FAIL' });
  });

  it('fails on a changed amount the journal says nothing about: the figures no longer follow', async () => {
    const file = tampered((s) => {
      const funding = entry(s, (e) => e.kind === 'funding');
      funding.amount += 1_000_000n;
      funding.usd = (funding.usd as number) + 0.01;
    });
    const quiet = await offline(file);
    expect(statuses(quiet)).toEqual({ journal: 'PASS', zcash: 'SKIPPED', hyperliquid: 'SKIPPED', reconciliation: 'PASS', arithmetic: 'FAIL' });
    expect(stepOf(quiet, 'arithmetic').details[0]).toMatch(/^funding\.usd: published 0\.000306, recomputed 0\.010306/);

    const checked = await online(file);
    expect(statuses(checked)).toEqual({ ...ALL_PASS, hyperliquid: 'FAIL', arithmetic: 'FAIL' });
    expect(stepOf(checked, 'hyperliquid').details[0]).toMatch(/amount is 1015300 in the ledger and 15300 on Hyperliquid$/);
  });

  it('fails on a changed payout: the ledger no longer holds the paid lines', async () => {
    const file = tampered((s) => {
      entry(s, (e) => e.kind === 'payout').amount = -2_000_000n;
    });
    const outcome = await offline(file);
    expect(statuses(outcome)).toMatchObject({ reconciliation: 'FAIL', arithmetic: 'FAIL' });
    expect(stepOf(outcome, 'reconciliation').reason).toBe('2 errors: malformed_entry, payout_ledger_mismatch');
  });

  it('fails on an entry that appears twice', async () => {
    const file = tampered((s) => {
      s.ledger.push({ ...entry(s, (e) => e.kind === 'receipt') });
    });
    expect(stepOf(await offline(file), 'reconciliation').reason).toMatch(/duplicate_record/);
  });
});

describe('a ledger that leaves out what the chain shows', () => {
  it('fails on a removed entry the scan still finds', async () => {
    const receiptId = entry(world.published, (e) => e.kind === 'receipt').id;
    const file = tampered((s) => {
      s.ledger = s.ledger.filter((e) => e.id !== receiptId);
    });
    const outcome = await online(file);
    const zcash = stepOf(outcome, 'zcash');
    expect(zcash.status).toBe('FAIL');
    expect(zcash.reason).toMatch(/: 1 on chain but not in the ledger, 0 in the ledger but not on chain, 0 that differ$/);
    expect(zcash.details).toEqual([`${receiptId}: the chain shows this receipt of 1975000 ZEC base units, and the ledger does not have it`]);
    expect(outcome.code).toBe(1);
  });

  it('catches an edited memo, which nothing but the scan could', async () => {
    const file = tampered((s) => {
      entry(s, (e) => e.kind === 'receipt').ref = 'Consulting income';
    });
    expect(statuses(await offline(file))).toEqual({ ...ALL_PASS, zcash: 'SKIPPED', hyperliquid: 'SKIPPED' });

    const outcome = await online(file);
    expect(statuses(outcome)).toEqual({ ...ALL_PASS, zcash: 'FAIL' });
    expect(stepOf(outcome, 'zcash').details[0]).toContain(`ref is "Consulting income" in the ledger and ${JSON.stringify(GRANT_MEMO)} on the chain`);
  });

  it('fails on an entry the chain does not show', async () => {
    const file = tampered((s) => {
      const receipt = entry(s, (e) => e.kind === 'receipt');
      s.ledger.push({ ...receipt, id: 'zcash:invented', amount: 0n, usd: 0, kind: 'change', linked: [] });
    });
    const zcash = stepOf(await online(file), 'zcash');
    expect(zcash.reason).toMatch(/0 on chain but not in the ledger, 1 in the ledger but not on chain/);
  });

  it('fails when the chain holds a payment the ledger was made without', async () => {
    world.clock.ms -= 60 * 60_000;
    world.chain.receive('ab'.repeat(32), 50_000n, 'late arrival');
    world.clock.ms += 60 * 60_000;
    const zcash = stepOf(await online(world.file), 'zcash');
    expect(zcash.status).toBe('FAIL');
    expect(zcash.details[0]).toContain('the chain shows this receipt of 50000 ZEC base units');
  });

  it('does not count what happened on chain after the block the statement covers, and says how far the chain has moved on', async () => {
    world.clock.ms += 10 * 60_000;
    world.chain.receive('cd'.repeat(32), 50_000n, 'after the statement');
    const outcome = await online(world.file);
    expect(statuses(outcome)).toEqual(ALL_PASS);
    expect(stepOf(outcome, 'zcash').details[2]).toMatch(/, 8 blocks past the end of the statement$/);
  });

  it('fails on a shielded payment dressed up as the deposit of a swap', async () => {
    // A swap deposit is a transparent payment. Here the treasury's one transparent payment is a shielded one on chain.
    const [spend] = world.chain.mined.filter((tx) => tx.outgoing.length > 0);
    spend!.outgoing[0] = { ...spend!.outgoing[0]!, id: `${spend!.txid}:orchard:out`, pool: 'orchard', memo: 'to a friend' };
    const zcash = stepOf(await online(world.file), 'zcash');
    expect(zcash.status).toBe('FAIL');
    expect(zcash.details.join('\n')).toContain('the chain shows this payment of -930000 ZEC base units, and the ledger does not have it');
  });
});

describe('published figures', () => {
  it('fails on a figure that is off by one zatoshi', async () => {
    const file = tampered((s) => {
      s.statement.treasury!.zat! += 1n;
    });
    const outcome = await online(file);
    expect(statuses(outcome)).toEqual({ ...ALL_PASS, arithmetic: 'FAIL' });
    const arithmetic = stepOf(outcome, 'arithmetic');
    expect(arithmetic.reason).toMatch(/^1 of \d+ figures differ from what the ledger and the journal give$/);
    expect(arithmetic.details).toEqual(['treasury.zat: published 1030001, recomputed 1030000']);
    expect(outcome.code).toBe(1);
  });

  it('allows a dollar figure the last digits of float arithmetic, and no more', async () => {
    const nudged = tampered((s) => {
      s.statement.lock!.navNowUsd! *= 1 + 1e-9;
    });
    expect(statuses(await offline(nudged)).arithmetic).toBe('PASS');

    const wrong = tampered((s) => {
      s.statement.lock!.navNowUsd! *= 1 + 1e-4;
    });
    expect(stepOf(await offline(wrong), 'arithmetic').details[0]).toMatch(/^lock\.navNowUsd: published /);
  });

  it('fails on a whole-number figure that is off by one', async () => {
    const file = tampered((s) => {
      s.statement.hedge!.shortLots += 1;
      s.statement.payouts!.count += 1;
    });
    expect(stepOf(await offline(file), 'arithmetic').details).toEqual(['hedge.shortLots: published 2, recomputed 1', 'payouts.count: published 3, recomputed 2']);
  });

  it('fails on a figure that was left out or added', async () => {
    const file = tampered((s) => {
      s.statement.series.pop();
      (s.statement as unknown as Record<string, unknown>).bonus = 1;
    });
    const details = stepOf(await offline(file), 'arithmetic').details;
    expect(details).toContain('bonus: published 1, recomputed absent');
    expect(details).toContain('series.length: published 6, recomputed 7');
  });

  it('recomputes under the series step the statement names', async () => {
    const file = tampered((s) => {
      s.statement.seriesStep = 'day';
    });
    const details = stepOf(await offline(file), 'arithmetic').details;
    expect(details).toContain('series.length: published 7, recomputed 1');
    expect(details).toContain('series[0].seq: published 1, recomputed 7');
  });
});

describe('the venue', () => {
  it('fails on a fill the ledger does not have', async () => {
    world.venue.fills.push({ ...world.venue.fills[0]!, cloid: null, oid: '570748780001', tid: '999', time: world.venue.fills[0]!.time + 1_000, side: 'buy', direction: 'Close Short' });
    world.venue.shortLots = 0;
    const venue = stepOf(await online(world.file), 'hyperliquid');
    expect(venue.status).toBe('FAIL');
    expect(venue.reason).toMatch(/: 2 on the venue but not in the ledger, 0 in the ledger but not on the venue, 0 that differ$/);
  });

  it('fails when the position is not the one the ledger adds up to', async () => {
    world.venue.shortLots = 3;
    expect(stepOf(await online(world.file), 'hyperliquid')).toMatchObject({
      status: 'FAIL',
      reason: "the fills in the ledger leave a short of 1 lot(s); the venue's position and later fills give 3 at the end of the statement's history",
    });
  });

  it('works the position back through trades made after the statement', async () => {
    const through = world.published.org.hyperliquid.through;
    world.venue.fills.push({ ...world.venue.fills[0]!, cloid: '0x00000000000000000000000000000002', oid: '570748780002', tid: '1000', time: through + 60_000, size: 0.02 });
    world.venue.shortLots = 3;
    const outcome = await online(world.file);
    expect(statuses(outcome)).toEqual(ALL_PASS);
    expect(stepOf(outcome, 'hyperliquid').details).toContain('the account has made 1 fills since the statement');
  });

  it('holds the journal snapshot against the venue too', async () => {
    const file = tampered((s) => {
      s.journal.at(-1)!.snapshot.hl!.shortLots = 2;
    });
    expect(stepOf(await online(file), 'hyperliquid').reason).toBe("the journal's latest snapshot records a short of 2 lot(s); the venue's position and fills give 1 at that moment");
  });
});

describe('what was not checked is not verified', () => {
  it('runs neither chain step offline, touches no network, and does not call the result verified', async () => {
    const outcome = await holdfast(['verify', 'statement.json', '--json', '--offline', '--ufvk', UFVK], { 'statement.json': world.file }, NO_NETWORK);
    expect(statuses(outcome)).toEqual({ ...ALL_PASS, zcash: 'SKIPPED', hyperliquid: 'SKIPPED' });
    expect(stepOf(outcome, 'zcash').reason).toBe('not run: --offline');
    expect(stepOf(outcome, 'hyperliquid').reason).toBe('not run: --offline');
    expect(report(outcome)).toMatchObject({ ok: false, verdict: 'not verified' });
    expect(outcome.code).toBe(1);
    expect(world.chain.scans).toBe(7);
    expect(world.venue.reads).toBe(7);
  });

  it('says so in the verdict', async () => {
    const outcome = await holdfast(['verify', 'statement.json', '--offline'], { 'statement.json': world.file });
    expect(outcome.out.split('\n').at(-1)).toBe(
      'NOT VERIFIED: zcash, hyperliquid were not run, and a statement is verified only when every step has passed. The steps that ran found nothing wrong.',
    );
    expect(outcome.out).not.toMatch(/^VERIFIED/m);
  });

  it('does not run the Zcash step without a viewing key, and one step not run is enough', async () => {
    const outcome = await holdfast(['verify', 'statement.json', '--json'], { 'statement.json': world.file }, world.sources);
    expect(statuses(outcome)).toEqual({ ...ALL_PASS, zcash: 'SKIPPED' });
    expect(stepOf(outcome, 'zcash').reason).toBe('not run: no viewing key given (--ufvk or --ufvk-file)');
    expect(report(outcome).verdict).toBe('not verified');
    expect(outcome.code).toBe(1);
    expect(world.chain.scans).toBe(7);
  });

  it('skips a chain it cannot read, with the error and without the key', async () => {
    world.chain.down = `no Zcash endpoint answered: https://zec.rocks:443 (deadline exceeded for ${UFVK})`;
    const outcome = await online(world.file);
    expect(statuses(outcome)).toEqual({ ...ALL_PASS, zcash: 'SKIPPED' });
    expect(stepOf(outcome, 'zcash').reason).toBe('the chain could not be read: no Zcash endpoint answered: https://zec.rocks:443 (deadline exceeded for [viewing key])');
    expect(outcome.out + outcome.err).not.toContain(UFVK);
    expect(outcome.code).toBe(1);
  });

  it('skips a venue it cannot read, with the error', async () => {
    world.venue.down = 'info userFillsByTime: timed out after 10000 ms';
    const outcome = await online(world.file);
    expect(statuses(outcome)).toEqual({ ...ALL_PASS, hyperliquid: 'SKIPPED' });
    expect(stepOf(outcome, 'hyperliquid').reason).toBe('the venue could not be read: info userFillsByTime: timed out after 10000 ms');
    expect(outcome.code).toBe(1);
  });

  it('skips sources that cannot even be set up', async () => {
    const outcome = await holdfast(['verify', 'statement.json', '--json', '--ufvk', UFVK], { 'statement.json': world.file }, NO_NETWORK);
    expect(statuses(outcome)).toEqual({ ...ALL_PASS, zcash: 'SKIPPED', hyperliquid: 'SKIPPED' });
    expect(stepOf(outcome, 'zcash').reason).toBe('the viewing key could not be examined: the test reached for the key library');
  });

  it('names the failure first when a step failed and others were not run', async () => {
    const file = tampered((s) => {
      s.statement.treasury!.zat! += 1n;
    });
    const outcome = await holdfast(['verify', 'statement.json', '--offline'], { 'statement.json': file });
    expect(outcome.code).toBe(1);
    expect(outcome.out.split('\n').at(-1)).toBe('FAILED: arithmetic. Not run: zcash, hyperliquid.');
  });
});

describe('the viewing key', () => {
  it('can be read from a file', async () => {
    const files = { 'statement.json': world.file, 'key.txt': `${UFVK}\n` };
    const outcome = await holdfast(['verify', 'statement.json', '--json', '--ufvk-file', 'key.txt'], files, world.sources);
    expect(statuses(outcome)).toEqual(ALL_PASS);
  });

  it('is given to the scanner with the range the journal confirmed, on the endpoints the reader named', async () => {
    const asked: unknown[] = [];
    const scan = world.chain.scan.bind(world.chain);
    world.chain.scan = async (i) => {
      asked.push(i);
      return scan(i);
    };
    const endpoints: unknown[] = [];
    const sources = { ...world.sources, zcash: async (given: readonly string[]) => (endpoints.push(given), world.chain) };
    await holdfast(['verify', 'statement.json', '--ufvk', UFVK, '--zcash-endpoint', 'https://a:443', '--zcash-endpoint=https://b:443'], { 'statement.json': world.file }, sources);
    expect(asked).toEqual([{ ufvk: UFVK, fromHeight: BIRTHDAY, toHeight: world.published.org.zcash.scannedTo, knownNullifiers: [] }]);
    expect(endpoints).toEqual([['https://a:443', 'https://b:443']]);
  });

  it('must come from one place', async () => {
    const outcome = await holdfast(['verify', 'statement.json', '--ufvk', UFVK, '--ufvk-file', 'key.txt'], { 'statement.json': world.file, 'key.txt': UFVK });
    expect(outcome.code).toBe(1);
    expect(outcome.err).toMatch(/^holdfast: give the viewing key with --ufvk or with --ufvk-file, not both/);
    expect(outcome.err).not.toContain(UFVK);
  });

  it('must not be empty, and its file must exist', async () => {
    const empty = await holdfast(['verify', 'statement.json', '--ufvk-file', 'key.txt'], { 'statement.json': world.file, 'key.txt': ' \n' });
    expect(empty).toMatchObject({ code: 1 });
    expect(empty.err).toMatch(/the viewing key is empty/);
    const missing = await holdfast(['verify', 'statement.json', '--ufvk-file', 'nowhere.txt'], { 'statement.json': world.file });
    expect(missing).toMatchObject({ code: 1, out: '' });
    expect(missing.err).toMatch(/^Cannot verify statement\.json: ENOENT/);
  });
});

describe('files that are not statements', () => {
  it('refuses a file that does not exist', async () => {
    const outcome = await holdfast(['verify', 'nowhere.json']);
    expect(outcome).toMatchObject({ code: 1, out: '' });
    expect(outcome.err).toBe("Cannot verify nowhere.json: ENOENT: no such file or directory, open 'nowhere.json'");
  });

  it('refuses a file that is not JSON', async () => {
    const outcome = await holdfast(['verify', 'statement.json'], { 'statement.json': world.file.slice(0, 200) });
    expect(outcome.code).toBe(1);
    expect(outcome.err).toMatch(/^Cannot verify statement\.json: not a published statement: not valid JSON/);
  });

  it('refuses a version it does not understand', async () => {
    const outcome = await holdfast(['verify', 'statement.json'], { 'statement.json': world.file.replace('"version": 1', '"version": 9') });
    expect(outcome.err).toBe('Cannot verify statement.json: not a published statement: version 9 is not supported; this reader understands version 1');
  });

  it('refuses a statement with a malformed ledger rather than computing from it', async () => {
    const outcome = await holdfast(['verify', 'statement.json'], { 'statement.json': world.file.replace('"decimals": 8', '"decimals": "eight"') });
    expect(outcome.code).toBe(1);
    expect(outcome.err).toMatch(/statement file\.ledger\[0\]\.decimals: expected a whole number/);
  });

  it('wants exactly one file and options it knows', async () => {
    expect((await holdfast(['verify'])).err).toMatch(/^holdfast: verify needs a statement file/);
    expect((await holdfast(['verify', 'a.json', 'b.json'])).err).toMatch(/^holdfast: verify takes one statement file, got 2/);
    expect((await holdfast(['verify', 'a.json', '--fast'])).err).toMatch(/^holdfast: unknown option --fast/);
    expect((await holdfast(['verify', 'a.json', '--birthday', 'genesis'])).err).toMatch(/^holdfast: --birthday takes a block height, got "genesis"/);
  });
});
