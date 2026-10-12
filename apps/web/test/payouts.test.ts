import type { PgliteConnection } from '@holdfast/db';
import { type RevocationRequest, accessKeyAddressOf, buildRevoke, transferCall } from '@holdfast/tempo';
import { type Hex, getAddress } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { Account } from 'viem/tempo';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getOrg } from '../src/server/api/orgs';
import { getPayout, getPayoutPreview, getPayouts, postPayout, postPayoutExecute } from '../src/server/api/payouts';
import {
  getSolanaRail,
  getTempoRail,
  postSolanaApproval,
  postSolanaRevoke,
  postTempoAuthorization,
  postTempoAuthorizationSubmit,
  postTempoKey,
  postTempoRevoke,
  postTempoRevokeSubmit,
} from '../src/server/api/rails';
import { getSafety, postProbe } from '../src/server/api/safety';
import { expectOwnerOnly } from './support/access';
import { SOLANA_OWNER, SOLANA_PAYEES } from './support/fakes';
import {
  PAYEES,
  ROOT,
  ROOT_ACCOUNT,
  RPC_URL,
  SPONSOR_KEY,
  START,
  STARTUP_TIMEOUT_MS,
  STRANGER,
  type World,
  call,
  keyAddress,
  migratedPglite,
  newAccount,
  organisation,
  policyFor,
  sessionOf,
  signAuthorization,
  signRevocation,
  world,
} from './support/world';

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

describe('taking the Tempo access key back', () => {
  const prepare = (cookie: string, params: { orgId: string }) => call(w, postTempoRevoke, 'POST', { cookie, params });
  const submit = (cookie: string, params: { orgId: string }, signedTransaction: unknown) => call(w, postTempoRevokeSubmit, 'POST', { cookie, params, body: { signedTransaction } });

  /** What the route answered with, as the root's wallet has it: gas and fees as numbers again. */
  const revocationOf = (body: Record<string, string>): RevocationRequest =>
    ({ ...body, nonceKey: BigInt(body.nonceKey ?? ''), gas: BigInt(body.gas ?? ''), maxFeePerGas: BigInt(body.maxFeePerGas ?? ''), maxPriorityFeePerGas: BigInt(body.maxPriorityFeePerGas ?? '') }) as unknown as RevocationRequest;

  /** An organisation with a live key, and the revocation its route prepared. */
  async function prepared() {
    const made = await owned();
    const answer = await prepare(made.cookie, made.params);
    expect(answer.status).toBe(200);
    return { ...made, request: revocationOf(answer.body) };
  }

  it('says what the root signs: the revocation of this key on this chain, with the sponsor paying', async () => {
    const { org, cookie, params, accessKey, chain } = await owned();
    const { status, body, text } = await prepare(cookie, params);
    expect(status).toBe(200);
    expect(body).toEqual({
      chainId: 42_431,
      accessKey,
      nonce: 0,
      nonceKey: '0',
      gas: '600000',
      maxFeePerGas: '1200000000',
      maxPriorityFeePerGas: '1',
      feePayer: privateKeyToAddress(SPONSOR_KEY),
      feeToken: getAddress(w.deps.tempo.token),
      validBefore: chain.time + 120,
    });
    // It names who pays and holds no key: not the sponsor's, not the access key's.
    expect(text).not.toContain(SPONSOR_KEY.slice(2));
    expect(text).not.toContain(((await w.store.activeKey(org.id, 'tempo_access'))?.secret ?? '').slice(2));
    // Asking changes nothing, and the nonce follows the account's own sequence.
    expect([chain.revocations, chain.broadcasts]).toEqual([[], []]);
    chain.useOwnNonce();
    expect((await prepare(cookie, params)).body.nonce).toBe(1);
  });

  it('sends the revocation the root signed, and the rail then shows the key revoked from the chain', async () => {
    const { cookie, params, accessKey, chain, request } = await prepared();
    const signedTransaction = await signRevocation(request);

    const answer = await submit(cookie, params, signedTransaction);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ tx: chain.broadcasts[0], txUrl: `https://explore.testnet.tempo.xyz/tx/${chain.broadcasts[0]}` });
    expect(chain.broadcasts).toHaveLength(1);
    expect(chain.revocations).toHaveLength(1);
    expect(chain.revocations[0]).toMatchObject({ root: ROOT, accessKey, nonce: 0, validBefore: request.validBefore });

    const rail = await call(w, getTempoRail, 'GET', { cookie, params });
    expect(rail.body.key).toMatchObject({ status: 'ok', source: 'tempo', value: { accessKey, revoked: true, authorized: false, live: false, remaining: '0' } });

    // Nothing is left to revoke: neither route does anything a second time.
    const nothing = { error: 'refused', message: `access key ${accessKey} is already revoked on this account; there is nothing to revoke` };
    const again = await prepare(cookie, params);
    expect([again.status, again.body]).toEqual([409, nothing]);
    const resent = await submit(cookie, params, signedTransaction);
    expect([resent.status, resent.body]).toEqual([409, nothing]);
    expect(chain.broadcasts).toHaveLength(1);
  });

  it('has nothing to revoke without a Tempo account, or for a key the chain does not show as authorized', async () => {
    const unset = await owned({ tempoAccount: null });
    const noAccount = { error: 'refused', message: 'the organisation has no Tempo account yet; set one in its profile first' };
    const asked = await prepare(unset.cookie, unset.params);
    expect([asked.status, asked.body]).toEqual([409, noAccount]);
    const sent = await submit(unset.cookie, unset.params, '0x78abcd');
    expect([sent.status, sent.body]).toEqual([409, noAccount]);

    const never = await owned();
    never.chain.forget();
    expect((await prepare(never.cookie, never.params)).body).toEqual({ error: 'refused', message: `access key ${never.accessKey} is not authorized on this account; there is nothing to revoke` });

    const revoked = await owned();
    revoked.chain.revoke();
    expect((await prepare(revoked.cookie, revoked.params)).body).toEqual({ error: 'refused', message: `access key ${revoked.accessKey} is already revoked on this account; there is nothing to revoke` });

    const expired = await owned();
    expired.chain.time = START + 86_400;
    const lapsed = await prepare(expired.cookie, expired.params);
    expect(lapsed.status).toBe(409);
    expect(lapsed.body.message).toMatch(/^access key 0x[0-9a-fA-F]{40} expired at 2026-10-11T.* and can sign nothing; there is nothing to revoke$/);

    // A transaction the root did sign, for a key that has gone in the meantime, is not sent either.
    const late = await prepared();
    late.chain.forget();
    const refused = await submit(late.cookie, late.params, await signRevocation(late.request));
    expect([refused.status, refused.body.message]).toEqual([409, `access key ${late.accessKey} is not authorized on this account; there is nothing to revoke`]);
    for (const { chain } of [unset, never, revoked, expired, late]) expect(chain.broadcasts).toEqual([]);
  });

  it('sends nothing that is not the revocation of this organisation’s key by the root of its account', async () => {
    const { cookie, params, accessKey, chain, request } = await prepared();
    const token = w.deps.tempo.token;
    const revoke = buildRevoke({ accessKeyAddress: accessKey as Hex });
    const stranger = Account.fromSecp256k1(`0x${'b2'.repeat(32)}`);
    // Another organisation on the same Tempo account: its key is its own, and its revocation is not this one's.
    const other = await prepared();

    const cases: [string, Hex, string][] = [
      ['a payment out of the account', await signRevocation(request, ROOT_ACCOUNT, { calls: [transferCall(token, PAYEES[0], 250_000_000n)] }), `the transaction's call is not revokeKey(${accessKey}) on the Account Keychain`],
      ['the revocation and a payment in one', await signRevocation(request, ROOT_ACCOUNT, { calls: [revoke, transferCall(token, PAYEES[0], 250_000_000n)] }), 'the transaction makes 2 calls, expected the revocation alone'],
      ['the revocation of another key', await signRevocation(other.request), `the transaction revokes key ${other.accessKey}, this rail's key is ${accessKey}`],
      ['a revocation another account signed', await signRevocation(request, stranger), `the transaction is sent by ${stranger.address}, not by ${ROOT}`],
      ['a revocation the account would pay for itself', await signRevocation(request, ROOT_ACCOUNT, { feePayer: undefined, feeToken: token }), 'the transaction is signed for the account to pay the fee itself, not for the fee sponsor to pay it'],
      ['a revocation for another chain', await signRevocation(request, ROOT_ACCOUNT, { chainId: 4_217 }), 'the transaction is for chain 4217, this rail runs on chain 42431'],
      ['a revocation at a fee of the signer’s choosing', await signRevocation({ ...request, maxFeePerGas: 10n ** 24n }), 'the transaction offers 1000000000000000000000000 per gas, more than the 1800000000 this rail pays at a base fee of 600000000'],
      ['bytes that are no transaction', '0x78abcd', 'the transaction cannot be read: '],
    ];
    for (const [what, signedTransaction, message] of cases) {
      const answer = await submit(cookie, params, signedTransaction);
      expect(answer.status, what).toBe(409);
      expect(answer.body.error, what).toBe('refused');
      expect(answer.body.message, what).toContain(message);
      expect(answer.body.tx, what).toBeUndefined();
    }
    // Not one of them reached the sponsor's key or the node, and the key is as it was.
    expect([chain.revocations, chain.broadcasts, other.chain.broadcasts]).toEqual([[], [], []]);
    expect((await call(w, getTempoRail, 'GET', { cookie, params })).body.key.value).toMatchObject({ authorized: true, revoked: false });
  });

  it('reports a transaction the node did not take, or did not include, as that', async () => {
    const rejected = await prepared();
    rejected.chain.broadcast = async () => ({ accepted: false, reason: `fee payer balance insufficient (asked at ${RPC_URL})` });
    const turnedDown = await submit(rejected.cookie, rejected.params, await signRevocation(rejected.request));
    expect(turnedDown.status).toBe(409);
    expect(turnedDown.body).toEqual({ error: 'refused', message: 'the node rejected the transaction: fee payer balance insufficient (asked at [redacted])' });

    const dropped = await prepared();
    dropped.chain.onBroadcast = 'drop';
    const expired = await submit(dropped.cookie, dropped.params, await signRevocation(dropped.request));
    expect(expired.status).toBe(409);
    expect(expired.body).toEqual({
      error: 'refused',
      message: expect.stringMatching(/^the transaction was not included before it expired at 2026-10-10T.*; it revoked nothing and can never be included$/),
      tx: dropped.chain.broadcasts[0],
      txUrl: `https://explore.testnet.tempo.xyz/tx/${dropped.chain.broadcasts[0]}`,
    });

    const unreadable = await prepared();
    unreadable.chain.failing.add('head');
    const blind = await submit(unreadable.cookie, unreadable.params, await signRevocation(unreadable.request));
    expect([blind.status, blind.body]).toEqual([409, { error: 'refused', message: 'head failed: fetch failed' }]);
    expect(unreadable.chain.broadcasts).toEqual([]);

    // None of the three is revoked, and the rail says so.
    for (const { cookie, params, chain } of [rejected, dropped, unreadable]) {
      chain.failing.clear();
      expect((await call(w, getTempoRail, 'GET', { cookie, params })).body.key.value).toMatchObject({ revoked: false, authorized: true });
    }
  });

  it('says the chain is unavailable when it cannot be read for what to sign', async () => {
    const { cookie, params, chain } = await owned();
    for (const method of ['keyState', 'head', 'accountNonce'] as const) {
      chain.failing.clear();
      chain.failing.add(method);
      const answer = await prepare(cookie, params);
      expect(answer.status, method).toBe(503);
      expect(answer.body, method).toEqual({ error: 'unavailable', message: `Tempo is unavailable: ${method} failed: fetch failed`, source: 'Tempo' });
    }
  });

  it('takes a signed transaction and nothing else, and is told nothing about which key to revoke', async () => {
    const { cookie, params, chain, request } = await prepared();
    const signedTransaction = await signRevocation(request);
    for (const body of [{}, { signedTransaction: 'zz' }, { signedTransaction: 76 }, { signedTransaction: `0x${'ab'.repeat(4_000)}` }, { signedTransaction, accessKey: PAYEES[0] }]) {
      expect((await call(w, postTempoRevokeSubmit, 'POST', { cookie, params, body })).status).toBe(400);
    }
    expect((await call(w, postTempoRevoke, 'POST', { cookie, params, body: { accessKey: PAYEES[0] } })).status).toBe(400);
    expect(chain.broadcasts).toEqual([]);
    // Within what the endpoint takes for a transaction a passkey signed, with room to spare.
    expect(signedTransaction.length).toBeLessThan(8_000);
  });
});

describe('a new Tempo access key in the place of a dead one', () => {
  const replace = (cookie: string, params: { orgId: string }) => call(w, postTempoKey, 'POST', { cookie, params });
  const tempoKeys = async (orgId: string) => (await w.store.listKeys(orgId)).filter((key) => key.kind === 'tempo_access');
  /** The organisation's Tempo keys by where they stand, as addresses in order: keys made in the same instant are listed by address. */
  const standing = async (orgId: string) => {
    const keys = await tempoKeys(orgId);
    const of = (status: string) => keys.filter((key) => key.status === status).map((key) => key.address).sort();
    return { active: of('active'), revoked: of('revoked') };
  };

  /** Whether a key made now starts the way a real one does, unknown to the chain. The world's chains otherwise hold every key they are made for as authorized already. */
  let unknownToTheChain = false;

  beforeEach(() => {
    unknownToTheChain = false;
    const make = w.deps.tempo.newAccessKey;
    w.deps.tempo.newAccessKey = () => {
      const key = make();
      if (unknownToTheChain) w.tempoChain(key.address).forget();
      return key;
    };
  });

  /** An organisation whose first key the chain holds as live, in a world where every key made after it is new to the chain. */
  async function ownedWithFreshKeys(over: { tempoAccount?: string | null } = {}) {
    unknownToTheChain = false;
    try {
      return await owned(over);
    } finally {
      unknownToTheChain = true;
    }
  }

  it('is issued once the chain shows the key revoked, and the retired key signs nothing after that', async () => {
    const { org, cookie, params, accessKey, chain } = await ownedWithFreshKeys();
    // What happened under the old key stays on record: a run that is drafted, and a refusal the chain recorded.
    const run = (await call(w, postPayout, 'POST', { cookie, params, body: { chain: 'tempo', lines: tempoLines } })).body;
    const probe = await call(w, postProbe, 'POST', { cookie, params, body: { kind: 'tempo_out_of_scope' } });
    expect(probe.body).toMatchObject({ refused: true, refusals: [{ chain: 'tempo', kind: 'out_of_scope' }] });

    // The root takes the key back, through the application.
    const request = (await call(w, postTempoRevoke, 'POST', { cookie, params })).body;
    const signedTransaction = await signRevocation({ ...request, nonceKey: 0n, gas: BigInt(request.gas), maxFeePerGas: BigInt(request.maxFeePerGas), maxPriorityFeePerGas: BigInt(request.maxPriorityFeePerGas) });
    expect((await call(w, postTempoRevokeSubmit, 'POST', { cookie, params, body: { signedTransaction } })).status).toBe(200);
    const sentWithOldKey = [...chain.broadcasts];
    w.clock.advance(60_000);

    const answer = await replace(cookie, params);
    expect(answer.status).toBe(200);
    const fresh: string = answer.body.accessKey;
    expect(fresh).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(fresh).not.toBe(accessKey);
    // Exactly what the rail answers, now for the new key: nothing has authorized it and it can spend nothing.
    expect(answer.body).toEqual({
      network: 'moderato',
      chainId: 42_431,
      token: { address: w.deps.tempo.token, symbol: 'AlphaUSD', decimals: 6 },
      account: ROOT,
      accessKey: fresh,
      key: { status: 'ok', source: 'tempo', readAt: w.clock.ms, value: expect.objectContaining({ accessKey: fresh, authorized: false, live: false, revoked: false, expiresAt: null, remaining: '0' }) },
    });
    expect((await call(w, getTempoRail, 'GET', { cookie, params })).body).toEqual(answer.body);

    // The old key keeps its row and its address and is no longer the active one; the new one is stored as the first was.
    expect(await tempoKeys(org.id)).toEqual([
      { kind: 'tempo_access', address: fresh, status: 'active', createdAt: w.clock.ms, revokedAt: null },
      { kind: 'tempo_access', address: accessKey, status: 'revoked', createdAt: w.clock.ms - 60_000, revokedAt: w.clock.ms },
    ]);
    const stored = await w.store.activeKey(org.id, 'tempo_access');
    expect(accessKeyAddressOf(stored?.secret as Hex)).toBe(fresh);
    expect(answer.text).not.toContain((stored?.secret ?? '').slice(2));
    const rows = await connection.client.query<{ address: string; secret_enc: string }>("select address, secret_enc from holdfast.keys where org_id = $1 and kind = 'tempo_access'", [org.id]);
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) expect(row.secret_enc).toMatch(/^v1\./);

    // Everything that names the organisation's key names the new one.
    const view = await call(w, getOrg, 'GET', { cookie, params });
    expect(view.body.serviceKeys.filter((key: { kind: string }) => key.kind === 'tempo_access')).toEqual([{ kind: 'tempo_access', address: fresh }]);
    const safety = await call(w, getSafety, 'GET', { cookie, params });
    expect(safety.body.keys.find((key: { kind: string }) => key.kind === 'tempo_access')).toMatchObject({ address: fresh, scope: { status: 'ok', value: { accessKey: fresh, authorized: false, revoked: false } } });
    // The refusal the chain recorded for the retired key is still part of the record.
    expect(safety.body.refusals).toEqual(probe.body.refusals);

    // A payout is not attempted with the retired key: the run waits on the new one, which nothing has authorized yet.
    const waiting = await call(w, postPayoutExecute, 'POST', { cookie, params: { ...params, runId: run.id } });
    expect(waiting.body).toMatchObject({ outcome: 'refused', error: `access key ${fresh} is not authorized on this account` });
    expect(chain.broadcasts).toEqual(sentWithOldKey);

    // Once the root authorizes the new key, the same run is paid with it.
    const submitted = await call(w, postTempoAuthorizationSubmit, 'POST', { cookie, params, body: { terms: TERMS, signedWire: await signAuthorization(policyFor(fresh as Hex)) } });
    expect(submitted.body).toMatchObject({ authorized: true, sent: true });
    const paid = await call(w, postPayoutExecute, 'POST', { cookie, params: { ...params, runId: run.id } });
    expect(paid.body).toMatchObject({ outcome: 'paid', run: { status: 'paid' } });
    expect(w.tempoChain(fresh).broadcasts).toContain(paid.body.run.tx);
    expect(chain.broadcasts).toEqual(sentWithOldKey);
    expect(chain.signed).toHaveLength(1);
  });

  it('is issued for a key that has expired, the same way', async () => {
    const { org, cookie, params, accessKey, chain } = await ownedWithFreshKeys();
    // A minute short of the expiry the key still signs, and stays.
    chain.time = START + 86_400 - 60;
    const early = await replace(cookie, params);
    expect([early.status, early.body.message]).toEqual([409, `access key ${accessKey} is authorized on this account and can still pay; revoke it before a new key takes its place`]);

    chain.time = START + 86_400;
    expect((await call(w, getTempoRail, 'GET', { cookie, params })).body.key.value).toMatchObject({ authorized: false, live: false, revoked: false, expiresAt: (START + 86_400) * 1000 });
    const answer = await replace(cookie, params);
    expect(answer.status).toBe(200);
    expect(answer.body.accessKey).not.toBe(accessKey);
    expect(answer.body.key).toMatchObject({ status: 'ok', value: { accessKey: answer.body.accessKey, authorized: false, live: false, revoked: false, remaining: '0' } });
    expect(await standing(org.id)).toEqual({ active: [answer.body.accessKey], revoked: [accessKey] });

    const run = (await call(w, postPayout, 'POST', { cookie, params, body: { chain: 'tempo', lines: tempoLines } })).body;
    const waiting = await call(w, postPayoutExecute, 'POST', { cookie, params: { ...params, runId: run.id } });
    expect(waiting.body.error).toBe(`access key ${answer.body.accessKey} is not authorized on this account`);
    expect([chain.signed, chain.broadcasts]).toEqual([[], []]);
  });

  it('is not issued while the key can still sign, or when it was never authorized: nothing changes', async () => {
    const usable = await ownedWithFreshKeys();
    const unbounded = await ownedWithFreshKeys();
    unbounded.chain.key = { ...unbounded.chain.key, enforceLimits: false, isScoped: false, scopes: [] };
    const never = await ownedWithFreshKeys();
    never.chain.forget();
    const unset = await ownedWithFreshKeys({ tempoAccount: null });
    // A key the keychain holds with an expiry of zero: not a time that has passed, so not a key that is known to be dead.
    const undated = await ownedWithFreshKeys();
    undated.chain.key = { ...undated.chain.key, expiry: 0n };

    const cases: [string, typeof usable, string][] = [
      ['a key that pays', usable, `access key ${usable.accessKey} is authorized on this account and can still pay; revoke it before a new key takes its place`],
      ['a live key the rail would not pay with', unbounded, `access key ${unbounded.accessKey} is live on this account and can still sign; revoke it before a new key takes its place`],
      ['a key held without a stated expiry', undated, `the chain holds access key ${undated.accessKey} on this account with an expiry it does not state; revoke it before a new key takes its place`],
      ['a key nobody authorized', never, `access key ${never.accessKey} was never authorized on this account; nothing is wrong with it, and it is not replaced`],
      ['an organisation without a Tempo account', unset, 'the organisation has no Tempo account yet; set one in its profile first'],
    ];
    for (const [what, made, message] of cases) {
      const before = await w.store.activeKey(made.org.id, 'tempo_access');
      const answer = await replace(made.cookie, made.params);
      expect(answer.status, what).toBe(409);
      expect(answer.body, what).toEqual({ error: 'refused', message });
      expect(await w.store.activeKey(made.org.id, 'tempo_access'), what).toEqual(before);
      expect(await tempoKeys(made.org.id), what).toEqual([expect.objectContaining({ address: made.accessKey, status: 'active', revokedAt: null })]);
    }
    // It takes no input: nobody names the key to retire or the key to install.
    usable.chain.revoke();
    expect((await call(w, postTempoKey, 'POST', { cookie: usable.cookie, params: usable.params, body: { accessKey: PAYEES[0] } })).status).toBe(400);
    expect(await keyAddress(w, usable.org.id, 'tempo_access')).toBe(usable.accessKey);
  });

  it('is not issued while the chain cannot be read, however dead the key was last seen', async () => {
    const { org, cookie, params, accessKey, chain } = await ownedWithFreshKeys();
    chain.revoke();
    expect((await call(w, getTempoRail, 'GET', { cookie, params })).body.key.value.revoked).toBe(true);
    for (const method of ['assertChain', 'keyState', 'head'] as const) {
      chain.failing.clear();
      chain.failing.add(method);
      const answer = await replace(cookie, params);
      expect(answer.status, method).toBe(503);
      expect(answer.body, method).toEqual({ error: 'unavailable', message: `Tempo is unavailable: ${method} failed: fetch failed`, source: 'Tempo' });
      expect(await tempoKeys(org.id), method).toEqual([expect.objectContaining({ address: accessKey, status: 'active' })]);
    }
    chain.failing.clear();
    expect((await replace(cookie, params)).status).toBe(200);
  });

  it('is issued once for one dead key, however often and however closely together it is asked for', async () => {
    const twice = await ownedWithFreshKeys();
    twice.chain.revoke();
    const first = await replace(twice.cookie, twice.params);
    expect(first.status).toBe(200);
    // The new key is one nobody authorized yet, and nothing is wrong with it.
    const second = await replace(twice.cookie, twice.params);
    expect([second.status, second.body]).toEqual([409, { error: 'refused', message: `access key ${first.body.accessKey} was never authorized on this account; nothing is wrong with it, and it is not replaced` }]);
    expect(await standing(twice.org.id)).toEqual({ active: [first.body.accessKey], revoked: [twice.accessKey] });

    // Three requests at the same moment: none is told the key is revoked before all three have asked the chain about it.
    const together = await ownedWithFreshKeys();
    together.chain.revoke();
    let asked = 0;
    let allAsked: () => void = () => undefined;
    const everyoneAsked = new Promise<void>((resolve) => {
      allAsked = resolve;
    });
    const keyState = together.chain.keyState.bind(together.chain);
    together.chain.keyState = async (root) => {
      if (++asked === 3) allAsked();
      await everyoneAsked;
      return keyState(root);
    };
    const answers = await Promise.all([1, 2, 3].map(() => replace(together.cookie, together.params)));
    expect(asked).toBe(3);
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200]);
    expect(new Set(answers.map((answer) => answer.body.accessKey)).size).toBe(1);
    // One new key stands in the old one's place; the keys the two late requests made were never stored.
    expect(await standing(together.org.id)).toEqual({ active: [answers[0]?.body.accessKey], revoked: [together.accessKey] });
  });

  it('is for the owner alone, and a stranger retires nothing', async () => {
    const { org, accessKey, chain } = await ownedWithFreshKeys();
    // A key the owner would be given a replacement for.
    chain.revoke();
    await expectOwnerOnly(w, org.id, [{ name: 'tempo key', endpoint: postTempoKey, method: 'POST' }], async () => {
      expect(await tempoKeys(org.id)).toEqual([expect.objectContaining({ address: accessKey, status: 'active', revokedAt: null })]);
    });
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
        { name: 'tempo revoke', endpoint: postTempoRevoke, method: 'POST' },
        { name: 'tempo revoke submit', endpoint: postTempoRevokeSubmit, method: 'POST', body: { signedTransaction: '0x78abcd' } },
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
