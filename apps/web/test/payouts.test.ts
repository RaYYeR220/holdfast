import type { PgliteConnection } from '@holdfast/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPayout, getPayoutPreview, getPayouts, postPayout, postPayoutExecute } from '../src/server/api/payouts';
import { getSolanaRail, getTempoRail, postSolanaApproval, postSolanaRevoke, postTempoAuthorization, postTempoAuthorizationSubmit } from '../src/server/api/rails';
import { expectOwnerOnly } from './support/access';
import { SOLANA_OWNER, SOLANA_PAYEES } from './support/fakes';
import { PAYEES, ROOT, ROOT_ACCOUNT, START, STARTUP_TIMEOUT_MS, STRANGER, type World, call, keyAddress, migratedPglite, newAccount, organisation, policyFor, sessionOf, signAuthorization, world } from './support/world';

let connection: PgliteConnection;
let w: World;

beforeAll(async () => {
  connection = await migratedPglite();
}, STARTUP_TIMEOUT_MS);

afterAll(() => connection.close());

beforeEach(() => {
  w = world(connection);
});

/** An organisation with both payout accounts set, its owner's session, and the Tempo chain as its access key sees it. */
async function owned(over: { tempoAccount?: string | null; solanaOwner?: string | null } = {}) {
  const owner = newAccount();
  const org = await organisation(w, owner.address, over);
  const accessKey = await keyAddress(w, org.id, 'tempo_access');
  return { org, cookie: await sessionOf(w, owner.address), params: { orgId: org.id }, accessKey, chain: w.tempoChain(accessKey) };
}

/** January 2027 by the test clock. */
const RUN_1 = 'HF-2027-01-0001';
const TERMS = { limit: '10000000', periodSeconds: 3_600, expiry: START + 86_400, recipients: [...PAYEES] };

const tempoLines = [
  { payee: { name: 'Ada Lovelace', address: PAYEES[0] }, amount: '1000000', reference: 'INV-1041' },
  { payee: { name: 'Grace Hopper', address: PAYEES[1].toLowerCase() }, amount: '2500000', reference: 'INV-1042' },
];
const solanaLines = [
  { payee: { name: 'Linus Torvalds', address: SOLANA_PAYEES[0] }, amount: '4000000', reference: 'INV-7' },
  { payee: { name: 'Margaret Hamilton', address: SOLANA_PAYEES[1] }, amount: '6000000' },
];

describe('the Tempo rail', () => {
  it('shows the access key as the chain has it now', async () => {
    const { cookie, params, accessKey, chain } = await owned();
    const { status, body } = await call(w, getTempoRail, 'GET', { cookie, params });
    expect(status).toBe(200);
    expect(body).toMatchObject({ network: 'moderato', chainId: 42_431, token: { address: w.deps.tempo.token, symbol: 'AlphaUSD', decimals: 6 }, account: ROOT, accessKey });
    expect(body.key).toMatchObject({ status: 'ok', source: 'tempo', value: { authorized: true, remaining: '10000000', periodEnd: (START + 3_600) * 1000 } });

    chain.failing.add('keyState');
    const down = await call(w, getTempoRail, 'GET', { cookie, params });
    expect(down.body.key).toEqual({ status: 'unavailable', source: 'tempo', readAt: w.clock.ms, reason: 'keyState failed: fetch failed' });
    expect(down.body.accessKey).toBe(accessKey);
  });

  it('says what is missing when the organisation has named no Tempo account', async () => {
    const { cookie, params } = await owned({ tempoAccount: null });
    const { body } = await call(w, getTempoRail, 'GET', { cookie, params });
    expect(body.account).toBeNull();
    expect(body.key).toMatchObject({ status: 'unavailable', reason: 'the organisation has no Tempo account yet; set one in its profile first' });
    expect((await call(w, postTempoAuthorization, 'POST', { cookie, params, body: TERMS })).status).toBe(409);
  });

  it('builds the authorization for the root to sign: this key, this token, these bounds', async () => {
    const { cookie, params, accessKey } = await owned();
    const { status, body } = await call(w, postTempoAuthorization, 'POST', { cookie, params, body: TERMS });
    expect(status).toBe(200);
    expect(body.expected).toEqual({ rootAddress: ROOT, accessKeyAddress: accessKey, token: w.deps.tempo.token, limit: '10000000', periodSeconds: 3_600, expiry: START + 86_400, chainId: 42_431, recipients: [...PAYEES] });
    expect(body.signPayload).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.key).toEqual({ address: accessKey, type: 'p256' });
    expect(body.policy.scopes).toHaveLength(1);
    expect(body.policy.scopes[0]).toMatchObject({ selector: 'transferWithMemo(address,uint256,bytes32)', recipients: [...PAYEES] });
    expect(body.policy.scopes[0].address.toLowerCase()).toBe(w.deps.tempo.token.toLowerCase());
    expect(body.policy.limits).toEqual([{ token: body.policy.scopes[0].address, limit: '10000000', period: 3_600 }]);
  });

  it('refuses bounds that are not bounds', async () => {
    const { cookie, params } = await owned();
    for (const body of [{ ...TERMS, limit: '0' }, { ...TERMS, limit: 10_000_000 }, { ...TERMS, periodSeconds: -1 }, { ...TERMS, token: PAYEES[0] }, { limit: '1' }]) {
      expect((await call(w, postTempoAuthorization, 'POST', { cookie, params, body })).status).toBe(400);
    }
    const inMs = await call(w, postTempoAuthorization, 'POST', { cookie, params, body: { ...TERMS, expiry: (START + 86_400) * 1000 } });
    expect(inMs.body).toMatchObject({ error: 'invalid_input', message: 'expiry must be a unix timestamp in seconds, not milliseconds' });
    expect((await call(w, postTempoAuthorization, 'POST', { cookie, params, body: { ...TERMS, recipients: ['0x1234'] } })).status).toBe(400);
  });

  it('submits what the root signed, once, and answers a repeat without sending again', async () => {
    const { cookie, params, accessKey, chain } = await owned();
    chain.forget();
    const signedWire = await signAuthorization(policyFor(accessKey as `0x${string}`));

    const first = await call(w, postTempoAuthorizationSubmit, 'POST', { cookie, params, body: { terms: TERMS, signedWire } });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ authorized: true, tx: expect.stringMatching(/^0x[0-9a-f]{64}$/), txUrl: expect.stringContaining('https://explore.testnet.tempo.xyz/tx/0x'), sent: true });
    expect(chain.broadcasts).toHaveLength(1);
    expect((await call(w, getTempoRail, 'GET', { cookie, params })).body.key.value).toMatchObject({ authorized: true, remaining: '10000000' });

    const again = await call(w, postTempoAuthorizationSubmit, 'POST', { cookie, params, body: { terms: TERMS, signedWire } });
    expect(again.body).toEqual({ authorized: true, tx: null, txUrl: null, sent: false });
    expect(chain.broadcasts).toHaveLength(1);
  });

  it('takes the bare signature over the sign payload as well', async () => {
    const { cookie, params, chain } = await owned();
    chain.forget();
    const request = (await call(w, postTempoAuthorization, 'POST', { cookie, params, body: TERMS })).body;
    const signature = await ROOT_ACCOUNT.sign({ hash: request.signPayload });
    const answer = await call(w, postTempoAuthorizationSubmit, 'POST', { cookie, params, body: { terms: TERMS, signature } });
    expect(answer.body).toMatchObject({ authorized: true, sent: true });
  });

  it('sends nothing for an authorization the root did not sign, or signed on other terms', async () => {
    const { cookie, params, accessKey, chain } = await owned();
    chain.forget();
    const policy = policyFor(accessKey as `0x${string}`);

    const forged = await signAuthorization(policy, STRANGER);
    const notRoot = await call(w, postTempoAuthorizationSubmit, 'POST', { cookie, params, body: { terms: TERMS, signedWire: forged } });
    expect(notRoot.status).toBe(409);
    expect(notRoot.body).toEqual({ error: 'refused', message: `the authorization is not signed by the root key of ${ROOT}` });

    const generous = await signAuthorization({ ...policy, limit: 999_000_000n });
    const widened = await call(w, postTempoAuthorizationSubmit, 'POST', { cookie, params, body: { terms: TERMS, signedWire: generous } });
    expect(widened.status).toBe(409);
    expect(widened.body.message).toContain('the authorization differs from the expected policy');

    expect((await call(w, postTempoAuthorizationSubmit, 'POST', { cookie, params, body: { terms: TERMS } })).status).toBe(400);
    expect((await call(w, postTempoAuthorizationSubmit, 'POST', { cookie, params, body: { terms: TERMS, signedWire: 'zz' } })).status).toBe(400);
    expect(chain.broadcasts).toEqual([]);
  });

  it('reports a chain it cannot read as a refusal to send, never as done', async () => {
    const { cookie, params, accessKey, chain } = await owned();
    chain.forget();
    chain.failing.add('head');
    const answer = await call(w, postTempoAuthorizationSubmit, 'POST', { cookie, params, body: { terms: TERMS, signedWire: await signAuthorization(policyFor(accessKey as `0x${string}`)) } });
    expect(answer.status).toBe(409);
    expect(answer.body).toEqual({ error: 'refused', message: 'head failed: fetch failed' });
    expect(chain.broadcasts).toEqual([]);
  });
});

describe('the Solana rail', () => {
  it('shows the delegate and what it may still move, read now', async () => {
    const { org, cookie, params } = await owned();
    const { body } = await call(w, getSolanaRail, 'GET', { cookie, params });
    expect(body).toEqual({
      cluster: 'devnet',
      token: { address: w.solana.mint, symbol: 'USDC', decimals: 6 },
      owner: SOLANA_OWNER,
      delegate: await keyAddress(w, org.id, 'solana_delegate'),
      allowance: { status: 'ok', source: 'solana', readAt: w.clock.ms, value: { remaining: '50000000' } },
    });
    w.solana.down = 'fetch failed';
    expect((await call(w, getSolanaRail, 'GET', { cookie, params })).body.allowance).toEqual({ status: 'unavailable', source: 'solana', readAt: w.clock.ms, reason: 'fetch failed' });
  });

  it('hands the owner the unsigned approval and the unsigned revocation', async () => {
    const { org, cookie, params } = await owned();
    const delegate = await keyAddress(w, org.id, 'solana_delegate');
    const approval = await call(w, postSolanaApproval, 'POST', { cookie, params, body: { amount: '25000000' } });
    expect(approval.status).toBe(200);
    expect(approval.body).toEqual({
      transaction: Buffer.from(`approve:${SOLANA_OWNER}:${delegate}:25000000`).toString('base64'),
      summary: { owner: SOLANA_OWNER, tokenAccount: `ata-of-${SOLANA_OWNER}`, mint: w.solana.mint, delegate, amount: '25' },
      lastValidBlockHeight: '300000000',
    });
    const revoke = await call(w, postSolanaRevoke, 'POST', { cookie, params });
    expect(revoke.body.summary).toEqual({ owner: SOLANA_OWNER, tokenAccount: `ata-of-${SOLANA_OWNER}`, mint: w.solana.mint });
    expect(w.solana.sent).toEqual([]);
  });

  it('refuses an amount that is not one, and says when the node cannot be reached or the wallet is not set', async () => {
    const { cookie, params } = await owned();
    for (const body of [{}, { amount: '0' }, { amount: '1.5' }, { amount: 25 }, { amount: '25', delegate: SOLANA_PAYEES[0] }]) {
      expect((await call(w, postSolanaApproval, 'POST', { cookie, params, body })).status).toBe(400);
    }
    w.solana.down = 'fetch failed';
    for (const endpoint of [postSolanaApproval, postSolanaRevoke]) {
      const answer = await call(w, endpoint, 'POST', { cookie, params, body: endpoint === postSolanaApproval ? { amount: '1' } : undefined });
      expect(answer.status).toBe(503);
      expect(answer.body).toEqual({ error: 'unavailable', message: 'Solana is unavailable: fetch failed', source: 'Solana' });
    }
    const unset = await owned({ solanaOwner: null });
    expect((await call(w, postSolanaApproval, 'POST', { cookie: unset.cookie, params: unset.params, body: { amount: '1' } })).body).toEqual({ error: 'refused', message: 'the organisation has no Solana wallet yet; set one in its profile first' });
  });
});

describe('payout rails', () => {
  it('are for the owner alone', async () => {
    const { org, chain } = await owned();
    chain.forget();
    await expectOwnerOnly(
      w,
      org.id,
      [
        { name: 'tempo rail', endpoint: getTempoRail, method: 'GET' },
        { name: 'tempo authorization', endpoint: postTempoAuthorization, method: 'POST', body: TERMS },
        { name: 'tempo authorization submit', endpoint: postTempoAuthorizationSubmit, method: 'POST', body: { terms: TERMS, signedWire: '0xabcd' } },
        { name: 'solana rail', endpoint: getSolanaRail, method: 'GET' },
        { name: 'solana approval', endpoint: postSolanaApproval, method: 'POST', body: { amount: '1' } },
        { name: 'solana revoke', endpoint: postSolanaRevoke, method: 'POST' },
      ],
      async () => expect(chain.broadcasts).toEqual([]),
    );
  });
});

describe('payout runs on Tempo', () => {
  const create = (cookie: string, params: { orgId: string }, lines: unknown = tempoLines) => call(w, postPayout, 'POST', { cookie, params, body: { chain: 'tempo', lines } });
  const execute = (cookie: string, params: { orgId: string }, runId = RUN_1) => call(w, postPayoutExecute, 'POST', { cookie, params: { ...params, runId } });

  it('are created as drafts numbered within the month, each line with a memo that carries the run id', async () => {
    const { org, cookie, params } = await owned();
    const { status, body } = await create(cookie, params);
    expect(status).toBe(201);
    expect(body).toMatchObject({ id: RUN_1, orgId: org.id, chain: 'tempo', token: w.deps.tempo.token, tokenSymbol: 'AlphaUSD', tokenDecimals: 6, account: ROOT, notBefore: null, status: 'draft', total: '3500000', tx: null, txUrl: null, createdAt: w.clock.ms });
    expect(body.lines).toEqual([
      { lineNo: 1, payeeName: 'Ada Lovelace', toAddress: PAYEES[0], amount: '1000000', memo: `${RUN_1}/1`, reference: 'INV-1041', tx: null, logIndex: null, reconciled: false, receiptToken: expect.stringMatching(/^[\w-]{43}$/) },
      { lineNo: 2, payeeName: 'Grace Hopper', toAddress: PAYEES[1], amount: '2500000', memo: `${RUN_1}/2`, reference: 'INV-1042', tx: null, logIndex: null, reconciled: false, receiptToken: expect.stringMatching(/^[\w-]{43}$/) },
    ]);
    expect((await create(cookie, params)).body.id).toBe('HF-2027-01-0002');

    const other = await owned();
    expect((await create(other.cookie, other.params)).body.id).toBe(RUN_1);
    expect((await call(w, getPayouts, 'GET', { cookie, params })).body.runs.map((run: { id: string }) => run.id)).toEqual(['HF-2027-01-0002', RUN_1]);
  });

  it('are not created from lines that could not be paid as written', async () => {
    const { cookie, params } = await owned();
    const [line] = tempoLines;
    const cases: unknown[] = [
      [],
      [{ ...line, amount: '0' }],
      [{ ...line, amount: '1.50' }],
      [{ ...line, amount: 1_000_000 }],
      [{ ...line, amount: '-5' }],
      [{ ...line, reference: 'Rechnung №7' }],
      [{ ...line, reference: ' padded ' }],
      [{ ...line, payee: { name: '', address: PAYEES[0] } }],
      [{ ...line, payee: { name: 'Ada', address: '0x1234' } }],
      [{ ...line, payee: { name: 'Ada', address: PAYEES[0].replace('3c7', '3C7') } }],
      [{ ...line, memo: 'HF-2027-01-0009/1' }],
      Array.from({ length: 33 }, () => line),
    ];
    for (const lines of cases) {
      const answer = await create(cookie, params, lines);
      expect(answer.status, JSON.stringify(lines).slice(0, 80)).toBe(400);
      expect(answer.body.error).toBe('invalid_input');
    }
    expect((await call(w, postPayout, 'POST', { cookie, params, body: { chain: 'base', lines: tempoLines } })).status).toBe(400);
    expect((await call(w, getPayouts, 'GET', { cookie, params })).body.runs).toEqual([]);

    const unset = await owned({ tempoAccount: null });
    expect((await create(unset.cookie, unset.params)).status).toBe(409);
  });

  it('are previewed against the key and the balances as they are now', async () => {
    const { cookie, params, chain } = await owned();
    await create(cookie, params);
    const fine = await call(w, getPayoutPreview, 'GET', { cookie, params: { ...params, runId: RUN_1 } });
    expect(fine.body).toMatchObject({ wouldProceed: true, problems: [], solana: null, run: { id: RUN_1, status: 'draft' } });

    chain.key = { ...chain.key, remaining: 3_000_000n };
    const short = await call(w, getPayoutPreview, 'GET', { cookie, params: { ...params, runId: RUN_1 } });
    expect(short.body.wouldProceed).toBe(false);
    expect(short.body.problems[0]).toContain('the run totals 3.50 but the key may only spend 3.00 more');

    chain.failing.add('head');
    const blind = await call(w, getPayoutPreview, 'GET', { cookie, params: { ...params, runId: RUN_1 } });
    expect(blind.body).toMatchObject({ wouldProceed: false, problems: ['could not read the chain: head failed: fetch failed'] });
    expect(chain.broadcasts).toEqual([]);
  });

  it('are paid in one transaction, and paid once however often that is asked', async () => {
    const { org, cookie, params, chain } = await owned();
    await create(cookie, params);

    const first = await execute(cookie, params);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ outcome: 'paid', replayed: false, error: null, run: { status: 'paid', tx: expect.stringMatching(/^0x[0-9a-f]{64}$/), executedAt: w.clock.ms, error: null } });
    expect(first.body.run.txUrl).toBe(`https://explore.testnet.tempo.xyz/tx/${first.body.run.tx}`);
    expect(chain.broadcasts).toHaveLength(1);
    expect(chain.key.remaining).toBe(6_500_000n);

    const again = await execute(cookie, params);
    expect(again.body).toMatchObject({ outcome: 'paid', replayed: true, run: { status: 'paid', tx: first.body.run.tx } });
    expect(chain.broadcasts).toHaveLength(1);
    expect(chain.key.remaining).toBe(6_500_000n);

    // Even with the record wiped back to a draft, the rail finds the run on chain and sends nothing.
    await connection.client.query("update holdfast.payout_runs set status = 'draft', tx = null where org_id = $1", [org.id]);
    const found = await execute(cookie, params);
    expect(found.body).toMatchObject({ outcome: 'paid', replayed: true, run: { status: 'paid', tx: first.body.run.tx } });
    expect(chain.broadcasts).toHaveLength(1);
  });

  it('are paid once when two requests to pay arrive together', async () => {
    const { cookie, params, chain } = await owned();
    await create(cookie, params);
    const [a, b] = await Promise.all([execute(cookie, params), execute(cookie, params)]);
    expect([a.body.outcome, b.body.outcome]).toEqual(['paid', 'paid']);
    expect(a.body.run.tx).toBe(b.body.run.tx);
    expect(chain.receipts.size).toBe(1);
    expect(chain.key.remaining).toBe(6_500_000n);
  });

  it('are refused, and stay unpaid, while the key is not authorized or the chain cannot be read', async () => {
    const { cookie, params, chain } = await owned();
    await create(cookie, params);
    const authorized = chain.key;

    chain.forget();
    const refusal = await execute(cookie, params);
    expect(refusal.status).toBe(200);
    expect(refusal.body).toMatchObject({ outcome: 'refused', replayed: false, run: { status: 'refused', tx: null } });
    expect(refusal.body.error).toContain('is not authorized on this account');
    expect(refusal.body.run.error).toBe(refusal.body.error);

    chain.key = authorized;
    chain.failing.add('memoLogs');
    const blind = await execute(cookie, params);
    expect(blind.body).toMatchObject({ outcome: 'refused', run: { status: 'refused' }, error: 'memoLogs failed: fetch failed' });
    expect(chain.broadcasts).toEqual([]);

    chain.failing.clear();
    expect((await execute(cookie, params)).body).toMatchObject({ outcome: 'paid', run: { status: 'paid', error: null } });
  });

  it('are left unsettled when a transaction was sent and did not pay, and settle when paid again through the rail', async () => {
    const { cookie, params, chain } = await owned();
    await create(cookie, params);
    chain.onBroadcast = 'drop';
    const dropped = await execute(cookie, params);
    expect(dropped.body).toMatchObject({ outcome: 'unsettled', replayed: false, run: { status: 'sending', tx: expect.stringMatching(/^0x[0-9a-f]{64}$/), executedAt: null } });
    expect(dropped.body.error).toContain('was not included before it expired');

    const status = await call(w, getPayout, 'GET', { cookie, params: { ...params, runId: RUN_1 } });
    expect(status.body).toMatchObject({ run: { status: 'sending' }, onChain: { status: 'ok', source: 'tempo', value: null } });

    chain.onBroadcast = 'mine';
    const retried = await execute(cookie, params);
    expect(retried.body).toMatchObject({ outcome: 'paid', replayed: false, run: { status: 'paid', error: null } });
    expect(retried.body.run.tx).not.toBe(dropped.body.run.tx);
    expect(chain.receipts.size).toBe(1);
  });

  it('are shown beside what the chain holds for them, and settled by it when the record is behind', async () => {
    const { org, cookie, params, chain } = await owned();
    await create(cookie, params);
    const runParams = { ...params, runId: RUN_1 };
    expect((await call(w, getPayout, 'GET', { cookie, params: runParams })).body).toMatchObject({ run: { status: 'draft' }, onChain: null });

    const paid = (await execute(cookie, params)).body.run;
    // The record of a payment whose answer was lost: sent, as far as the database knows.
    await connection.client.query("update holdfast.payout_runs set status = 'sending', tx = null, executed_at = null where org_id = $1", [org.id]);

    const { body } = await call(w, getPayout, 'GET', { cookie, params: runParams });
    expect(body.onChain).toMatchObject({ status: 'ok', source: 'tempo', value: { tx: paid.tx, otherTxs: [], matchesRun: true } });
    expect(body.onChain.value.transfers).toEqual([
      { to: PAYEES[0], amount: '1000000', memo: `${RUN_1}/1`, logIndex: expect.any(Number) },
      { to: PAYEES[1], amount: '2500000', memo: `${RUN_1}/2`, logIndex: expect.any(Number) },
    ]);
    expect(body.run).toMatchObject({ status: 'paid', tx: paid.tx, executedAt: w.clock.ms });
    expect(body.run.lines.map((line: { reconciled: boolean; tx: string; logIndex: number }) => [line.reconciled, line.tx, typeof line.logIndex])).toEqual([[true, paid.tx, 'number'], [true, paid.tx, 'number']]);

    chain.failing.add('memoLogs');
    const blind = await call(w, getPayout, 'GET', { cookie, params: runParams });
    expect(blind.status).toBe(200);
    expect(blind.body.onChain).toEqual({ status: 'unavailable', source: 'tempo', readAt: w.clock.ms, reason: 'memoLogs failed: fetch failed' });
    expect(blind.body.run.status).toBe('paid');
  });

  it('are unknown under an id that is not theirs', async () => {
    const { cookie, params } = await owned();
    await create(cookie, params);
    const other = await owned();
    for (const endpoint of [getPayout, getPayoutPreview]) {
      expect((await call(w, endpoint, 'GET', { cookie: other.cookie, params: { ...other.params, runId: RUN_1 } })).status).toBe(404);
      expect((await call(w, endpoint, 'GET', { cookie, params: { ...params, runId: 'HF-2027-01-0099' } })).status).toBe(404);
      expect((await call(w, endpoint, 'GET', { cookie, params: { ...params, runId: 'january-payroll' } })).status).toBe(404);
    }
    expect((await execute(other.cookie, other.params)).status).toBe(404);
    expect((await call(w, getPayout, 'GET', { cookie, params: { ...params, runId: RUN_1 } })).body.run.status).toBe('draft');
  });
});

describe('payout runs on Solana', () => {
  const create = (cookie: string, params: { orgId: string }, lines: unknown = solanaLines) => call(w, postPayout, 'POST', { cookie, params, body: { chain: 'solana', lines } });
  const execute = (cookie: string, params: { orgId: string }) => call(w, postPayoutExecute, 'POST', { cookie, params: { ...params, runId: RUN_1 } });

  it('record a slot safely in the past as their lower bound, and carry each reference as the line’s memo', async () => {
    const { cookie, params } = await owned();
    const { status, body } = await create(cookie, params);
    expect(status).toBe(201);
    expect(body).toMatchObject({ id: RUN_1, chain: 'solana', token: w.solana.mint, tokenSymbol: 'USDC', account: SOLANA_OWNER, notBefore: '412000000', status: 'draft', total: '10000000' });
    expect(body.lines.map((line: { memo: string; reference: string }) => [line.memo, line.reference])).toEqual([['INV-7', 'INV-7'], ['', '']]);
  });

  it('are not created without that bound, nor from lines the books could not tell apart', async () => {
    const { cookie, params } = await owned();
    w.solana.down = 'fetch failed';
    const blind = await create(cookie, params);
    expect(blind.status).toBe(503);
    expect(blind.body).toEqual({ error: 'unavailable', message: 'Solana is unavailable: fetch failed', source: 'Solana' });
    w.solana.down = null;

    const [line] = solanaLines;
    expect((await create(cookie, params, [line, line])).body.message).toBe('line 2: reference "INV-7" is used by an earlier line');
    expect((await create(cookie, params, [{ ...line, payee: { name: 'x', address: PAYEES[0] } }])).body.message).toContain('is not a Solana address');
    expect((await create(cookie, params, [{ ...line, amount: (2n ** 64n).toString() }])).body.message).toContain('more than a token account can hold');
    expect((await call(w, getPayouts, 'GET', { cookie, params })).body.runs).toEqual([]);
  });

  it('are paid once, with their lower bound handed to the rail', async () => {
    const { cookie, params } = await owned();
    await create(cookie, params);
    const preview = await call(w, getPayoutPreview, 'GET', { cookie, params: { ...params, runId: RUN_1 } });
    expect(preview.body).toMatchObject({ wouldProceed: true, problems: [], solana: { alreadyPaid: false, spent: false, cost: { newTokenAccounts: 0, markerLamports: '897840', feeLamports: '5000' } } });

    const first = await execute(cookie, params);
    expect(first.body).toMatchObject({ outcome: 'paid', replayed: false, run: { status: 'paid', tx: w.solana.sent[0], executedAt: w.clock.ms } });
    expect(first.body.run.txUrl).toBe(`https://explorer.solana.com/tx/${w.solana.sent[0]}?cluster=devnet`);
    expect(w.solana.payCalls).toHaveLength(1);
    expect(w.solana.payCalls[0]).toMatchObject({ account: SOLANA_OWNER, runId: RUN_1, notBefore: 412_000_000n, lines: [{ to: SOLANA_PAYEES[0], amount: 4_000_000n, memo: 'INV-7' }, { to: SOLANA_PAYEES[1], amount: 6_000_000n, memo: '' }] });

    const again = await execute(cookie, params);
    expect(again.body).toMatchObject({ outcome: 'paid', replayed: true });
    expect(w.solana.payCalls).toHaveLength(1);
    expect(w.solana.sent).toHaveLength(1);
    expect(w.solana.allowance).toBe(40_000_000n);
  });

  it('are refused over the allowance and stay unpaid', async () => {
    const { cookie, params } = await owned();
    await create(cookie, params);
    w.solana.allowance = 9_999_999n;
    const refusal = await execute(cookie, params);
    expect(refusal.body).toMatchObject({ outcome: 'refused', error: 'exceeds delegated allowance: run needs 10000000, 9999999 remaining', run: { status: 'refused', tx: null } });
    expect(w.solana.sent).toEqual([]);
    w.solana.allowance = 10_000_000n;
    expect((await execute(cookie, params)).body).toMatchObject({ outcome: 'paid', run: { status: 'paid' } });
  });

  it('are recorded as failed when the transaction certainly paid nothing', async () => {
    const { cookie, params } = await owned();
    await create(cookie, params);
    w.solana.nextPay = 'fail';
    expect((await execute(cookie, params)).body).toMatchObject({ outcome: 'failed', run: { status: 'failed', tx: w.solana.sent[0], executedAt: null } });
    expect((await execute(cookie, params)).body).toMatchObject({ outcome: 'paid', run: { status: 'paid', tx: w.solana.sent[1] } });
  });

  it('are left as they were when the rail would not send for a passing reason', async () => {
    const { cookie, params } = await owned();
    await create(cookie, params);
    w.solana.refuseWith = `could not rule out that run ${RUN_1} was paid before: the history of the paying account could not be read`;
    const waiting = await execute(cookie, params);
    expect(waiting.body).toMatchObject({ outcome: 'not_sent', run: { status: 'draft', tx: null }, error: w.solana.refuseWith });
    w.solana.refuseWith = null;
    expect((await execute(cookie, params)).body.outcome).toBe('paid');
  });

  it('are never sent a second time under the same id once an attempt was left unsettled', async () => {
    const { cookie, params } = await owned();
    await create(cookie, params);
    w.solana.nextPay = 'unknown';
    const first = await execute(cookie, params);
    expect(first.body).toMatchObject({ outcome: 'unsettled', run: { status: 'sending', tx: w.solana.sent[0], executedAt: null } });

    const second = await execute(cookie, params);
    expect(second.body).toMatchObject({ outcome: 'unsettled', run: { status: 'sending' }, error: `no payment of run ${RUN_1} is on chain; it stays unsettled and is not sent again under the same id` });
    expect(w.solana.payCalls).toHaveLength(1);

    w.solana.down = 'fetch failed';
    const blind = await execute(cookie, params);
    expect(blind.status).toBe(503);
    expect(blind.body.message).toBe(`Solana is unavailable: run ${RUN_1} is unsettled and could not be looked up: fetch failed`);
    w.solana.down = null;

    // The transaction of the first attempt lands after all.
    const sent = w.solana.payCalls[0];
    w.solana.paid.set(RUN_1, { runId: RUN_1, signature: w.solana.sent[0] ?? '', slot: 412_000_050n, time: w.clock.ms, total: 10_000_000n, transfers: (sent?.lines ?? []).map((l) => ({ to: l.to, tokenAccount: `ata-of-${l.to}`, amount: l.amount, memo: l.memo === '' ? null : l.memo })) });
    const settled = await execute(cookie, params);
    expect(settled.body).toMatchObject({ outcome: 'paid', replayed: true, run: { status: 'paid', tx: w.solana.sent[0] } });
    expect(w.solana.payCalls).toHaveLength(1);
  });
});

describe('payout runs', () => {
  it('are for the owner alone', async () => {
    const { org, cookie, params, chain } = await owned();
    await call(w, postPayout, 'POST', { cookie, params, body: { chain: 'tempo', lines: tempoLines } });
    await expectOwnerOnly(
      w,
      org.id,
      [
        { name: 'list', endpoint: getPayouts, method: 'GET' },
        { name: 'create', endpoint: postPayout, method: 'POST', body: { chain: 'tempo', lines: tempoLines } },
        { name: 'status', endpoint: getPayout, method: 'GET', params: { runId: RUN_1 } },
        { name: 'preview', endpoint: getPayoutPreview, method: 'GET', params: { runId: RUN_1 } },
        { name: 'execute', endpoint: postPayoutExecute, method: 'POST', params: { runId: RUN_1 } },
      ],
      async () => {
        expect(chain.broadcasts).toEqual([]);
        expect((await w.store.listPayoutRuns(org.id)).map((run) => [run.id, run.status])).toEqual([[RUN_1, 'draft']]);
      },
    );
  });
});
