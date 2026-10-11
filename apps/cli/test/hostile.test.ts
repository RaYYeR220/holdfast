import { buildPublishedStatement, buildStatement, parsePublishedStatement, type PublishedStatement, serializePublishedStatement } from '@holdfast/books';
import { DEFAULT_POLICY } from '@holdfast/core';
import { describe, expect, it } from 'vitest';
import { holdfast, READING_AT, report, statuses, stepOf } from './harness';
import { BIRTHDAY, demoWorld, HL_ACCOUNT, OTHER_ADDRESS, OTHER_UFVK, TESTNET_UFVK, TREASURY_ADDRESS, UFVK, type World } from './world';

/**
 * The statement file is written by the party being checked. Each case here is
 * a statement shaped to get past a step without being checked by it, or to
 * make the report say something the steps did not find.
 */
const verify = (world: World, file: string, ...more: string[]) =>
  holdfast(['verify', 'statement.json', '--json', '--ufvk', UFVK, ...more], { 'statement.json': file }, world.sources);

function reshaped(world: World, change: (statement: PublishedStatement) => void): string {
  const statement = parsePublishedStatement(world.file);
  change(statement);
  return serializePublishedStatement(statement);
}

/** Publish again from the parts of a statement, as its author could: the figures then follow from whatever was kept. */
function republished(statement: PublishedStatement, keep: Partial<Pick<PublishedStatement, 'ledger' | 'journal' | 'swaps' | 'payouts'>>): string {
  const parts = { ledger: statement.ledger, journal: statement.journal, swaps: statement.swaps, payouts: statement.payouts, ...keep };
  return serializePublishedStatement(buildPublishedStatement({ ...parts, org: statement.org, policy: statement.policy, now: statement.statement.asOf, monthlyBurnUsd: 4, seriesStep: 'entry' }));
}

describe('a statement that says nothing about the treasury', () => {
  it('fails the Zcash step by name instead of having it skipped', async () => {
    // Its own scanner never reached the chain: no scanned block, no Zcash entry, and a journal that agrees.
    const world = await demoWorld({ blindToZcash: true });
    expect(world.published.org.zcash.scannedTo).toBeNull();
    expect(world.published.ledger.filter((e) => e.source === 'zcash')).toEqual([]);

    const outcome = await verify(world, world.file);
    expect(statuses(outcome)).toEqual({ journal: 'PASS', zcash: 'FAIL', hyperliquid: 'PASS', reconciliation: 'PASS', arithmetic: 'PASS' });
    expect(stepOf(outcome, 'zcash').reason).toBe('the statement names no block its Zcash history reaches, so none of it can be held against the chain');
    expect(report(outcome)).toMatchObject({ ok: false, verdict: 'failed' });
    expect(outcome.code).toBe(1);
  });

  it('fails it offline too: what the statement leaves out does not need a network to notice', async () => {
    const world = await demoWorld({ blindToZcash: true });
    const outcome = await holdfast(['verify', 'statement.json', '--json', '--offline'], { 'statement.json': world.file });
    expect(statuses(outcome).zcash).toBe('FAIL');
  });

  it('fails the reconciliation when nothing in it can be held against anything', async () => {
    const world = await demoWorld({ blindToZcash: true });
    const hollow = republished(world.published, { ledger: [], payouts: [] });
    const outcome = await verify(world, hollow);
    expect(stepOf(outcome, 'reconciliation')).toMatchObject({ status: 'FAIL', reason: 'nothing in the statement could be held against anything else in it' });
  });

  it('fails without a journal', async () => {
    const world = await demoWorld();
    const outcome = await verify(world, republished(world.published, { journal: [] }));
    expect(stepOf(outcome, 'journal')).toMatchObject({ status: 'FAIL', reason: 'the statement carries no journal: there is nothing to hold its figures against' });
    expect(outcome.code).toBe(1);
  });
});

describe('a statement that names its own coverage', () => {
  it('fails when it claims more of the chain than there is', async () => {
    const world = await demoWorld();
    const file = reshaped(world, (s) => {
      s.org.zcash.scannedTo = 9_000_000;
    });
    const outcome = await verify(world, file);
    expect(stepOf(outcome, 'zcash')).toMatchObject({ status: 'FAIL', reason: `the chain ends at block ${world.published.org.zcash.scannedTo}; the statement claims a history up to block 9000000` });
    expect(stepOf(outcome, 'journal').reason).toMatch(/^the statement says its Zcash history reaches block 9000000, but the journal's last scan reached block \d+$/);
  });

  it('fails when it claims less than its own journal scanned', async () => {
    const world = await demoWorld();
    const file = reshaped(world, (s) => {
      s.org.zcash.scannedTo = BIRTHDAY + 300;
      s.ledger = s.ledger.filter((e) => e.proof.block === null || e.proof.block <= BIRTHDAY + 300);
    });
    expect(stepOf(await verify(world, file), 'journal').status).toBe('FAIL');
  });

  it('fails when the range it names is not a range', async () => {
    const world = await demoWorld();
    for (const birthday of [0, -5, 9_000_000]) {
      const file = reshaped(world, (s) => {
        s.org.zcash.birthday = birthday;
      });
      const zcash = stepOf(await verify(world, file), 'zcash');
      expect(zcash.status).toBe('FAIL');
      expect(zcash.reason).toMatch(/are not a range of the chain$/);
    }
  });

  it('fails when its birthday is not where its journal began scanning', async () => {
    const world = await demoWorld();
    const file = reshaped(world, (s) => {
      s.org.zcash.birthday = BIRTHDAY + 250;
    });
    expect(stepOf(await verify(world, file), 'journal').reason).toBe(
      `the statement gives block ${BIRTHDAY + 250} as the treasury's birthday, but the journal's first scan started at block ${BIRTHDAY}`,
    );
  });

  it('cannot hide a receipt behind a later birthday once the money is spent', async () => {
    // The organisation's books begin after the grant arrived, so they never show it; they do show it being spent.
    const world = await demoWorld({ birthday: BIRTHDAY + 250 });
    expect(world.published.ledger.some((e) => e.kind === 'receipt')).toBe(false);

    const outcome = await verify(world, world.file);
    expect(stepOf(outcome, 'journal').status).toBe('PASS');
    expect(stepOf(outcome, 'zcash')).toMatchObject({ status: 'FAIL', details: ['every entry matches the chain, so value moved in a way the viewing key does not show'] });
    expect(stepOf(outcome, 'zcash').reason).toMatch(/the unspent notes hold 1030000 zat but the ledger adds up to -945000 zat$/);
    expect(stepOf(outcome, 'reconciliation').reason).toMatch(/balance_mismatch/);
  });

  it('is scanned from the block the reader names, whatever birthday it gives', async () => {
    const world = await demoWorld({ birthday: BIRTHDAY + 250 });
    const zcash = stepOf(await verify(world, world.file, '--birthday', String(BIRTHDAY)), 'zcash');
    expect(zcash.status).toBe('FAIL');
    expect(zcash.reason).toMatch(new RegExp(`^blocks ${BIRTHDAY} to \\d+: 1 on chain but not in the ledger`));
    expect(zcash.details[0]).toContain('the chain shows this receipt of 1975000 ZEC base units');
  });

  it('fails on testnet, with or without a network', async () => {
    const world = await demoWorld();
    const file = reshaped(world, (s) => {
      s.org.zcash.network = 'testnet';
    });
    const outcome = await holdfast(['verify', 'statement.json', '--json', '--offline'], { 'statement.json': file });
    expect(stepOf(outcome, 'zcash')).toMatchObject({ status: 'FAIL', reason: 'the statement is about Zcash testnet; only mainnet statements are verified' });
  });
});

describe('a note whose spend cannot be followed', () => {
  it('does not switch the balance check off', async () => {
    const world = await demoWorld();
    const scannedTo = world.published.org.zcash.scannedTo as number;
    // One zatoshi arrives in a pool the key cannot follow, and the treasury's remaining note is spent with nothing to show for it.
    const dust = { id: 'dust:sapling:0', txid: 'dust', height: scannedTo - 20, time: world.published.statement.asOf - 1_500_000, zat: 1n, memo: '', pool: 'sapling' as const, kind: 'incoming' as const, nullifier: null, spent: false };
    const change = world.chain.mined.flatMap((tx) => tx.notes).find((note) => note.kind === 'change')!;
    world.chain.mined.push({ txid: 'dust', height: dust.height, notes: [dust], outgoing: [], fee: null, spends: [] });
    world.chain.mined.push({ txid: 'drain', height: scannedTo - 10, notes: [], outgoing: [], fee: null, spends: [change.nullifier as string] });

    const file = reshaped(world, (s) => {
      const like = s.ledger.find((e) => e.kind === 'receipt')!;
      s.ledger.push({ ...like, id: 'zcash:dust:sapling:0', kind: 'receipt_untracked', ts: dust.time, amount: 1n, usd: null, usdPrice: null, usdPriceAt: null, ref: '', proof: { chain: 'zcash', tx: 'dust', block: dust.height, url: null }, linked: [] });
    });
    const zcash = stepOf(await verify(world, file), 'zcash');
    expect(zcash.status).toBe('FAIL');
    expect(zcash.reason).toMatch(/the unspent notes hold 0 zat but the ledger adds up to between 1030000 and 1030001 zat$/);
  });
});

describe('a viewing key that is not the key of the treasury', () => {
  it('fails by name when it is the key of another account', async () => {
    const world = await demoWorld();
    const outcome = await holdfast(['verify', 'statement.json', '--json', '--ufvk', OTHER_UFVK], { 'statement.json': world.file }, world.sources);
    expect(stepOf(outcome, 'zcash')).toMatchObject({
      status: 'FAIL',
      reason: `the viewing key belongs to ${OTHER_ADDRESS}, not to ${TREASURY_ADDRESS}, the treasury the statement is about`,
    });
    expect(world.chain.scans).toBe(7);
    expect(outcome.code).toBe(1);
  });

  it('fails when it is not a viewing key at all, or one for testnet', async () => {
    const world = await demoWorld();
    const garbage = await holdfast(['verify', 'statement.json', '--json', '--ufvk', 'not-a-key'], { 'statement.json': world.file }, world.sources);
    expect(stepOf(garbage, 'zcash')).toMatchObject({ status: 'FAIL', reason: 'the viewing key cannot be used: the key does not decode' });
    const testnet = await holdfast(['verify', 'statement.json', '--json', '--ufvk', TESTNET_UFVK], { 'statement.json': world.file }, world.sources);
    expect(stepOf(testnet, 'zcash')).toMatchObject({ status: 'FAIL', reason: 'the viewing key is a testnet key; only mainnet statements are verified' });
  });

  it('fails against a statement that names no treasury', async () => {
    const world = await demoWorld();
    const file = reshaped(world, (s) => {
      s.org.zcash.address = '';
    });
    expect(stepOf(await verify(world, file), 'zcash').status).toBe('FAIL');
    const missing = world.file.replace(/\n\s*"address": "u1holdfastdemotreasury0address",/, '');
    const outcome = await holdfast(['verify', 'statement.json'], { 'statement.json': missing });
    expect(outcome.code).toBe(1);
    expect(outcome.err).toContain('statement file.org.zcash.address: missing');
  });
});

describe('a statement that names its own venue history', () => {
  it('fails when the account traded before the history it claims', async () => {
    const world = await demoWorld();
    const [fill] = world.venue.fills;
    const file = reshaped(world, (s) => {
      s.org.hyperliquid.since = fill!.time + 1;
    });
    const venue = stepOf(await verify(world, file), 'hyperliquid');
    expect(venue.status).toBe('FAIL');
    expect(venue.reason).toBe(`account ${HL_ACCOUNT} has 1 fills and funding payments from before ${new Date(fill!.time + 1).toISOString()}, where the statement's history begins`);
  });

  it('fails when the history it claims covers no time, or runs past the statement', async () => {
    const world = await demoWorld();
    const inverted = reshaped(world, (s) => {
      s.org.hyperliquid.since = s.org.hyperliquid.through + 1;
    });
    const beyond = reshaped(world, (s) => {
      s.org.hyperliquid.through += 60_000;
    });
    for (const file of [inverted, beyond]) {
      expect(stepOf(await verify(world, file), 'hyperliquid')).toMatchObject({
        status: 'FAIL',
        reason: 'the stretch of history the statement claims does not run from a start to an end no later than the statement itself',
      });
    }
  });

  it('fails when the venue no longer serves the whole history', async () => {
    const world = await demoWorld();
    const [real] = world.venue.fills;
    const through = world.published.org.hyperliquid.through;
    // Ten thousand fills since the statement have pushed the one it was built from out of what the venue serves.
    const newer = Array.from({ length: 10_000 }, (_, i) => ({ ...real!, tid: `n${i}`, time: through + 1_000 + i, side: i % 2 === 0 ? ('buy' as const) : ('sell' as const) }));
    world.venue.fills.splice(0, 1, ...newer);
    const venue = stepOf(await verify(world, world.file), 'hyperliquid');
    expect(venue.status).toBe('FAIL');
    expect(venue.reason).toBe(
      `the venue serves only the latest 10000 fills of account ${HL_ACCOUNT}, back to ${new Date(through + 1_000).toISOString()}; what came before cannot be shown to be in the ledger`,
    );
  });

  it('fails when it names no account, instead of the step being skipped over a bad address', async () => {
    const world = await demoWorld();
    const file = reshaped(world, (s) => {
      s.org.hyperliquid.account = 'the usual one';
    });
    expect(stepOf(await verify(world, file), 'hyperliquid')).toMatchObject({ status: 'FAIL', reason: 'the statement names no Hyperliquid account' });
  });

  it('fails when the account is not the one the reader expects', async () => {
    const world = await demoWorld();
    const expected = '0x000000000000000000000000000000000000dEaD';
    const outcome = await verify(world, world.file, '--hyperliquid-account', expected);
    expect(stepOf(outcome, 'hyperliquid')).toMatchObject({ status: 'FAIL', reason: `the statement is about account ${HL_ACCOUNT}, not ${expected}, the one expected` });
    expect(world.venue.reads).toBe(7);
  });
});

describe('a statement that sets its own terms', () => {
  it('cannot allow itself more time before a dead source counts as dead', async () => {
    const world = await demoWorld();
    const later = world.published.statement.asOf + 86_400_000;
    // A day after the last tick, with a leash of thirty years: every reading still looks current.
    const file = reshaped(world, (s) => {
      s.statement = buildStatement({ ledger: s.ledger, journal: s.journal, policy: s.policy, now: later, monthlyBurnUsd: 4, staleAfterMs: 1e12, seriesStep: 'entry' });
      s.generatedAt = later;
    });
    expect(parsePublishedStatement(file).statement).toMatchObject({ stale: [], hedge: { shortLots: 1 } });

    const outcome = await holdfast(['verify', 'statement.json', '--json', '--offline'], { 'statement.json': file }, undefined, { now: () => later + 60_000 });
    const arithmetic = stepOf(outcome, 'arithmetic');
    expect(arithmetic.status).toBe('FAIL');
    expect(arithmetic.details).toContain(`staleAfterMs: published 1000000000000, recomputed ${DEFAULT_POLICY.maxDataAgeMs}`);
    expect(arithmetic.details.join('\n')).toMatch(/^hedge: published \{.*\}, recomputed null$/m);
  });

  it('says so when the statement is honest about a dead source', async () => {
    const world = await demoWorld();
    const later = world.published.statement.asOf + 86_400_000;
    const file = serializePublishedStatement(
      buildPublishedStatement({ ...world.published, ledger: world.published.ledger, now: later, monthlyBurnUsd: 4, seriesStep: 'entry' }),
    );
    const outcome = await holdfast(['verify', 'statement.json', '--json', '--offline'], { 'statement.json': file }, undefined, { now: () => later + 60_000 });
    const arithmetic = stepOf(outcome, 'arithmetic');
    expect(arithmetic.status).toBe('PASS');
    expect(arithmetic.details.slice(0, 2)).toEqual([
      'the statement itself has no current journal reading: the last entry is 86430 s old, over the 180 s allowed',
      'the statement itself has no current zcash reading: the last treasury reading is 86430 s old, over the 180 s allowed',
    ]);
  });

  it('cannot be dated in the future', async () => {
    const world = await demoWorld();
    const outcome = await holdfast(['verify', 'statement.json', '--json', '--offline'], { 'statement.json': world.file }, undefined, { now: () => world.published.statement.asOf - 60_000 });
    expect(stepOf(outcome, 'arithmetic')).toMatchObject({ status: 'FAIL', reason: 'the statement is dated in the future' });
  });

  it('cannot state its moment twice and differently', async () => {
    const world = await demoWorld();
    const file = reshaped(world, (s) => {
      s.generatedAt = READING_AT;
    });
    const outcome = await holdfast(['verify', 'statement.json'], { 'statement.json': file });
    expect(outcome.code).toBe(1);
    expect(outcome.err).toContain('statement file.generatedAt: differs from statement.asOf');
  });

  it('cannot bring its own facts about a token', async () => {
    const world = await demoWorld();
    const token = '0x1111111111111111111111111111111111111111';
    const file = reshaped(world, (s) => {
      for (const payout of s.payouts) payout.run.token = token;
    });
    const reconciliation = stepOf(await verify(world, file), 'reconciliation');
    expect(reconciliation.status).toBe('FAIL');
    expect(reconciliation.reason).toMatch(/unknown_token/);
  });

  it('cannot count an entry that no chain check would ever look at', async () => {
    const world = await demoWorld();
    const file = reshaped(world, (s) => {
      const receipt = s.ledger.find((e) => e.kind === 'receipt')!;
      s.ledger.push({ ...receipt, id: 'swap:fake:payment', source: 'swap', kind: 'payment', amount: -400_000n, usd: -4.9, usdPrice: 1225, proof: { ...receipt.proof, block: null } });
    });
    const outcome = await verify(world, file);
    expect(stepOf(outcome, 'reconciliation').reason).toBe('1 error: malformed_entry');
    // The figures were never moved by it, so the arithmetic has nothing to object to.
    expect(statuses(outcome)).toMatchObject({ zcash: 'PASS', hyperliquid: 'PASS', arithmetic: 'PASS' });
  });

  it('cannot drop the evidence a ledger entry rests on', async () => {
    const world = await demoWorld();
    const noPayouts = stepOf(await verify(world, reshaped(world, (s) => (s.payouts = []))), 'reconciliation');
    expect(noPayouts.reason).toBe('2 errors: payout_ledger_mismatch');
    const noSwaps = stepOf(await verify(world, reshaped(world, (s) => (s.swaps = []))), 'reconciliation');
    expect(noSwaps.reason).toBe('2 errors: swap_entry_without_swap');
  });
});

describe('what the report prints', () => {
  const ESC = String.fromCharCode(0x1b);
  const hostileName = `Acme${String.fromCharCode(10)}  PASS    zcash           all entries match the chain${ESC}[2K${ESC}[1A${String.fromCharCode(0x9b)}2J${String.fromCharCode(0x202e)}`;

  it('cannot be rewritten by the statement it reports on', async () => {
    const world = await demoWorld();
    const file = reshaped(world, (s) => {
      s.org.name = hostileName;
      s.statement.treasury!.zat! += 1n;
    });
    const outcome = await holdfast(['verify', 'statement.json', '--offline'], { 'statement.json': file });
    const lines = outcome.out.split('\n');

    expect(lines[1]).toBe('  Acme\\u000a  PASS    zcash           all entries match the chain\\u001b[2K\\u001b[1A\\u009b2J\\u202e (holdfast-demo), as of 2026-10-09T16:30:30.000Z, 5 minutes ago');
    expect(lines.filter((line) => line.startsWith('  PASS    zcash'))).toEqual([]);
    expect(lines.filter((line) => line.startsWith('  SKIPPED zcash'))).toHaveLength(1);
    expect(lines.at(-1)).toBe('FAILED: arithmetic. Not run: zcash, hyperliquid.');
    for (let i = 0; i < outcome.out.length; i++) {
      const code = outcome.out.charCodeAt(i);
      expect(code === 10 || (code >= 32 && code < 127) || code > 0x9f).toBe(true);
      expect(code === 0x202e).toBe(false);
    }
  });

  it('keeps hostile text out of the detail lines and the errors too', async () => {
    const world = await demoWorld();
    const file = reshaped(world, (s) => {
      s.ledger.find((e) => e.kind === 'receipt')!.ref = `refund${ESC}[1A${ESC}[2K`;
    });
    const outcome = await holdfast(['verify', 'statement.json', '--ufvk', UFVK], { 'statement.json': file }, world.sources);
    expect(outcome.out).toContain('ref is "refund\\u001b[1A\\u001b[2K" in the ledger');
    expect(outcome.out.includes(ESC)).toBe(false);

    const unreadable = await holdfast(['verify', `odd${ESC}[2J.json`]);
    expect(unreadable.err.includes(ESC)).toBe(false);
  });

  it('escapes in JSON what JSON itself would let through', async () => {
    const world = await demoWorld();
    const file = reshaped(world, (s) => {
      s.org.name = hostileName;
    });
    const outcome = await holdfast(['verify', 'statement.json', '--json', '--offline'], { 'statement.json': file });
    expect(outcome.out.includes(String.fromCharCode(0x9b))).toBe(false);
    expect(outcome.out.includes(String.fromCharCode(0x202e))).toBe(false);
    expect((JSON.parse(outcome.out) as { org: { name: string } }).org.name).toBe(hostileName);
  });
});
