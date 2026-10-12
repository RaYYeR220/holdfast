import type { OrgRecord, PgliteConnection } from '@holdfast/db';
import type { KeyStatus } from '@holdfast/tempo';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type SolanaAccountSeen, type SolanaReads, SYSTEM_PROGRAM, isMarkerSet, solanaAddressLinks, solanaReads } from '../../src/server/pages/payouts-solana';
import { payoutRunShown, payoutRunsShown, receiptShown, solanaAllowanceShown, solanaRailShown, tempoKeyShown, tempoRailShown } from '../../src/server/pages/payouts';
import { createRun, executeRun } from '../../src/server/payouts/service';
import { available, missing } from '../../src/server/reading';
import { SOLANA_OWNER, SOLANA_PAYEES } from '../support/fakes';
import { PAYEES, ROOT, RPC_URL, SPONSOR_KEY, START, STARTUP_TIMEOUT_MS, type World, keyAddress, migratedPglite, newAccount, organisation, world } from '../support/world';
import { privateKeyToAddress } from 'viem/accounts';

let connection: PgliteConnection;
let w: World;

beforeAll(async () => {
  connection = await migratedPglite();
}, STARTUP_TIMEOUT_MS);

afterAll(() => connection.close());

beforeEach(() => {
  w = world(connection);
});

/** Solana as the pages read it beside the rail, in memory. */
class FakeReads implements SolanaReads {
  down: string | null = null;
  readonly balances = new Map<string, bigint>();
  readonly accounts = new Map<string, SolanaAccountSeen>();

  async lamports(address: string): Promise<bigint> {
    if (this.down !== null) throw new Error(this.down);
    return this.balances.get(address) ?? 0n;
  }

  async account(address: string): Promise<SolanaAccountSeen | null> {
    if (this.down !== null) throw new Error(this.down);
    return this.accounts.get(address) ?? null;
  }

  async tokenAccountOf(owner: string, mint: string): Promise<string> {
    return `ata-of-${owner}-in-${mint}`;
  }

  async markerOf(run: { delegate: string; owner: string; mint: string; runId: string }): Promise<string> {
    return `marker-of-${run.runId}-under-${run.delegate}`;
  }

  /** Have the chain hold the marker of a run under a service key. */
  mark(runId: string, delegate: string): void {
    this.accounts.set(`marker-of-${runId}-under-${delegate}`, { owner: SYSTEM_PROGRAM, lamports: 897_840n, dataLength: 1 });
  }
}

async function owned(over: { tempoAccount?: string | null; solanaOwner?: string | null } = {}): Promise<OrgRecord> {
  return organisation(w, newAccount().address, over);
}

const tempoLines = [
  { payee: { name: 'Ada Lovelace', address: PAYEES[0] }, amount: 1_000_000n, reference: 'INV-1041' },
  { payee: { name: 'Grace Hopper', address: PAYEES[1] }, amount: 2_500_000n, reference: 'INV-1042' },
];
const solanaLines = [
  { payee: { name: 'Linus Torvalds', address: SOLANA_PAYEES[0] ?? '' }, amount: 4_000_000n, reference: 'INV-7' },
  { payee: { name: 'Margaret Hamilton', address: SOLANA_PAYEES[1] ?? '' }, amount: 6_000_000n, reference: '' },
];

const STATUS: KeyStatus = {
  accessKey: PAYEES[2],
  authorized: true,
  live: true,
  mismatch: [],
  revoked: false,
  expiresAt: 1_800_000_000_000,
  limited: true,
  remaining: 1_250_000n,
  periodEnd: 1_799_000_000_000,
  scope: { unrestricted: false, selectors: ['0x95777d59'], recipients: [PAYEES[0]], otherTargets: [] },
};

describe('the state of the Tempo access key', () => {
  const read = (over: Partial<KeyStatus>) => tempoKeyShown(ROOT, available('tempo', 5, { ...STATUS, ...over }));

  it('is the bounds the keychain reports when the key is a bounded payout key', () => {
    expect(read({})).toEqual({ state: 'authorized', remaining: 1_250_000n, periodEnd: 1_799_000_000_000, expiresAt: 1_800_000_000_000, recipients: [PAYEES[0]], readAt: 5 });
    expect(read({ periodEnd: null, expiresAt: null, scope: { ...STATUS.scope, recipients: null } })).toMatchObject({ state: 'authorized', periodEnd: null, expiresAt: null, recipients: null });
  });

  it('tells a key the keychain does not know from one that ran out and one that was revoked', () => {
    expect(read({ authorized: false, live: false, expiresAt: null, remaining: 0n })).toEqual({ state: 'not_authorized', readAt: 5 });
    expect(read({ authorized: false, live: false, expiresAt: 1_700_000_000_000, remaining: 0n })).toEqual({ state: 'expired', expiredAt: 1_700_000_000_000, readAt: 5 });
    expect(read({ authorized: false, live: false, revoked: true, expiresAt: null, remaining: 0n })).toEqual({ state: 'revoked', readAt: 5 });
  });

  it('does not show a live key that is broader than a payout key as authorized', () => {
    expect(read({ authorized: false, mismatch: ['it has no spending limit'], remaining: 0n })).toEqual({ state: 'broader', problems: ['it has no spending limit'], expiresAt: 1_800_000_000_000, readAt: 5 });
  });

  it('says there is no account before it says anything of a key, and passes a failed read on with its reason', () => {
    expect(tempoKeyShown(null, missing('tempo', 5, 'the organisation has no Tempo account yet'))).toEqual({ state: 'no_account' });
    expect(tempoKeyShown(ROOT, missing('tempo', 5, 'keyState failed: fetch failed'))).toEqual({ state: 'unavailable', source: 'tempo', reason: 'keyState failed: fetch failed', readAt: 5 });
  });
});

describe('the state of the Solana allowance', () => {
  it('is what is left, nothing, no wallet, or a read that failed', () => {
    expect(solanaAllowanceShown(SOLANA_OWNER, available('solana', 7, { remaining: 750_000n }))).toEqual({ state: 'approved', remaining: 750_000n, readAt: 7 });
    expect(solanaAllowanceShown(SOLANA_OWNER, available('solana', 7, { remaining: 0n }))).toEqual({ state: 'nothing', readAt: 7 });
    expect(solanaAllowanceShown(null, missing('solana', 7, 'no wallet'))).toEqual({ state: 'no_wallet' });
    expect(solanaAllowanceShown(SOLANA_OWNER, missing('solana', 7, 'the node is down'))).toEqual({ state: 'unavailable', source: 'solana', reason: 'the node is down', readAt: 7 });
  });
});

describe('the rails as the Payouts page shows them', () => {
  it('shows the Tempo account, the access key as the chain has it and the sponsor that pays the fees', async () => {
    const org = await owned();
    const accessKey = await keyAddress(w, org.id, 'tempo_access');
    const rail = await tempoRailShown(w.deps, org);
    expect(rail).toMatchObject({ network: 'moderato', chainId: 42_431, token: { symbol: 'AlphaUSD', decimals: 6 }, account: ROOT, accessKey, links: { before: 'https://explore.testnet.tempo.xyz/address/', after: '' } });
    expect(rail.sponsor).toMatchObject({ status: 'ok', value: privateKeyToAddress(SPONSOR_KEY) });
    expect(rail.key).toEqual({ state: 'authorized', remaining: 10_000_000n, periodEnd: (START + 3_600) * 1000, expiresAt: (START + 86_400) * 1000, recipients: [...PAYEES], readAt: w.clock.ms });

    w.tempoChain(accessKey).revoke();
    expect((await tempoRailShown(w.deps, org)).key).toEqual({ state: 'revoked', readAt: w.clock.ms });
    w.tempoChain(accessKey).failing.add('keyState');
    expect((await tempoRailShown(w.deps, org)).key).toEqual({ state: 'unavailable', source: 'tempo', reason: 'keyState failed: fetch failed', readAt: w.clock.ms });
  });

  it('shows a Tempo rail without an account as that, with the key the service made for it', async () => {
    const org = await owned({ tempoAccount: null });
    const rail = await tempoRailShown(w.deps, org);
    expect(rail).toMatchObject({ account: null, accessKey: await keyAddress(w, org.id, 'tempo_access'), key: { state: 'no_account' } });
  });

  it('shows the Solana wallet, its token account, the allowance left and the SOL of the service key', async () => {
    const org = await owned();
    const delegate = await keyAddress(w, org.id, 'solana_delegate');
    const reads = new FakeReads();
    reads.balances.set(delegate, 12_340_000n);
    w.solana.allowance = 750_000n;
    const rail = await solanaRailShown(w.deps, org, reads);
    expect(rail).toEqual({
      cluster: 'devnet',
      token: { address: w.solana.mint, symbol: 'USDC', decimals: 6 },
      owner: SOLANA_OWNER,
      tokenAccount: `ata-of-${SOLANA_OWNER}-in-${w.solana.mint}`,
      delegate,
      allowance: { state: 'approved', remaining: 750_000n, readAt: w.clock.ms },
      delegateLamports: { status: 'ok', source: 'solana', readAt: w.clock.ms, value: 12_340_000n },
      links: { before: 'https://explorer.solana.com/address/', after: '?cluster=devnet' },
    });
  });

  it('shows a balance that could not be read as unavailable with the reason, never as nothing', async () => {
    const org = await owned();
    const reads = new FakeReads();
    reads.down = `the node at ${RPC_URL} did not answer`;
    const rail = await solanaRailShown(w.deps, org, reads);
    expect(rail.delegateLamports).toEqual({ status: 'unavailable', source: 'solana', readAt: w.clock.ms, reason: 'the node at [redacted] did not answer' });
  });

  it('shows a Solana rail without a wallet as that', async () => {
    const org = await owned({ solanaOwner: null });
    const rail = await solanaRailShown(w.deps, org, new FakeReads());
    expect(rail).toMatchObject({ owner: null, tokenAccount: null, allowance: { state: 'no_wallet' } });
    expect(rail.delegate).toBe(await keyAddress(w, org.id, 'solana_delegate'));
  });
});

describe('the runs as the pages show them', () => {
  it('shows the owner every run with its payees, newest first', async () => {
    const org = await owned();
    const first = await createRun(w.deps, org, { chain: 'tempo', lines: tempoLines });
    await executeRun(w.deps, org, first.id);
    w.clock.advance(60_000);
    const second = await createRun(w.deps, org, { chain: 'solana', lines: solanaLines });

    const runs = await payoutRunsShown(w.deps, org, 'owner');
    expect(runs.map((run) => [run.id, run.chain, run.status, run.total])).toEqual([
      [second.id, 'solana', 'draft', 10_000_000n],
      [first.id, 'tempo', 'paid', 3_500_000n],
    ]);
    expect(runs[1]).toMatchObject({ account: ROOT, token: { symbol: 'AlphaUSD', decimals: 6 }, error: null });
    expect(runs[1]?.tx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(runs[1]?.txUrl).toBe(`https://explore.testnet.tempo.xyz/tx/${runs[1]?.tx}`);
    expect(runs[1]?.lines[0]).toMatchObject({ lineNo: 1, payee: { name: 'Ada Lovelace', address: PAYEES[0] }, amount: 1_000_000n, memo: `${first.id}/1`, reference: 'INV-1041' });
    expect(runs[0]?.lines[1]).toMatchObject({ payee: { name: 'Margaret Hamilton', address: SOLANA_PAYEES[1] }, memo: '', reference: '' });
  });

  it('shows the public the paid runs only, and nothing of who was paid', async () => {
    const org = await owned();
    await w.store.updateOrg(org.id, { publicDemo: true });
    const paid = await createRun(w.deps, org, { chain: 'tempo', lines: tempoLines });
    await executeRun(w.deps, org, paid.id);
    const draft = await createRun(w.deps, org, { chain: 'tempo', lines: tempoLines });

    const runs = await payoutRunsShown(w.deps, org, 'public');
    expect(runs.map((run) => run.id)).toEqual([paid.id]);
    expect(runs[0]).toMatchObject({ status: 'paid', createdAt: null, account: null, error: null, total: 3_500_000n });
    expect(runs[0]?.lines).toEqual([
      { lineNo: 1, payee: null, amount: 1_000_000n, memo: `${paid.id}/1`, reference: null, receiptToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) },
      { lineNo: 2, payee: null, amount: 2_500_000n, memo: `${paid.id}/2`, reference: null, receiptToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) },
    ]);
    expect(JSON.stringify(runs, (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value))).not.toContain('Ada Lovelace');
    expect(await payoutRunShown(w.deps, org, draft.id, 'public', new FakeReads())).toBeNull();
  });
});

describe('one run as its page shows it', () => {
  it('shows a draft with what executing would do and without a look at the chain', async () => {
    const org = await owned();
    const draft = await createRun(w.deps, org, { chain: 'tempo', lines: tempoLines });
    const page = await payoutRunShown(w.deps, org, draft.id, 'owner', new FakeReads());
    expect(page?.run).toMatchObject({ id: draft.id, status: 'draft', total: 3_500_000n });
    expect(page?.onChain).toBeNull();
    expect(page?.marker).toBeNull();
    expect(page?.preview).toMatchObject({ status: 'ok', source: 'tempo', value: { wouldProceed: true, problems: [], solana: null } });
  });

  it('shows why a draft would not go ahead, in the rail’s own words', async () => {
    const org = await owned();
    w.solana.allowance = 1_000_000n;
    const draft = await createRun(w.deps, org, { chain: 'solana', lines: solanaLines });
    const page = await payoutRunShown(w.deps, org, draft.id, 'owner', new FakeReads());
    expect(page?.preview).toMatchObject({ status: 'ok', value: { wouldProceed: false, problems: ['exceeds delegated allowance: run needs 10000000, 1000000 remaining'] } });
  });

  it('shows a paid run beside what its chain holds, with no preview', async () => {
    const org = await owned();
    const run = await createRun(w.deps, org, { chain: 'tempo', lines: tempoLines });
    const paid = await executeRun(w.deps, org, run.id);
    const page = await payoutRunShown(w.deps, org, run.id, 'owner', new FakeReads());
    expect(page?.run).toMatchObject({ status: 'paid', tx: paid.run.tx });
    expect(page?.preview).toBeNull();
    expect(page?.onChain).toMatchObject({ status: 'ok', source: 'tempo', value: { tx: paid.run.tx, matchesRun: true } });
  });

  it('has no page for an id that is no run id, for a run that does not exist, and for another organisation’s run', async () => {
    const org = await owned();
    const other = await owned();
    const theirs = await createRun(w.deps, other, { chain: 'tempo', lines: tempoLines });
    const reads = new FakeReads();
    expect(await payoutRunShown(w.deps, org, 'not-a-run', 'owner', reads)).toBeNull();
    expect(await payoutRunShown(w.deps, org, 'HF-2020-01-0001', 'owner', reads)).toBeNull();
    expect(await payoutRunShown(w.deps, org, theirs.id, 'owner', reads)).toBeNull();
    expect(await payoutRunShown(w.deps, other, theirs.id, 'owner', reads)).not.toBeNull();
  });

  describe('the marker of a Solana run', () => {
    async function paidOnSolana() {
      const org = await owned();
      const run = await createRun(w.deps, org, { chain: 'solana', lines: solanaLines });
      await executeRun(w.deps, org, run.id);
      return { org, run, delegate: await keyAddress(w, org.id, 'solana_delegate') };
    }

    it('is shown as set when the chain holds it under the present service key', async () => {
      const { org, run, delegate } = await paidOnSolana();
      const reads = new FakeReads();
      reads.mark(run.id, delegate);
      const page = await payoutRunShown(w.deps, org, run.id, 'owner', reads);
      expect(page?.marker).toEqual({
        status: 'ok',
        source: 'solana',
        readAt: w.clock.ms,
        value: { address: `marker-of-${run.id}-under-${delegate}`, delegate, presentKey: true, set: true },
      });
      expect(page?.links).toEqual({ before: 'https://explorer.solana.com/address/', after: '?cluster=devnet' });
      expect(page?.txLinks).toEqual({ before: 'https://explorer.solana.com/tx/', after: '?cluster=devnet' });
    });

    it('is shown as not set when the chain holds none: lamports alone at the address are not a marker', async () => {
      const { org, run, delegate } = await paidOnSolana();
      const reads = new FakeReads();
      reads.accounts.set(`marker-of-${run.id}-under-${delegate}`, { owner: SYSTEM_PROGRAM, lamports: 5_000n, dataLength: 0 });
      const page = await payoutRunShown(w.deps, org, run.id, 'owner', reads);
      expect(page?.marker).toMatchObject({ status: 'ok', value: { delegate, presentKey: true, set: false } });
    });

    it('is found under the service key that paid the run after the organisation was given another', async () => {
      const { org, run, delegate } = await paidOnSolana();
      const reads = new FakeReads();
      reads.mark(run.id, delegate);
      w.clock.advance(1_000);
      const next = { secret: 'f'.repeat(64), address: 'De1egateNext11111111111111111111111111111111' };
      w.solana.know(next.secret, next.address);
      await w.store.installKey(org.id, { kind: 'solana_delegate', ...next });
      const page = await payoutRunShown(w.deps, org, run.id, 'owner', reads);
      expect(page?.marker).toMatchObject({ status: 'ok', value: { address: `marker-of-${run.id}-under-${delegate}`, delegate, presentKey: false, set: true } });
    });

    it('is unavailable with the reason when the chain cannot be read', async () => {
      const { org, run } = await paidOnSolana();
      const reads = new FakeReads();
      reads.down = 'the node is down';
      const page = await payoutRunShown(w.deps, org, run.id, 'owner', reads);
      expect(page?.marker).toEqual({ status: 'unavailable', source: 'solana', readAt: w.clock.ms, reason: 'the node is down' });
    });

    it('is derived for the public page from the wallet the organisation names', async () => {
      const { org, run, delegate } = await paidOnSolana();
      await w.store.updateOrg(org.id, { publicDemo: true });
      const page = await payoutRunShown(w.deps, org, run.id, 'public', new FakeReads());
      expect(page?.run.account).toBeNull();
      expect(page?.onChain).toBeNull();
      expect(page?.preview).toBeNull();
      expect(page?.marker).toMatchObject({ status: 'ok', value: { address: `marker-of-${run.id}-under-${delegate}`, set: false } });
    });
  });
});

describe('a receipt as its page shows it', () => {
  async function paidOnTempo() {
    const org = await organisation(w, newAccount().address, { name: 'Acme Labs' });
    const run = await createRun(w.deps, org, { chain: 'tempo', lines: tempoLines });
    const paid = await executeRun(w.deps, org, run.id);
    return { org, run: paid.run };
  }

  it('says who paid, whom, how much, under which reference, when and in which transaction', async () => {
    const { run } = await paidOnTempo();
    const receipt = await receiptShown(w.deps, run.lines[1]?.receiptToken ?? '');
    expect(receipt).toEqual({
      organisation: 'Acme Labs',
      chain: 'tempo',
      network: 'moderato',
      token: { address: w.deps.tempo.token, symbol: 'AlphaUSD', decimals: 6 },
      amount: 2_500_000n,
      to: PAYEES[1],
      memo: `${run.id}/2`,
      reference: 'INV-1042',
      paidAt: run.executedAt,
      tx: run.tx,
      txUrl: run.txUrl,
      links: { before: 'https://explore.testnet.tempo.xyz/address/', after: '' },
    });
  });

  it('says nothing of the other lines of the run, of the account that paid or of the treasury', async () => {
    const { org, run } = await paidOnTempo();
    const receipt = await receiptShown(w.deps, run.lines[1]?.receiptToken ?? '');
    const text = JSON.stringify(receipt, (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value));
    for (const hidden of [org.id, org.hlUser, org.tempoAccount ?? '', 'Ada Lovelace', 'Grace Hopper', PAYEES[0], 'INV-1041', '3500000']) expect(text).not.toContain(hidden);
  });

  it('has none for a line that was not paid, for a token nobody was given, or for something that is no token', async () => {
    const org = await owned();
    const draft = await createRun(w.deps, org, { chain: 'tempo', lines: tempoLines });
    for (const token of [draft.lines[0]?.receiptToken ?? '', 'A'.repeat(43), 'short', `${'A'.repeat(43)}'; drop table holdfast.orgs; --`]) {
      expect(await receiptShown(w.deps, token)).toBeNull();
    }
  });
});

describe('the reads of a Solana node', () => {
  const node = (answers: Record<string, unknown>) => {
    const asked: { method: string; params: unknown[] }[] = [];
    const doFetch: typeof fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      asked.push(request);
      return new Response(JSON.stringify(answers[request.method] ?? { error: { message: 'method not found' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    return { asked, reads: solanaReads({ rpcUrl: RPC_URL }, { fetch: doFetch }) };
  };

  it('read the SOL an address holds', async () => {
    const { asked, reads } = node({ getBalance: { result: { context: { slot: 1 }, value: 12_340_000 } } });
    expect(await reads.lamports(SOLANA_OWNER)).toBe(12_340_000n);
    expect(asked).toEqual([{ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [SOLANA_OWNER, { commitment: 'confirmed' }] }]);
  });

  it('read an account as its program, its lamports and the length of its data, and a missing one as null', async () => {
    const set = node({ getAccountInfo: { result: { value: { owner: SYSTEM_PROGRAM, lamports: 897_840, data: ['AA==', 'base64'], executable: false } } } });
    expect(await set.reads.account(SOLANA_OWNER)).toEqual({ owner: SYSTEM_PROGRAM, lamports: 897_840n, dataLength: 1 });
    const absent = node({ getAccountInfo: { result: { context: { slot: 1 }, value: null } } });
    expect(await absent.reads.account(SOLANA_OWNER)).toBeNull();
  });

  it('reject when the node refuses, answers without a result, or cannot be reached with success', async () => {
    await expect(node({}).reads.lamports(SOLANA_OWNER)).rejects.toThrow('the Solana node refused the request: method not found');
    await expect(node({ getBalance: {} }).reads.lamports(SOLANA_OWNER)).rejects.toThrow('the Solana node answered without a result');
    await expect(node({ getBalance: { result: { value: 'much' } } }).reads.lamports(SOLANA_OWNER)).rejects.toThrow('the Solana node answered without a balance');
    const failing = solanaReads({ rpcUrl: RPC_URL }, { fetch: async () => new Response('busy', { status: 429 }) });
    await expect(failing.account(SOLANA_OWNER)).rejects.toThrow('the Solana node answered HTTP 429');
  });

  it('derive the token account of a wallet and the marker of a run as the Solana package does', async () => {
    const { reads } = node({});
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    // The published accounts of the demo treasury: its wallet and the wallet's USDC account.
    expect(await reads.tokenAccountOf('B1zTmCPofZo7TZET5k7jL43FzVG5TFcbQPijYi7mFV97', mint)).toBe('A8VB3LCer26TftTWTnjqgnzrHYFGk72tHvN78yCNfgEw');
    const marker = await reads.markerOf({ delegate: 'HBy3fT36LiCgfBuf1mymsxRwv2DDKQd5MB8z8DJghnu3', owner: 'B1zTmCPofZo7TZET5k7jL43FzVG5TFcbQPijYi7mFV97', mint, runId: 'HF-2026-10-0003' });
    expect(marker).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(await reads.markerOf({ delegate: 'HBy3fT36LiCgfBuf1mymsxRwv2DDKQd5MB8z8DJghnu3', owner: 'B1zTmCPofZo7TZET5k7jL43FzVG5TFcbQPijYi7mFV97', mint, runId: 'HF-2026-10-0004' })).not.toBe(marker);
  });
});

describe('what counts as a marker and where an address is looked at', () => {
  it('takes only a System account that carries data for a marker that is set', () => {
    expect(isMarkerSet({ owner: SYSTEM_PROGRAM, lamports: 897_840n, dataLength: 1 })).toBe(true);
    expect(isMarkerSet({ owner: SYSTEM_PROGRAM, lamports: 897_840n, dataLength: 0 })).toBe(false);
    expect(isMarkerSet({ owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2_039_280n, dataLength: 165 })).toBe(false);
    expect(isMarkerSet(null)).toBe(false);
  });

  it('links an address on the explorer of its cluster', () => {
    expect(solanaAddressLinks('mainnet-beta')).toEqual({ before: 'https://explorer.solana.com/address/', after: '' });
    expect(solanaAddressLinks('devnet')).toEqual({ before: 'https://explorer.solana.com/address/', after: '?cluster=devnet' });
  });
});
