import {
  TOKENS,
  type AccessKeyPolicyInput,
  buildAccessKeyAuthorization,
  buildRevocation,
  buildRevoke,
  generateAccessKey,
  readSignedAuthorization,
  revocationSignPayload,
  verifySignedAuthorization,
  verifySignedRevocation,
} from '@holdfast/tempo';
import { KeyAuthorization, SignatureEnvelope } from 'ox/tempo';
import { type Address, type Hex, getAddress, keccak256 } from 'viem';
import { Account, P256, Transaction } from 'viem/tempo';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TempoAuthorizationRequest, type TempoRevokeRequest, type TempoTermsInput, createApi } from '../../src/client/api';
import { ClientError } from '../../src/client/errors';
import { tempoAccountState } from '../../src/client/stores';
import {
  type StoredPasskey,
  type TempoGrant,
  authorizeTempoAccessKey,
  buildAuthorization,
  checkedRevokeFields,
  createPasskey,
  createTempoAccount,
  forgetPasskey,
  linkTempoAccount,
  passkeysSupported,
  pendingPasskey,
  recoverPasskey,
  revokeTempoAccessKey,
  signTempoAuthorization,
  signTempoRevoke,
  storedPasskey,
  tempoGrant,
  tempoRoot,
} from '../../src/client/tempo';
import { wireShape } from '../../src/server/json';
import { fakeWindow, softwareAuthenticator } from './support/wallets';

const ORIGIN = 'https://app.holdfast.test';
const RP_ID = 'app.holdfast.test';
const CHAIN_ID = 42_431;
const TOKEN = getAddress(TOKENS.moderato.AlphaUSD);
const PAYEES: Address[] = ['0x70997970C51812dc3A010C7d01b50e0d17dc79C8', '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'];
const EXPIRY = 1_791_726_400;
const ORG = '7b0e7a52-8b65-4f0e-9d3a-2f1c4c1f9a10';
const accessKey = generateAccessKey();

const TERMS: TempoTermsInput = { limit: 10_000_000n, periodSeconds: 3_600, expiry: EXPIRY, recipients: PAYEES };
/** What the rail shows the treasurer: the service's key, the payout token and the chain. */
const GRANT: TempoGrant = { accessKey: accessKey.address, token: TOKEN, chainId: CHAIN_ID };

const expectedFor = (root: Address, terms: TempoTermsInput = TERMS, over: Partial<AccessKeyPolicyInput> = {}): AccessKeyPolicyInput => ({
  rootAddress: root,
  accessKeyAddress: accessKey.address,
  token: TOKEN,
  limit: terms.limit,
  periodSeconds: terms.periodSeconds,
  expiry: terms.expiry,
  chainId: CHAIN_ID,
  ...(terms.recipients === undefined || terms.recipients.length === 0 ? {} : { recipients: terms.recipients as Address[] }),
  ...over,
});

/** What `POST …/rails/tempo/authorization` answers with, as it arrives: built by the server's own package and put through its JSON. */
function serverRequest(expected: AccessKeyPolicyInput): TempoAuthorizationRequest {
  const request = buildAccessKeyAuthorization(expected);
  return wireShape({ expected, signPayload: request.signPayload, key: request.key, policy: request.policy, authorization: request.authorization }) as TempoAuthorizationRequest;
}

/** The decision the server makes before it submits anything. */
const check = (wire: Hex, expected: AccessKeyPolicyInput) => verifySignedAuthorization({ wire, expected, account: expected.rootAddress, accessKey: accessKey.address, token: TOKEN, chainId: CHAIN_ID });

async function failure(promise: Promise<unknown>): Promise<ClientError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ClientError) return error;
    throw error;
  }
  throw new Error('expected a failure');
}

describe('signing the access-key authorization', () => {
  it('produces, with a passkey root, exactly what the server’s verification accepts', async () => {
    // viem's software passkey: real WebAuthn assertions, no browser.
    const root = Account.fromHeadlessWebAuthn(P256.randomPrivateKey(), { rpId: RP_ID, origin: ORIGIN });
    const expected = expectedFor(root.address);
    const request = serverRequest(expected);

    const wire = await signTempoAuthorization(root, request, GRANT, TERMS);
    const verdict = check(wire, expected);
    expect(verdict).toMatchObject({ ok: true });

    const signed = readSignedAuthorization(wire);
    // A passkey does not sign with a bare signature: the envelope carries the assertion and the public key.
    expect(signed.signed.signature.type).toBe('webAuthn');
    expect(KeyAuthorization.getSignPayload(signed.signed)).toBe(request.signPayload);
    expect(SignatureEnvelope.verify(signed.signed.signature, { address: root.address, payload: request.signPayload as Hex })).toBe(true);
    expect({ accessKey: signed.accessKey, chainId: signed.chainId, expiry: signed.expiry, limits: signed.limits }).toEqual({
      accessKey: accessKey.address,
      chainId: CHAIN_ID,
      expiry: EXPIRY,
      limits: [{ token: TOKEN, limit: 10_000_000n, period: 3_600 }],
    });
    // It is the serialization viem itself gives a key authorization signed by the same root.
    expect(readSignedAuthorization(KeyAuthorization.serialize(await root.signKeyAuthorization({ address: accessKey.address, type: 'p256' }, buildAccessKeyAuthorization(expected).policy))).signed).toMatchObject({
      address: signed.signed.address,
      chainId: signed.signed.chainId,
      expiry: signed.signed.expiry,
      limits: signed.signed.limits,
      scopes: signed.signed.scopes,
    });
  });

  it('does so for every shape of terms: any recipient, a one-off limit, a single payee', async () => {
    const root = Account.fromHeadlessWebAuthn(P256.randomPrivateKey(), { rpId: RP_ID, origin: ORIGIN });
    const shapes: TempoTermsInput[] = [
      { limit: 1n, periodSeconds: 0, expiry: EXPIRY },
      { limit: 2_500_000_000n, periodSeconds: 30 * 86_400, expiry: EXPIRY, recipients: [] },
      { limit: 10_000_000n, periodSeconds: 3_600, expiry: EXPIRY, recipients: [PAYEES[0] as Address] },
      // Addresses the treasurer typed in lower case are the same payees.
      { limit: 10_000_000n, periodSeconds: 3_600, expiry: EXPIRY, recipients: PAYEES.map((payee) => payee.toLowerCase()) },
    ];
    for (const terms of shapes) {
      const expected = expectedFor(root.address, terms);
      const wire = await signTempoAuthorization(root, serverRequest(expected), GRANT, terms);
      expect(check(wire, expected), JSON.stringify(wireShape(terms))).toMatchObject({ ok: true });
    }
  });

  it('works the same for an account whose root is an ordinary key', async () => {
    const root = Account.fromSecp256k1('0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318');
    const expected = expectedFor(root.address);
    const wire = await signTempoAuthorization(root, serverRequest(expected), GRANT, TERMS);
    expect(check(wire, expected)).toMatchObject({ ok: true });
    expect(readSignedAuthorization(wire).signed.signature.type).toBe('secp256k1');
  });

  it('signs nothing but the authorization of this key, token and chain on these terms, whatever the server asks for', async () => {
    const root = Account.fromHeadlessWebAuthn(P256.randomPrivateKey(), { rpId: RP_ID, origin: ORIGIN });
    const sign = vi.fn(root.sign);
    const digestOf = (authorization: Parameters<typeof KeyAuthorization.getSignPayload>[0]) => ({ signPayload: KeyAuthorization.getSignPayload(authorization) });
    const base = { address: accessKey.address, type: 'p256', expiry: EXPIRY, limits: [{ token: TOKEN, limit: 10_000_000n, period: 3_600 }], scopes: [{ address: TOKEN, selector: 'transferWithMemo(address,uint256,bytes32)', recipients: PAYEES }] } as const;

    // Each of these is an answer whose every field agrees with its digest. Only what was asked for here tells them from the honest one.
    const dishonest: [string, { signPayload: Hex }][] = [
      ['a larger limit', serverRequest(expectedFor(root.address, { ...TERMS, limit: 999_000_000n }))],
      ['a later expiry', serverRequest(expectedFor(root.address, { ...TERMS, expiry: EXPIRY + 365 * 86_400 }))],
      ['no list of recipients', serverRequest(expectedFor(root.address, { ...TERMS, recipients: [] }))],
      ['another recipient', serverRequest(expectedFor(root.address, { ...TERMS, recipients: [PAYEES[0] as Address, '0x90F79bf6EB2c4f870365E785982E1f101E93b906'] }))],
      ['a longer period', serverRequest(expectedFor(root.address, { ...TERMS, periodSeconds: 60 }))],
      ['another key, such as one the service does not hold', serverRequest(expectedFor(root.address, TERMS, { accessKeyAddress: generateAccessKey().address }))],
      ['another token', serverRequest(expectedFor(root.address, TERMS, { token: getAddress(TOKENS.moderato.BetaUSD) }))],
      ['another chain', serverRequest(expectedFor(root.address, TERMS, { chainId: 4_217 }))],
      ['every chain at once', digestOf(KeyAuthorization.from({ ...base, chainId: 0n }))],
      ['a key of another kind', digestOf(KeyAuthorization.from({ ...base, type: 'secp256k1', chainId: BigInt(CHAIN_ID) }))],
      ['an admin key, which is bounded by nothing', digestOf(KeyAuthorization.from({ address: accessKey.address, type: 'p256', chainId: BigInt(CHAIN_ID), isAdmin: true }))],
      ['the same terms on any function of the token', digestOf(KeyAuthorization.from({ ...base, chainId: BigInt(CHAIN_ID), scopes: [{ address: TOKEN }] }))],
      ['a digest of nothing in particular', { signPayload: `0x${'11'.repeat(32)}` }],
      ['no digest at all', { signPayload: undefined as unknown as Hex }],
    ];
    for (const [what, request] of dishonest) {
      const error = await failure(signTempoAuthorization({ address: root.address, sign }, request, GRANT, TERMS));
      expect(error.code, what).toBe('unexpected_request');
    }
    expect(sign).not.toHaveBeenCalled();

    // The honest answer is signed, and only its digest was ever looked at.
    const honest = serverRequest(expectedFor(root.address));
    await expect(signTempoAuthorization({ address: root.address, sign }, { signPayload: honest.signPayload }, GRANT, TERMS)).resolves.toMatch(/^0x/);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('does not hand on a signature that is not the root’s', async () => {
    const root = Account.fromHeadlessWebAuthn(P256.randomPrivateKey(), { rpId: RP_ID, origin: ORIGIN });
    const impostor = Account.fromHeadlessWebAuthn(P256.randomPrivateKey(), { rpId: RP_ID, origin: ORIGIN });
    const request = serverRequest(expectedFor(root.address));
    // The account is known under one public key and the authenticator answers with another.
    const mixedUp = await failure(signTempoAuthorization({ address: root.address, sign: impostor.sign }, request, GRANT, TERMS));
    expect({ code: mixedUp.code, message: mixedUp.message }).toEqual({ code: 'wallet_failed', message: `the signature is not that of the root key of ${root.address}` });

    const garbage = await failure(signTempoAuthorization({ address: root.address, sign: async () => '0x1234' }, request, GRANT, TERMS));
    expect(garbage.code).toBe('wallet_failed');

    const declined = await failure(
      signTempoAuthorization(
        {
          address: root.address,
          sign: async () => {
            throw new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError');
          },
        },
        request,
        GRANT,
        TERMS,
      ),
    );
    expect(declined.code).toBe('wallet_rejected');
  });

  it('builds the authorization the server’s package builds for the same terms, and none for all chains or for nothing', () => {
    const root = Account.fromHeadlessWebAuthn(P256.randomPrivateKey(), { rpId: RP_ID, origin: ORIGIN });
    for (const terms of [TERMS, { limit: 5n, periodSeconds: 0, expiry: EXPIRY }]) {
      const theirs = buildAccessKeyAuthorization(expectedFor(root.address, terms));
      const ours = buildAuthorization(GRANT, terms);
      expect(ours).toEqual(theirs.authorization);
      expect(KeyAuthorization.getSignPayload(ours)).toBe(theirs.signPayload);
    }
    const refused = (run: () => unknown): string => {
      try {
        run();
      } catch (error) {
        if (error instanceof ClientError) return error.code;
        throw error;
      }
      return 'built';
    };
    // Chain id 0 would make the authorization valid on every chain.
    for (const chainId of [0, -1, 1.5, Number.NaN, '42431' as unknown as number]) expect(refused(() => buildAuthorization({ ...GRANT, chainId }, TERMS)), String(chainId)).toBe('invalid_argument');
    expect(refused(() => buildAuthorization({ ...GRANT, accessKey: 'the-key' }, TERMS))).toBe('invalid_argument');
    expect(refused(() => buildAuthorization({ ...GRANT, token: 'USDC' }, TERMS))).toBe('invalid_argument');
    expect(refused(() => buildAuthorization(GRANT, { ...TERMS, recipients: ['0x1234'] }))).toBe('invalid_argument');
    expect(refused(() => buildAuthorization(GRANT, { ...TERMS, limit: 0n }))).toBe('invalid_argument');
    expect(refused(() => buildAuthorization(GRANT, { ...TERMS, expiry: 0 }))).toBe('invalid_argument');
    expect(refused(() => buildAuthorization(GRANT, { ...TERMS, periodSeconds: -1 }))).toBe('invalid_argument');
  });

  /** The server as the flow meets it: the organisation, its rail, what to sign, and the submission. */
  function server(root: Address, over: { org?: Record<string, unknown>; rail?: Record<string, unknown>; request?: (honest: TempoAuthorizationRequest) => unknown } = {}) {
    const seen: { method: string; url: string; body: Record<string, unknown> | undefined }[] = [];
    const api = createApi({
      fetch: async (input, init) => {
        const url = String(input);
        const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>);
        seen.push({ method: init?.method ?? 'GET', url, body });
        if (url === `/api/orgs/${ORG}`) return Response.json({ id: ORG, tempoAccount: root, serviceKeys: [{ kind: 'hl_agent', address: PAYEES[1] }, { kind: 'tempo_access', address: accessKey.address }], ...over.org });
        if (url.endsWith('/rails/tempo')) return Response.json({ network: 'moderato', chainId: CHAIN_ID, token: { address: TOKEN, symbol: 'AlphaUSD', decimals: 6 }, account: root, accessKey: accessKey.address, key: { status: 'unavailable', source: 'tempo', readAt: 1, reason: 'not asked' }, ...over.rail });
        if (url.endsWith('/authorization')) {
          const honest = serverRequest(expectedFor(root));
          return Response.json(over.request === undefined ? honest : over.request(honest));
        }
        return Response.json({ authorized: true, tx: `0x${'cd'.repeat(32)}`, txUrl: 'https://explore.testnet.tempo.xyz/tx/0xcd', sent: true });
      },
    });
    return { api, seen };
  }

  it('reads the rail, asks the server what to sign, signs it and submits the signed authorization with the terms', async () => {
    const root = Account.fromHeadlessWebAuthn(P256.randomPrivateKey(), { rpId: RP_ID, origin: ORIGIN });
    const { api, seen } = server(root.address);
    expect(await tempoGrant(root.address, ORG, { api })).toEqual(GRANT);
    seen.length = 0;

    const result = await authorizeTempoAccessKey(root, ORG, TERMS, { api });
    expect(result).toEqual({ authorized: true, tx: `0x${'cd'.repeat(32)}`, txUrl: 'https://explore.testnet.tempo.xyz/tx/0xcd', sent: true });
    const wireTerms = { limit: '10000000', periodSeconds: 3_600, expiry: EXPIRY, recipients: PAYEES };
    expect(seen.map((call) => `${call.method} ${call.url}`).sort()).toEqual(
      [`GET /api/orgs/${ORG}`, `GET /api/orgs/${ORG}/rails/tempo`, `POST /api/orgs/${ORG}/rails/tempo/authorization`, `POST /api/orgs/${ORG}/rails/tempo/authorization/submit`].sort(),
    );
    const [asked, submitted] = seen.filter((call) => call.method === 'POST');
    expect(asked?.body).toEqual(wireTerms);
    expect(submitted?.body).toEqual({ terms: wireTerms, signedWire: expect.stringMatching(/^0x[0-9a-f]+$/) });
    expect(check(submitted?.body?.signedWire as Hex, expectedFor(root.address))).toMatchObject({ ok: true });
    // Within what the endpoint takes for a signed authorization.
    expect((submitted?.body?.signedWire as Hex).length).toBeLessThan(8_000);
  });

  it('signs for no key, token or chain but the ones the rail shows, and for no account but the organisation’s', async () => {
    const root = Account.fromHeadlessWebAuthn(P256.randomPrivateKey(), { rpId: RP_ID, origin: ORIGIN });
    const sign = vi.fn(root.sign);
    const signer = { address: root.address, sign };
    const attacker = generateAccessKey().address;
    const submitted = (seen: { url: string }[]) => seen.some((call) => call.url.endsWith('/submit'));

    // An answer for another key, token or chain than the rail shows, consistent in itself: the digest is not the one built here.
    for (const over of [{ accessKeyAddress: attacker }, { token: getAddress(TOKENS.moderato.BetaUSD) }, { chainId: 4_217 }] satisfies Partial<AccessKeyPolicyInput>[]) {
      const lying = server(root.address, { request: () => serverRequest(expectedFor(root.address, TERMS, over)) });
      expect((await failure(authorizeTempoAccessKey(signer, ORG, TERMS, { api: lying.api }))).code).toBe('unexpected_request');
      expect(submitted(lying.seen)).toBe(false);
    }

    // A rail that names a key which is not the organisation's own access key.
    const otherKey = server(root.address, { rail: { accessKey: attacker }, request: () => serverRequest(expectedFor(root.address, TERMS, { accessKeyAddress: attacker })) });
    const refused = await failure(authorizeTempoAccessKey(signer, ORG, TERMS, { api: otherKey.api }));
    expect({ code: refused.code, message: refused.message }).toEqual({ code: 'unexpected_request', message: 'the key the rail names is not the access key of this organisation; nothing was signed' });
    expect(otherKey.seen.some((call) => call.method === 'POST')).toBe(false);

    // A rail on no chain in particular.
    const everywhere = server(root.address, { rail: { chainId: 0 } });
    expect((await failure(authorizeTempoAccessKey(signer, ORG, TERMS, { api: everywhere.api }))).code).toBe('invalid_argument');

    // An organisation whose Tempo account is another, or that has none, or no access key.
    const elsewhere = server(root.address, { org: { tempoAccount: PAYEES[0] } });
    expect((await failure(authorizeTempoAccessKey(signer, ORG, TERMS, { api: elsewhere.api }))).code).toBe('wrong_account');
    const railElsewhere = server(root.address, { rail: { account: PAYEES[0] } });
    expect((await failure(authorizeTempoAccessKey(signer, ORG, TERMS, { api: railElsewhere.api }))).code).toBe('wrong_account');
    const none = server(root.address, { org: { tempoAccount: null }, rail: { account: null } });
    expect((await failure(authorizeTempoAccessKey(signer, ORG, TERMS, { api: none.api }))).code).toBe('wrong_account');
    const keyless = server(root.address, { org: { serviceKeys: [] }, rail: { accessKey: null } });
    expect((await failure(authorizeTempoAccessKey(signer, ORG, TERMS, { api: keyless.api }))).code).toBe('nothing_to_sign');

    expect(sign).not.toHaveBeenCalled();
  });
});

describe('the passkey of a Tempo account', () => {
  let page: ReturnType<typeof fakeWindow>;

  beforeEach(() => {
    page = fakeWindow(ORIGIN);
    vi.stubGlobal('window', page);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('is created for this site’s host, kept by credential id and public key, and gives the account its address', async () => {
    const authenticator = softwareAuthenticator(ORIGIN);
    const passkey = await createPasskey({ label: 'Acme Labs payroll', createFn: authenticator.createFn });

    expect(authenticator.created).toEqual([{ rpId: RP_ID, userName: 'Acme Labs payroll', userId: expect.stringMatching(/^[0-9a-f]{64}$/), residentKey: 'required', userVerification: 'required' }]);
    expect(passkey.credentialId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(passkey.publicKey).toMatch(/^0x[0-9a-f]{128}$/);
    // The address is the one viem derives from the public key, and nothing else is needed to know it again.
    expect(passkey.address).toBe(Account.fromWebAuthnP256({ id: passkey.credentialId, publicKey: passkey.publicKey }).address);
    expect(JSON.parse(page.localStorage.getItem(`holdfast.tempo.passkey.${passkey.address.toLowerCase()}`) ?? 'null')).toEqual(passkey);
    expect(storedPasskey(passkey.address)).toEqual(passkey);
    expect(storedPasskey(passkey.address.toLowerCase())).toEqual(passkey);
    expect(page.localStorage.length).toBe(1);
  });

  it('is restored from what was stored and signs an authorization the server accepts', async () => {
    const authenticator = softwareAuthenticator(ORIGIN);
    const created = await createPasskey({ label: 'Acme Labs payroll', createFn: authenticator.createFn });

    // Later: a new page of the same site, with only `localStorage` to go by.
    const stored = storedPasskey(created.address);
    if (stored === null) throw new Error('the passkey was not stored');
    const root = tempoRoot(stored, { getFn: authenticator.getFn });
    expect(root.address).toBe(created.address);
    expect(root.keyType).toBe('webAuthn');
    expect(authenticator.asserted).toEqual([]);

    const expected = expectedFor(root.address);
    const request = serverRequest(expected);
    const wire = await signTempoAuthorization(root, request, GRANT, TERMS);

    // One prompt, for this credential, on this site, over the digest the server asked for.
    expect(authenticator.asserted).toHaveLength(1);
    expect(authenticator.asserted[0]).toMatchObject({ rpId: RP_ID, credentialId: created.credentialId });
    expect(`0x${Buffer.from(authenticator.asserted[0]?.challenge ?? []).toString('hex')}`).toBe(request.signPayload);

    expect(check(wire, expected)).toMatchObject({ ok: true });
    const { signature } = readSignedAuthorization(wire).signed;
    if (signature.type !== 'webAuthn') throw new Error('expected a WebAuthn signature');
    expect(JSON.parse(signature.metadata.clientDataJSON)).toMatchObject({ type: 'webauthn.get', origin: ORIGIN });
    // The same wire is refused for any other account, and for terms it was not signed for.
    expect(check(wire, { ...expected, rootAddress: PAYEES[0] as Address })).toMatchObject({ ok: false });
    expect(check(wire, { ...expected, limit: 999_000_000n })).toMatchObject({ ok: false });
  });

  it('does not replace the passkey of another account, even one made under the same label', async () => {
    const authenticator = softwareAuthenticator(ORIGIN);
    // A label as long as an organisation's name may be: the user id is not made from it.
    const label = `${'Acme Laboratories of Greater Springfield '.repeat(3)}payroll`;
    const first = await createPasskey({ label, createFn: authenticator.createFn });
    const second = await createPasskey({ label, createFn: authenticator.createFn });

    expect(second.address).not.toBe(first.address);
    expect(new Set(authenticator.created.map((creation) => creation.userId)).size).toBe(2);
    // An authenticator keeps one passkey for each user id of a site. Both are still there, and both still sign.
    expect(authenticator.held()).toEqual([first.credentialId, second.credentialId]);
    for (const passkey of [first, second]) {
      const root = tempoRoot(passkey, { getFn: authenticator.getFn });
      const expected = expectedFor(root.address);
      expect(check(await signTempoAuthorization(root, serverRequest(expected), GRANT, TERMS), expected)).toMatchObject({ ok: true });
    }
  });

  it('is found again from a signature when the browser no longer holds its public key', async () => {
    const authenticator = softwareAuthenticator(ORIGIN);
    const created = await createPasskey({ label: 'Acme Labs payroll', createFn: authenticator.createFn });
    const other = await createPasskey({ label: 'Another organisation', createFn: authenticator.createFn });

    // Another browser, or this one after its storage was cleared: the account is known only by its address.
    page.localStorage.clear();
    expect(storedPasskey(created.address)).toBeNull();

    // The treasurer picks the wrong passkey first: it is another account's, and nothing is kept of it.
    authenticator.pick = other.credentialId;
    const wrong = await failure(recoverPasskey(created.address, { getFn: authenticator.getFn }));
    expect({ code: wrong.code, message: wrong.message }).toEqual({ code: 'wrong_account', message: `the passkey that answered is not the root of ${created.address}` });
    expect(page.localStorage.length).toBe(0);

    authenticator.pick = created.credentialId;
    const recovered = await recoverPasskey(created.address.toLowerCase(), { getFn: authenticator.getFn });
    expect(recovered).toEqual(created);
    expect(storedPasskey(created.address)).toEqual(created);
    // No credential was named in either prompt: the authenticator offered what it holds for this site.
    expect(authenticator.asserted.map((assertion) => [assertion.rpId, assertion.credentialId])).toEqual([[RP_ID, undefined], [RP_ID, undefined]]);

    // And the account signs again, with a signature the server accepts.
    const root = tempoRoot(recovered, { getFn: authenticator.getFn });
    const expected = expectedFor(root.address);
    expect(check(await signTempoAuthorization(root, serverRequest(expected), GRANT, TERMS), expected)).toMatchObject({ ok: true });

    authenticator.declineNext = true;
    expect((await failure(recoverPasskey(created.address, { getFn: authenticator.getFn }))).code).toBe('wallet_rejected');
  });

  it('is found again whichever of the two keys a signature could come from is the right one', async () => {
    const authenticator = softwareAuthenticator(ORIGIN);
    // Enough passkeys and signatures that both parities of the recovered key occur.
    for (let i = 0; i < 6; i += 1) {
      const created = await createPasskey({ label: `Account ${i}`, createFn: authenticator.createFn });
      page.localStorage.clear();
      authenticator.pick = created.credentialId;
      expect(await recoverPasskey(created.address, { getFn: authenticator.getFn })).toEqual(created);
      expect(await recoverPasskey(created.address, { getFn: authenticator.getFn })).toEqual(created);
    }
  });

  it('cannot be used from another host: the authenticator answers only for the site it was made on', async () => {
    const authenticator = softwareAuthenticator(ORIGIN);
    const created = await createPasskey({ label: 'Acme Labs payroll', createFn: authenticator.createFn });
    const elsewhere = fakeWindow('https://holdfast-preview.example');
    elsewhere.localStorage.setItem(`holdfast.tempo.passkey.${created.address.toLowerCase()}`, JSON.stringify(created));
    vi.stubGlobal('window', elsewhere);

    const root = tempoRoot(created, { getFn: authenticator.getFn });
    const error = await failure(signTempoAuthorization(root, serverRequest(expectedFor(root.address)), GRANT, TERMS));
    expect(error.code).toBe('wallet_rejected');
    expect(authenticator.asserted[0]?.rpId).toBe('holdfast-preview.example');
  });

  it('reports a prompt the treasurer dismissed, and stores nothing then', async () => {
    const authenticator = softwareAuthenticator(ORIGIN);
    authenticator.declineNext = true;
    const error = await failure(createPasskey({ label: 'Acme Labs payroll', createFn: authenticator.createFn }));
    expect({ code: error.code, message: error.message }).toEqual({ code: 'wallet_rejected', message: 'creating the passkey was declined in the wallet' });
    expect(page.localStorage.length).toBe(0);
  });

  it('makes no passkey whose public key the browser could not keep', async () => {
    const authenticator = softwareAuthenticator(ORIGIN);
    // Storage that is there and takes nothing, as a browser has it in some private modes.
    const full = fakeWindow(ORIGIN);
    full.localStorage.setItem = () => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    };
    vi.stubGlobal('window', full);
    const refused = await failure(createPasskey({ label: 'Acme Labs payroll', createFn: authenticator.createFn }));
    expect(refused.code).toBe('wallet_unavailable');
    // The authenticator was never asked: there is no passkey whose public key is lost.
    expect(authenticator.created).toEqual([]);
    expect((await failure(recoverPasskey(PAYEES[0] as Address, { getFn: authenticator.getFn }))).code).toBe('wallet_unavailable');
    expect(authenticator.asserted).toEqual([]);

    // Storage that gives out between the check and the write: the passkey exists, and what is known of it travels with the error.
    const failing = fakeWindow(ORIGIN);
    const write = failing.localStorage.setItem.bind(failing.localStorage);
    failing.localStorage.setItem = (key, value) => {
      if (key.startsWith('holdfast.tempo.passkey.')) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      write(key, value);
    };
    vi.stubGlobal('window', failing);
    const lost = await failure(createPasskey({ label: 'Acme Labs payroll', createFn: authenticator.createFn }));
    expect({ code: lost.code, message: lost.message }).toEqual({ code: 'wallet_failed', message: 'the passkey exists, but its public key could not be kept in this browser' });
    const { passkey } = lost.details as { passkey: StoredPasskey };
    expect(passkey.address).toBe(Account.fromWebAuthnP256({ id: passkey.credentialId, publicKey: passkey.publicKey }).address);
    expect(authenticator.held()).toEqual([passkey.credentialId]);
  });

  it('believes nothing in storage that is not a passkey of the account asked for', async () => {
    const authenticator = softwareAuthenticator(ORIGIN);
    const one = await createPasskey({ label: 'one', createFn: authenticator.createFn });
    const two = await createPasskey({ label: 'two', createFn: authenticator.createFn });
    const key = `holdfast.tempo.passkey.${one.address.toLowerCase()}`;

    for (const text of ['', 'not json', '{}', JSON.stringify({ ...one, publicKey: '0x1234' }), JSON.stringify({ ...one, credentialId: '' }), JSON.stringify({ ...one, publicKey: two.publicKey }), JSON.stringify({ ...one, address: two.address })]) {
      page.localStorage.setItem(key, text);
      expect(storedPasskey(one.address), text).toBeNull();
    }
    expect(storedPasskey(two.address)).toEqual(two);
    forgetPasskey(two.address);
    expect(storedPasskey(two.address)).toBeNull();
    expect(storedPasskey('0x0000000000000000000000000000000000000001')).toBeNull();
  });

  it('is recorded in the organisation’s profile, and is not lost when recording fails', async () => {
    const authenticator = softwareAuthenticator(ORIGIN);
    const patches: unknown[] = [];
    let down = true;
    const api = createApi({
      fetch: async (input, init) => {
        patches.push({ method: init?.method, url: String(input), body: JSON.parse(String(init?.body)) });
        if (down) return Response.json({ error: 'unavailable', message: 'the database is unavailable', source: 'database' }, { status: 503 });
        return Response.json({ id: ORG, name: 'Acme Labs', tempoAccount: (JSON.parse(String(init?.body)) as { tempoAccount: string }).tempoAccount });
      },
    });

    expect(tempoAccountState({ id: ORG, tempoAccount: null })).toEqual({ status: 'none', address: null, passkey: null });
    const error = await failure(createTempoAccount(ORG, { label: 'Acme Labs payroll', createFn: authenticator.createFn, api }));
    expect({ status: error.status, code: error.code }).toEqual({ status: 503, code: 'unavailable' });

    // The passkey exists and is known here; only the profile does not name it yet.
    const pending = pendingPasskey(ORG) as StoredPasskey;
    expect(pending).toEqual(storedPasskey(pending.address));
    expect(tempoAccountState({ id: ORG, tempoAccount: null })).toEqual({ status: 'pending', address: pending.address, passkey: pending });
    expect(patches).toEqual([{ method: 'PATCH', url: `/api/orgs/${ORG}`, body: { tempoAccount: pending.address } }]);
    expect(authenticator.created).toHaveLength(1);

    down = false;
    const org = await linkTempoAccount(ORG, pending.address, { api });
    expect(org.tempoAccount).toBe(pending.address);
    expect(pendingPasskey(ORG)).toBeNull();
    expect(tempoAccountState({ id: ORG, tempoAccount: org.tempoAccount })).toEqual({ status: 'ready', address: pending.address, passkey: pending });
    // No second passkey was made to get there.
    expect(authenticator.created).toHaveLength(1);

    const made = await createTempoAccount('another-org', { label: 'Other payroll', createFn: authenticator.createFn, api });
    expect(made.org.tempoAccount).toBe(made.passkey.address);
    expect(pendingPasskey('another-org')).toBeNull();
  });

  it('tells an account whose passkey this browser does not know from one it can sign for', () => {
    const elsewhere = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
    expect(tempoAccountState({ id: ORG, tempoAccount: elsewhere })).toEqual({ status: 'elsewhere', address: elsewhere, passkey: null });
    // A browser that denies the page its storage knows no passkey, and says so without failing.
    vi.stubGlobal('window', { location: page.location });
    expect(tempoAccountState({ id: ORG, tempoAccount: elsewhere })).toEqual({ status: 'elsewhere', address: elsewhere, passkey: null });
    expect(tempoAccountState({ id: ORG, tempoAccount: null })).toEqual({ status: 'none', address: null, passkey: null });
    expect(() => storedPasskey(elsewhere)).toThrow(ClientError);
  });

  it('knows whether the browser has passkeys at all', () => {
    expect(passkeysSupported()).toBe(false);
    vi.stubGlobal('window', Object.assign(page, { PublicKeyCredential: class {}, navigator: { credentials: { create: async () => null } } }));
    expect(passkeysSupported()).toBe(true);
    vi.unstubAllGlobals();
    expect(passkeysSupported()).toBe(false);
  });
});

describe('revoking the access key', () => {
  const FIELDS = { chainId: CHAIN_ID, accessKey: accessKey.address, nonce: 7, nonceKey: 0n, gas: 500_000n, maxFeePerGas: 1_200_000_000n, maxPriorityFeePerGas: 1n, feeToken: TOKEN, validBefore: EXPIRY };

  it('signs one call, revokeKey on the Account Keychain, with the root key', async () => {
    const root = Account.fromHeadlessWebAuthn(P256.randomPrivateKey(), { rpId: RP_ID, origin: ORIGIN });
    const serialized = await signTempoRevoke(root, FIELDS);
    expect(serialized).toMatch(/^0x76[0-9a-f]+$/);

    const { signature, ...transaction } = Transaction.deserialize(serialized as `0x76${string}`);
    // The call is the one the server's package builds for a revocation.
    const call = buildRevoke({ accessKeyAddress: accessKey.address });
    expect(transaction.calls).toHaveLength(1);
    expect(transaction.calls[0]).toMatchObject({ to: call.to.toLowerCase(), data: call.data });
    expect(transaction).toMatchObject({ chainId: CHAIN_ID, nonce: 7, gas: 500_000n, maxFeePerGas: 1_200_000_000n, feeToken: TOKEN.toLowerCase(), validBefore: EXPIRY });

    if (signature === undefined) throw new Error('the transaction is not signed');
    expect(signature.type).toBe('webAuthn');
    const payload = keccak256(await Transaction.serialize({ ...transaction, type: 'tempo' }));
    expect(SignatureEnvelope.verify(signature, { address: root.address, payload })).toBe(true);
  });

  it('signs the same transaction with a stored passkey', async () => {
    vi.stubGlobal('window', fakeWindow(ORIGIN));
    try {
      const authenticator = softwareAuthenticator(ORIGIN);
      const root = tempoRoot(await createPasskey({ label: 'Acme Labs payroll', createFn: authenticator.createFn }), { getFn: authenticator.getFn });
      const serialized = await signTempoRevoke(root, FIELDS);
      const { signature, ...transaction } = Transaction.deserialize(serialized as `0x76${string}`);
      if (signature === undefined) throw new Error('the transaction is not signed');
      expect(SignatureEnvelope.verify(signature, { address: root.address, payload: keccak256(await Transaction.serialize({ ...transaction, type: 'tempo' })) })).toBe(true);
      expect(authenticator.asserted).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('takes nothing for a key or a token that is not an address, and says when the prompt was dismissed', async () => {
    const root = Account.fromHeadlessWebAuthn(P256.randomPrivateKey(), { rpId: RP_ID, origin: ORIGIN });
    expect((await failure(signTempoRevoke(root, { ...FIELDS, accessKey: 'the-key' }))).code).toBe('invalid_argument');
    expect((await failure(signTempoRevoke(root, { ...FIELDS, feeToken: 'USDC' }))).code).toBe('invalid_argument');
    const declining = {
      address: root.address,
      signTransaction: async () => {
        throw new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError');
      },
    };
    expect((await failure(signTempoRevoke(declining as never, FIELDS))).code).toBe('wallet_rejected');
    expect((await failure(signTempoRevoke(root, { ...FIELDS, feePayer: 'the-service' }))).code).toBe('invalid_argument');
  });

  const SPONSOR: Address = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
  /** The revocation as the server's package prepares it, and as it arrives from `POST …/rails/tempo/revoke`. */
  const PREPARED = buildRevocation({ accessKeyAddress: accessKey.address, chainId: CHAIN_ID, nonce: 4, baseFeePerGas: 600_000_000n, now: EXPIRY - 3_600, feePayer: SPONSOR, feeToken: TOKEN });
  const ARRIVED = wireShape(PREPARED) as TempoRevokeRequest;
  /** The decision the server makes before its sponsor signs anything. */
  const checkRevocation = (serialized: Hex, account: Address) => verifySignedRevocation({ serialized, account, accessKey: accessKey.address, chainId: CHAIN_ID });

  it('signs for a fee payer when one is named, which is exactly what the server’s check accepts', async () => {
    const root = Account.fromHeadlessWebAuthn(P256.randomPrivateKey(), { rpId: RP_ID, origin: ORIGIN });
    // What the server prepared is, field for field, what there is to sign with.
    const serialized = await signTempoRevoke(root, PREPARED);
    // Not yet a transaction a node takes: the form in which a sender hands one to its fee payer.
    expect(serialized).toMatch(/^0x78[0-9a-f]+$/);
    expect(checkRevocation(serialized, root.address)).toMatchObject({ ok: true, revocation: { nonce: 4, maxFeePerGas: 1_200_000_000n, validBefore: PREPARED.validBefore, envelope: { signature: { type: 'webAuthn' } } } });

    const { signature, ...transaction } = Transaction.deserialize(serialized as `0x76${string}`);
    expect(transaction.calls).toHaveLength(1);
    expect(transaction.calls[0]).toMatchObject({ to: buildRevoke({ accessKeyAddress: accessKey.address }).to.toLowerCase(), data: buildRevoke({ accessKeyAddress: accessKey.address }).data });
    // The root signed that a fee payer follows, and for no fee token: that one is the fee payer's to name.
    expect([transaction.feePayerSignature, transaction.feeToken]).toEqual([null, undefined]);
    if (signature === undefined) throw new Error('the transaction is not signed');
    expect(SignatureEnvelope.verify(signature, { address: root.address, payload: revocationSignPayload(PREPARED) })).toBe(true);

    // The same fields without a fee payer give a transaction the account pays for, which the server does not take.
    const { feePayer: _, ...selfPaid } = PREPARED;
    const verdict = checkRevocation(await signTempoRevoke(root, selfPaid), root.address);
    expect(verdict).toEqual({ ok: false, problems: ['the transaction is signed for the account to pay the fee itself, not for the fee sponsor to pay it'] });
  });

  it('takes the key and the chain from the organisation, and from the server only how the transaction is numbered, priced and dated', () => {
    const grant = { accessKey: accessKey.address.toLowerCase(), chainId: CHAIN_ID };
    expect(checkedRevokeFields(ARRIVED, grant)).toEqual({
      chainId: CHAIN_ID,
      accessKey: accessKey.address,
      nonce: 4,
      nonceKey: 0n,
      gas: 600_000n,
      maxFeePerGas: 1_200_000_000n,
      maxPriorityFeePerGas: 1n,
      feePayer: SPONSOR,
      validBefore: PREPARED.validBefore,
    });

    const refused = (request: unknown, over: Partial<TempoGrant> = {}): string => {
      try {
        checkedRevokeFields(request as TempoRevokeRequest, { ...grant, ...over });
      } catch (error) {
        if (error instanceof ClientError) return `${error.code}: ${error.message}`;
        throw error;
      }
      return 'taken';
    };
    const { feePayer: _, ...unsponsored } = ARRIVED;
    expect(refused({ ...ARRIVED, accessKey: PAYEES[0] })).toBe('unexpected_request: the revocation the server prepared is not for the access key of this organisation; nothing was signed');
    expect(refused({ ...ARRIVED, chainId: 4_217 })).toBe(`unexpected_request: the revocation the server prepared is for chain 4217, and the rail of the organisation is on chain ${CHAIN_ID}; nothing was signed`);
    expect(refused(unsponsored)).toBe('unexpected_request: the revocation the server prepared names nobody but the account itself to pay its fee; nothing was signed');
    for (const feePayer of [null, true, '', 'the-service', '0x1234']) expect(refused({ ...ARRIVED, feePayer }), String(feePayer)).toMatch(/^unexpected_request: .* names nobody but the account itself to pay its fee/);

    const malformed: Record<string, unknown>[] = [
      { nonce: -1 },
      { nonce: '4' },
      { nonce: 1.5 },
      { gas: 600_000 },
      { gas: '-1' },
      { gas: '0x927c0' },
      { gas: undefined },
      { maxFeePerGas: 'a lot' },
      { maxPriorityFeePerGas: null },
      { nonceKey: undefined },
      { validBefore: undefined },
      { validBefore: 0 },
      { validBefore: String(PREPARED.validBefore) },
    ];
    for (const over of malformed) expect(refused({ ...ARRIVED, ...over }), JSON.stringify(over)).toBe('unexpected_request: the revocation the server prepared is not a transaction that can be signed; nothing was signed');
    // A nonce on a sequence of its own would never be used up by anything else the account sends.
    expect(refused({ ...ARRIVED, nonceKey: '7' })).toBe("unexpected_request: the revocation the server prepared is not numbered on the account's own sequence of transactions; nothing was signed");
    // A rail on no chain in particular, or without a key, has nothing a revocation could be for.
    expect(refused(ARRIVED, { chainId: 0 })).toMatch(/^invalid_argument: /);
    expect(refused(ARRIVED, { accessKey: 'the-key' })).toMatch(/^invalid_argument: /);
  });

  /** The server as the flow meets it: the organisation, its rail, the revocation to sign, and the submission. */
  function server(root: Address, over: { org?: Record<string, unknown>; rail?: Record<string, unknown>; request?: (honest: TempoRevokeRequest) => unknown; refusal?: { status: number; body: unknown } } = {}) {
    const seen: { method: string; url: string; body: Record<string, unknown> | undefined }[] = [];
    const api = createApi({
      fetch: async (input, init) => {
        const url = String(input);
        const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>);
        seen.push({ method: init?.method ?? 'GET', url, body });
        if (url === `/api/orgs/${ORG}`) return Response.json({ id: ORG, tempoAccount: root, serviceKeys: [{ kind: 'hl_agent', address: PAYEES[1] }, { kind: 'tempo_access', address: accessKey.address }], ...over.org });
        if (url.endsWith('/rails/tempo')) return Response.json({ network: 'moderato', chainId: CHAIN_ID, token: { address: TOKEN, symbol: 'AlphaUSD', decimals: 6 }, account: root, accessKey: accessKey.address, key: { status: 'unavailable', source: 'tempo', readAt: 1, reason: 'not asked' }, ...over.rail });
        if (url.endsWith('/rails/tempo/revoke')) {
          if (over.refusal !== undefined) return Response.json(over.refusal.body, { status: over.refusal.status });
          return Response.json(over.request === undefined ? ARRIVED : over.request(ARRIVED));
        }
        return Response.json({ tx: `0x${'ef'.repeat(32)}`, txUrl: 'https://explore.testnet.tempo.xyz/tx/0xef' });
      },
    });
    return { api, seen, submitted: () => seen.find((call) => call.url.endsWith('/revoke/submit')) };
  }

  it('reads the rail, asks the server for the revocation, signs it and hands it back signed', async () => {
    const root = Account.fromHeadlessWebAuthn(P256.randomPrivateKey(), { rpId: RP_ID, origin: ORIGIN });
    const { api, seen, submitted } = server(root.address);

    const result = await revokeTempoAccessKey(root, ORG, { api });
    expect(result).toEqual({ tx: `0x${'ef'.repeat(32)}`, txUrl: 'https://explore.testnet.tempo.xyz/tx/0xef' });
    expect(seen.map((call) => `${call.method} ${call.url}`).sort()).toEqual(
      [`GET /api/orgs/${ORG}`, `GET /api/orgs/${ORG}/rails/tempo`, `POST /api/orgs/${ORG}/rails/tempo/revoke`, `POST /api/orgs/${ORG}/rails/tempo/revoke/submit`].sort(),
    );
    // The server is told nothing about what to revoke; it is handed one thing, the transaction.
    expect(seen.find((call) => call.url.endsWith('/rails/tempo/revoke'))?.body).toEqual({});
    expect(submitted()?.body).toEqual({ signedTransaction: expect.stringMatching(/^0x78[0-9a-f]+$/) });
    expect(checkRevocation(submitted()?.body?.signedTransaction as Hex, root.address)).toMatchObject({ ok: true });
    // Within what the endpoint takes for a signed transaction.
    expect((submitted()?.body?.signedTransaction as Hex).length).toBeLessThan(8_000);
  });

  it('signs with a stored passkey, once, over the digest of this revocation and of nothing else', async () => {
    vi.stubGlobal('window', fakeWindow(ORIGIN));
    try {
      const authenticator = softwareAuthenticator(ORIGIN);
      const passkey = await createPasskey({ label: 'Acme Labs payroll', createFn: authenticator.createFn });
      const root = tempoRoot(passkey, { getFn: authenticator.getFn });
      const { api, submitted } = server(root.address);
      await revokeTempoAccessKey(root, ORG, { api });

      expect(authenticator.asserted).toHaveLength(1);
      expect(authenticator.asserted[0]).toMatchObject({ rpId: RP_ID, credentialId: passkey.credentialId });
      expect(`0x${Buffer.from(authenticator.asserted[0]?.challenge ?? []).toString('hex')}`).toBe(revocationSignPayload(PREPARED));
      expect(checkRevocation(submitted()?.body?.signedTransaction as Hex, root.address)).toMatchObject({ ok: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('signs for no key or chain but the organisation’s own, and for no fee of the account’s, whatever the server prepares', async () => {
    const root = Account.fromHeadlessWebAuthn(P256.randomPrivateKey(), { rpId: RP_ID, origin: ORIGIN });
    const signTransaction = vi.fn(root.signTransaction);
    const signer = { address: root.address, signTransaction } as Parameters<typeof revokeTempoAccessKey>[0];
    const attacker = generateAccessKey().address;

    const dishonest: [string, Parameters<typeof server>[1]][] = [
      ['the revocation of another key', { request: (honest) => ({ ...honest, accessKey: attacker }) }],
      ['a revocation on another chain', { request: (honest) => ({ ...honest, chainId: 4_217 }) }],
      ['a revocation the account pays for', { request: ({ feePayer: _, ...honest }) => honest }],
      ['a revocation with no deadline', { request: ({ validBefore: _, ...honest }) => honest }],
      ['a revocation with gas that is no number', { request: (honest) => ({ ...honest, gas: 'as much as it takes' }) }],
      ['something that is no revocation at all', { request: () => ({ transaction: '0x76abcd' }) }],
      // A rail that names a key which is not the organisation's own, consistent with the revocation it prepares.
      ['a rail of another key', { rail: { accessKey: attacker }, request: (honest) => ({ ...honest, accessKey: attacker }) }],
    ];
    for (const [what, over] of dishonest) {
      const lying = server(root.address, over);
      expect((await failure(revokeTempoAccessKey(signer, ORG, { api: lying.api }))).code, what).toBe('unexpected_request');
      expect(lying.submitted(), what).toBeUndefined();
    }

    // An organisation whose Tempo account is another, or that has none, or no access key.
    expect((await failure(revokeTempoAccessKey(signer, ORG, { api: server(root.address, { org: { tempoAccount: PAYEES[0] } }).api }))).code).toBe('wrong_account');
    expect((await failure(revokeTempoAccessKey(signer, ORG, { api: server(root.address, { org: { tempoAccount: null }, rail: { account: null } }).api }))).code).toBe('wrong_account');
    expect((await failure(revokeTempoAccessKey(signer, ORG, { api: server(root.address, { org: { serviceKeys: [] }, rail: { accessKey: null } }).api }))).code).toBe('nothing_to_sign');
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it('passes on the server’s refusal and the treasurer’s, and hands nothing back then', async () => {
    const root = Account.fromHeadlessWebAuthn(P256.randomPrivateKey(), { rpId: RP_ID, origin: ORIGIN });
    const signTransaction = vi.fn(root.signTransaction);
    const nothing = server(root.address, { refusal: { status: 409, body: { error: 'refused', message: `access key ${accessKey.address} is already revoked on this account; there is nothing to revoke` } } });
    const refused = await failure(revokeTempoAccessKey({ address: root.address, signTransaction } as Parameters<typeof revokeTempoAccessKey>[0], ORG, { api: nothing.api }));
    expect({ status: refused.status, code: refused.code, message: refused.message }).toEqual({ status: 409, code: 'refused', message: `access key ${accessKey.address} is already revoked on this account; there is nothing to revoke` });
    expect(signTransaction).not.toHaveBeenCalled();

    const willing = server(root.address);
    const declining = {
      address: root.address,
      signTransaction: async () => {
        throw new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError');
      },
    };
    expect((await failure(revokeTempoAccessKey(declining as never, ORG, { api: willing.api }))).code).toBe('wallet_rejected');
    expect([nothing.submitted(), willing.submitted()]).toEqual([undefined, undefined]);
  });
});
