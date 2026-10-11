import { DEFAULT_POLICY } from '@holdfast/core';
import type { PgliteConnection } from '@holdfast/db';
import { testDeriveKeys } from '@ledgerhq/zcash-utils';
import { getAddress } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getMe, getNonce, postLogout, postVerify } from '../src/server/api/auth';
import { getOrg, getOrgs, patchOrg, postOrg } from '../src/server/api/orgs';
import { SESSION_COOKIE, SESSION_TTL_SECONDS, issueSession } from '../src/server/auth/session';
import { SOLANA_OWNER } from './support/fakes';
import { HOST, ORIGIN, OWNER, ROOT, STARTUP_TIMEOUT_MS, STRANGER, UFVK, type World, call, migratedPglite, newAccount, organisation, sessionOf, world } from './support/world';

let connection: PgliteConnection;
let w: World;

beforeAll(async () => {
  connection = await migratedPglite();
}, STARTUP_TIMEOUT_MS);

afterAll(() => connection.close());

const WORDS = `${'abandon '.repeat(23)}art`;

/** A sign-in message for this site around a nonce the service issued, and the account's signature over it. */
async function signed(account = OWNER, over: Partial<Parameters<typeof createSiweMessage>[0]> = {}, nonce?: string) {
  const issued = nonce ?? (await call(w, getNonce, 'GET')).body.nonce;
  const message = createSiweMessage({ address: account.address, chainId: 42_161, domain: HOST, nonce: issued, uri: ORIGIN, version: '1', issuedAt: new Date(w.clock.now()), ...over });
  return { message, signature: await account.signMessage({ message }) };
}

const cookieOf = (answer: { headers: Headers }) => (answer.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

describe('signing in', () => {
  beforeAll(() => {
    w = world(connection);
  });

  it('issues a challenge that is stored and runs out', async () => {
    const { status, body } = await call(w, getNonce, 'GET');
    expect(status).toBe(200);
    expect(body).toEqual({ nonce: expect.stringMatching(/^[0-9a-f]{32}$/), expiresAt: w.clock.ms + 600_000, domain: HOST, version: '1', statement: expect.stringContaining('moves no funds') });
    expect((await call(w, getNonce, 'GET')).body.nonce).not.toBe(body.nonce);
  });

  it('opens a session for the address that signed the message, in a cookie scripts cannot read', async () => {
    const answer = await call(w, postVerify, 'POST', { body: await signed() });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ address: OWNER.address.toLowerCase(), expiresAt: Math.floor(w.clock.ms / 1000) * 1000 + SESSION_TTL_SECONDS * 1000 });

    const cookie = answer.headers.get('set-cookie') ?? '';
    expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    expect(SESSION_COOKIE.startsWith('__Host-')).toBe(true);
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', `Max-Age=${SESSION_TTL_SECONDS}`]) expect(cookie.split('; ')).toContain(attribute);
    expect(cookie).not.toContain('Domain=');
    expect(answer.text).not.toContain(cookieOf(answer).split('=')[1]);

    const me = await call(w, getMe, 'GET', { cookie: cookieOf(answer) });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ address: OWNER.address.toLowerCase(), orgs: [] });
  });

  it('takes a challenge once', async () => {
    const body = await signed();
    expect((await call(w, postVerify, 'POST', { body })).status).toBe(200);
    const again = await call(w, postVerify, 'POST', { body });
    expect(again.status).toBe(401);
    expect(again.body).toEqual({ error: 'sign_in_failed', message: 'sign-in failed: the nonce is unknown, has expired or was used before' });
    expect(again.headers.get('set-cookie')).toBeNull();
  });

  it('does not take a challenge that has run out, or one it never issued', async () => {
    const body = await signed();
    w.clock.advance(600_000);
    expect((await call(w, postVerify, 'POST', { body })).status).toBe(401);
    const invented = await signed(OWNER, {}, 'abcdef0123456789abcdef0123456789');
    expect((await call(w, postVerify, 'POST', { body: invented })).body.message).toContain('the nonce is unknown');
  });

  it('refuses a signature by anyone but the address in the message, and leaves the challenge usable', async () => {
    const real = await signed();
    const forged = { message: real.message, signature: await STRANGER.signMessage({ message: real.message }) };
    const refusal = await call(w, postVerify, 'POST', { body: forged });
    expect(refusal.status).toBe(401);
    expect(refusal.body.message).toBe('sign-in failed: the signature is not that of the address in the message');
    expect((await call(w, postVerify, 'POST', { body: real })).status).toBe(200);
  });

  it('refuses a message written for another site, one that is not valid yet or any more, and one with more in it than a sign-in', async () => {
    const cases = [
      await signed(OWNER, { domain: 'evil.example' }),
      await signed(OWNER, { uri: 'https://evil.example/login' }),
      await signed(OWNER, { expirationTime: new Date(w.clock.now() - 1_000) }),
      await signed(OWNER, { notBefore: new Date(w.clock.now() + 60_000) }),
      await signed(OWNER, { issuedAt: new Date(w.clock.now() + 3_600_000) }),
    ];
    for (const body of cases) {
      const answer = await call(w, postVerify, 'POST', { body });
      expect(answer.status).toBe(401);
      expect(answer.body.error).toBe('sign_in_failed');
    }

    const padded = await signed();
    const message = `${padded.message}\nResources:\n- https://evil.example/drain\nand then some`;
    const answer = await call(w, postVerify, 'POST', { body: { message, signature: await OWNER.signMessage({ message }) } });
    expect(answer.status).toBe(401);
    for (const text of ['hello', 'app.holdfast.test wants you to sign in']) {
      expect((await call(w, postVerify, 'POST', { body: { message: text, signature: await OWNER.signMessage({ message: text }) } })).status).toBe(401);
    }
  });

  it('refuses a request that does not come from its own pages, or is not JSON', async () => {
    const body = await signed();
    expect((await call(w, postVerify, 'POST', { body, origin: 'https://evil.example' })).body).toEqual({ error: 'bad_origin', message: 'this request did not come from the application itself' });
    expect((await call(w, postVerify, 'POST', { body, origin: null })).status).toBe(403);
    expect((await call(w, postVerify, 'POST', { body, origin: 'null' })).status).toBe(403);
    expect((await call(w, postVerify, 'POST', { rawBody: `message=${encodeURIComponent(body.message)}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status).toBe(415);
    expect((await call(w, postVerify, 'POST', { rawBody: '{"message":' })).status).toBe(400);
    for (const invalid of [{}, { message: body.message }, { ...body, signature: 'not-hex' }, { ...body, remember: true }]) {
      const answer = await call(w, postVerify, 'POST', { body: invalid });
      expect(answer.status).toBe(400);
      expect(answer.body.error).toBe('invalid_input');
    }
    // None of that used the challenge up.
    expect((await call(w, postVerify, 'POST', { body })).status).toBe(200);
  });

  it('knows nobody without a session, with a forged one, or with one that has run out', async () => {
    expect((await call(w, getMe, 'GET')).body).toEqual({ error: 'unauthenticated', message: 'sign in first' });
    expect((await call(w, getMe, 'GET', { cookie: `${SESSION_COOKIE}=not-a-token` })).status).toBe(401);

    const other = await issueSession(new TextEncoder().encode('another-deployment-secret-0123456789'), OWNER.address, w.clock.now());
    expect((await call(w, getMe, 'GET', { cookie: `${SESSION_COOKIE}=${other.token}` })).status).toBe(401);

    const cookie = await sessionOf(w);
    expect((await call(w, getMe, 'GET', { cookie })).status).toBe(200);
    w.clock.advance(SESSION_TTL_SECONDS * 1000 + 1_000);
    expect((await call(w, getMe, 'GET', { cookie })).status).toBe(401);
  });

  it('signs out by having the browser drop the cookie', async () => {
    const answer = await call(w, postLogout, 'POST');
    expect(answer.status).toBe(200);
    expect(answer.headers.get('set-cookie')).toBe(`${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`);
    expect((await call(w, postLogout, 'POST', { origin: 'https://evil.example' })).status).toBe(403);
  });
});

describe('organisations', () => {
  const input = { name: 'Acme Labs', ufvk: UFVK, birthday: 3_512_000, monthlyBurnUsd: 42_500, tempoAccount: ROOT, solanaOwner: SOLANA_OWNER };

  beforeAll(() => {
    w = world(connection);
  });

  it('are registered for the address that is signed in, with service keys of which only the addresses come back', async () => {
    const owner = newAccount();
    const answer = await call(w, postOrg, 'POST', { cookie: await sessionOf(w, owner.address), body: { ...input, ufvk: `  ${UFVK}\n` } });
    expect(answer.status).toBe(201);
    expect(answer.body).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: 'Acme Labs',
      createdAt: w.clock.ms,
      owner: owner.address.toLowerCase(),
      birthday: 3_512_000,
      scannedTo: null,
      lockEnabled: false,
      policy: DEFAULT_POLICY,
      monthlyBurnUsd: 42_500,
      publicDemo: false,
      tempoAccount: ROOT,
      solanaOwner: SOLANA_OWNER,
      serviceKeys: [
        { kind: 'hl_agent', address: expect.stringMatching(/^0x[0-9a-f]{40}$/) },
        { kind: 'tempo_access', address: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/) },
        { kind: 'solana_delegate', address: expect.stringMatching(/^De1egate/) },
      ],
    });

    const { id } = answer.body;
    expect((await w.store.loadOrg(id)).ufvk).toBe(UFVK);
    expect(answer.text).not.toContain(UFVK);
    for (const kind of ['hl_agent', 'tempo_access', 'solana_delegate'] as const) {
      const key = await w.store.activeKey(id, kind);
      expect(key?.secret.length).toBeGreaterThan(30);
      expect(answer.text).not.toContain(key?.secret);
    }
    const stored = await connection.client.query<{ secret_enc: string }>('select secret_enc from holdfast.keys where org_id = $1', [id]);
    expect(stored.rows).toHaveLength(3);
    for (const row of stored.rows) expect(row.secret_enc).toMatch(/^v1\./);
  });

  it('give each organisation keys of its own', async () => {
    const owner = newAccount();
    const cookie = await sessionOf(w, owner.address);
    const first = (await call(w, postOrg, 'POST', { cookie, body: input })).body;
    const second = (await call(w, postOrg, 'POST', { cookie, body: { ...input, name: 'Second' } })).body;
    for (const index of [0, 1, 2]) expect(first.serviceKeys[index].address).not.toBe(second.serviceKeys[index].address);

    const mine = await call(w, getOrgs, 'GET', { cookie });
    expect(mine.body.orgs.map((org: { id: string }) => org.id)).toEqual([first.id, second.id]);
    expect((await call(w, getMe, 'GET', { cookie })).body.orgs).toEqual(mine.body.orgs);
  });

  it('cannot be created, listed, read or changed without a session', async () => {
    const org = await organisation(w, newAccount().address);
    for (const answer of [
      await call(w, postOrg, 'POST', { body: input }),
      await call(w, getOrgs, 'GET'),
      await call(w, getOrg, 'GET', { params: { orgId: org.id } }),
      await call(w, patchOrg, 'PATCH', { params: { orgId: org.id }, body: { name: 'Taken over' } }),
    ]) {
      expect(answer.status).toBe(401);
      expect(answer.body).toEqual({ error: 'unauthenticated', message: 'sign in first' });
    }
    expect((await w.store.findOrg(org.id))?.name).toBe('Acme Labs');
  });

  it('answer someone who does not own them exactly as if they did not exist', async () => {
    const org = await organisation(w, newAccount().address);
    const cookie = await sessionOf(w, STRANGER.address);
    for (const [endpoint, method, body] of [
      [getOrg, 'GET', undefined],
      [patchOrg, 'PATCH', { name: 'Taken over' }],
      [patchOrg, 'PATCH', { nonsense: true }],
    ] as const) {
      const theirs = await call(w, endpoint, method, { cookie, params: { orgId: org.id }, body });
      const nobodys = await call(w, endpoint, method, { cookie, params: { orgId: 'no-such-organisation' }, body });
      expect(theirs.status).toBe(404);
      expect(theirs.text).toBe(nobodys.text);
      expect(theirs.body).toEqual({ error: 'not_found', message: 'not found' });
    }
    expect((await call(w, getOrgs, 'GET', { cookie })).body.orgs).toEqual([]);
    expect((await w.store.findOrg(org.id))?.name).toBe('Acme Labs');
    expect((await call(w, getOrg, 'GET', { cookie, params: { orgId: '../etc/passwd' } })).status).toBe(404);
  });

  it('belong to their owner whatever case the address was stored in', async () => {
    const owner = newAccount();
    await w.store.createOrg({ id: 'stored-with-checksum', name: 'Older Row', ufvk: UFVK, birthday: 3_512_000, hlUser: getAddress(owner.address), policy: DEFAULT_POLICY, lockEnabled: false });
    const answer = await call(w, getOrg, 'GET', { cookie: await sessionOf(w, owner.address), params: { orgId: 'stored-with-checksum' } });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ id: 'stored-with-checksum', serviceKeys: [] });
  });

  it('are refused a key that is not a viewing key of this network, without the key being repeated', async () => {
    const cookie = await sessionOf(w);
    const testnetKey = testDeriveKeys(WORDS, 0, 'testnet').ufvk;
    const cases: [string, string][] = [
      [WORDS, 'the viewing key was not accepted: this looks like a spending key or a seed phrase — never paste those here'],
      ['secret-extended-key-main1qqqqqqqq', 'the viewing key was not accepted: this looks like a spending key or a seed phrase — never paste those here'],
      [testnetKey, 'the viewing key was not accepted: this is a testnet viewing key'],
      [`${UFVK.slice(0, -6)}qqqqqq`, expect.stringContaining('the viewing key was not accepted: the key does not decode') as unknown as string],
    ];
    for (const [ufvk, message] of cases) {
      const answer = await call(w, postOrg, 'POST', { cookie, body: { ...input, ufvk } });
      expect(answer.status).toBe(400);
      expect(answer.body.message).toEqual(message);
      expect(answer.text).not.toContain(ufvk);
    }
    expect((await call(w, getOrgs, 'GET', { cookie })).body.orgs).toEqual([]);
  });

  it('are refused input that is not what was asked for, and say where it is wrong', async () => {
    const cookie = await sessionOf(w);
    const cases: [Record<string, unknown>, string][] = [
      [{ ...input, name: '   ' }, 'body.name'],
      [{ ...input, birthday: 3_512_000.5 }, 'body.birthday'],
      [{ ...input, birthday: '3512000' }, 'body.birthday'],
      [{ ...input, monthlyBurnUsd: -1 }, 'body.monthlyBurnUsd'],
      [{ ...input, publicDemo: true }, 'body'],
      [{ ...input, owner: STRANGER.address }, 'body'],
    ];
    for (const [body, where] of cases) {
      const answer = await call(w, postOrg, 'POST', { cookie, body });
      expect(answer.status).toBe(400);
      expect(answer.body.error).toBe('invalid_input');
      expect(answer.body.problems.some((problem: string) => problem.startsWith(`${where}:`) || problem.startsWith(`${where}.`))).toBe(true);
      expect(answer.text).not.toContain(UFVK);
    }
    expect((await call(w, postOrg, 'POST', { cookie, body: { ...input, birthday: 400_000 } })).body.message).toBe('the birthday height is before block 419200, where shielded funds first became possible');
    expect((await call(w, postOrg, 'POST', { cookie, body: { ...input, tempoAccount: '0x1234' } })).body.message).toBe('tempoAccount is not an account address');
    expect((await call(w, postOrg, 'POST', { cookie, body: { ...input, solanaOwner: 'not-base58-0OIl' } })).body.message).toBe('solanaOwner is not a Solana address');
    expect((await call(w, postOrg, 'POST', { cookie, body: input, origin: 'https://evil.example' })).status).toBe(403);
    expect((await call(w, getOrgs, 'GET', { cookie })).body.orgs).toEqual([]);
  });

  it('are not half-made when a key cannot be made or the database cannot be written', async () => {
    const owner = newAccount();
    const cookie = await sessionOf(w, owner.address);
    const newDelegateKey = w.solana.newDelegateKey.bind(w.solana);
    w.solana.newDelegateKey = async () => {
      throw new Error(`could not derive a key for ${UFVK}`);
    };
    const failed = await call(w, postOrg, 'POST', { cookie, body: input });
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: 'internal', message: 'the server could not complete the request' });
    expect(w.reported.join('\n')).toContain('could not derive a key for [viewing key]');
    expect(w.reported.join('\n')).not.toContain(UFVK);
    w.solana.newDelegateKey = newDelegateKey;

    const createOrg = w.store.createOrg.bind(w.store);
    w.store.createOrg = async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:6543'), { code: 'ECONNREFUSED' });
    };
    const down = await call(w, postOrg, 'POST', { cookie, body: input });
    expect(down.status).toBe(503);
    expect(down.body).toEqual({ error: 'unavailable', message: 'the database is unavailable', source: 'database' });
    w.store.createOrg = createOrg;

    expect(await w.store.listOrgs({ owner: owner.address })).toEqual([]);
    expect((await call(w, postOrg, 'POST', { cookie, body: input })).status).toBe(201);
  });

  it('let their owner change the profile and nothing else', async () => {
    const owner = newAccount();
    const cookie = await sessionOf(w, owner.address);
    const org = await organisation(w, owner.address);
    const params = { orgId: org.id };

    const renamed = await call(w, patchOrg, 'PATCH', { cookie, params, body: { name: 'Acme Research', monthlyBurnUsd: 51_000 } });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: 'Acme Research', monthlyBurnUsd: 51_000, tempoAccount: ROOT, solanaOwner: SOLANA_OWNER, owner: owner.address.toLowerCase() });

    const cleared = await call(w, patchOrg, 'PATCH', { cookie, params, body: { monthlyBurnUsd: null, solanaOwner: null, tempoAccount: ROOT.toLowerCase() } });
    expect(cleared.body).toMatchObject({ name: 'Acme Research', monthlyBurnUsd: null, solanaOwner: null, tempoAccount: ROOT });
    expect((await call(w, patchOrg, 'PATCH', { cookie, params, body: {} })).body).toEqual(cleared.body);
    expect((await call(w, getOrg, 'GET', { cookie, params })).body).toEqual(cleared.body);

    for (const body of [{ publicDemo: true }, { owner: STRANGER.address }, { lockEnabled: true }, { ufvk: UFVK }, { tempoAccount: '0xnope' }]) {
      expect((await call(w, patchOrg, 'PATCH', { cookie, params, body })).status).toBe(400);
    }
    expect(await w.store.findOrg(org.id)).toMatchObject({ publicDemo: false, lockEnabled: false, hlUser: owner.address.toLowerCase() });
  });
});
