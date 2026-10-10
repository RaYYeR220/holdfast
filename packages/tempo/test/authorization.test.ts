import { KeyAuthorization, SignatureEnvelope } from 'ox/tempo';
import { decodeFunctionData, getAddress } from 'viem';
import { Abis, Account, Addresses, P256 } from 'viem/tempo';
import { describe, expect, it } from 'vitest';
import {
  MAX_SCOPED_RECIPIENTS,
  TOKENS,
  TRANSFER_WITH_MEMO_SELECTOR,
  accessKeyAddressOf,
  boundProblems,
  buildAccessKeyAuthorization,
  buildRevoke,
  generateAccessKey,
  grantedStatus,
  readSignedAuthorization,
  scopeOf,
  serializeSignedAuthorization,
  toKeyStatus,
  verifySignedAuthorization,
} from '../src/index';
import { PAYEES, START, TOKEN as ALPHA } from './fake-chain';

// A throwaway key that never held funds on any network.
const root = Account.fromSecp256k1('0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318');
const key = generateAccessKey();
const EXPIRY = START + 86_400;
// Everything the package hands back is checksummed.
const TOKEN = getAddress(ALPHA);
const BETA = getAddress(TOKENS.moderato.BetaUSD);

const policy = (over: Partial<Parameters<typeof buildAccessKeyAuthorization>[0]> = {}) => ({
  rootAddress: root.address,
  accessKeyAddress: key.address,
  token: TOKEN,
  limit: 10_000_000n,
  periodSeconds: 3_600,
  expiry: EXPIRY,
  recipients: PAYEES,
  chainId: 42431,
  ...over,
});

describe('access keys', () => {
  it('generates a P-256 key and derives its key id', () => {
    const other = generateAccessKey();
    expect(other.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(other.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(other.address).not.toBe(key.address);
    expect(accessKeyAddressOf(other.privateKey)).toBe(other.address);
    // The SDK reports the same key id in lower case on an account that signs for a root.
    expect(getAddress(Account.fromP256(other.privateKey, { access: root.address }).accessKeyAddress)).toBe(other.address);
  });
});

describe('building the authorization', () => {
  it('describes one token, one limit, one selector and the listed payees', () => {
    const request = buildAccessKeyAuthorization(policy());
    expect(request.authorization).toEqual({
      address: key.address,
      type: 'p256',
      chainId: 42431n,
      expiry: EXPIRY,
      limits: [{ token: TOKEN, limit: 10_000_000n, period: 3_600 }],
      scopes: [{ address: TOKEN, selector: TRANSFER_WITH_MEMO_SELECTOR, recipients: PAYEES }],
    });
    expect(request.key).toEqual({ address: key.address, type: 'p256' });
    expect(request.signPayload).toBe(KeyAuthorization.getSignPayload(request.authorization));
  });

  it('leaves the recipient list out when anyone may be paid', () => {
    const { recipients: _, ...open } = policy();
    expect(buildAccessKeyAuthorization(open).authorization.scopes).toEqual([{ address: TOKEN, selector: TRANSFER_WITH_MEMO_SELECTOR }]);
  });

  it('produces the payload the SDK itself would sign', async () => {
    const request = buildAccessKeyAuthorization(policy());
    const viaSdk = await root.signKeyAuthorization(request.key, request.policy);
    const ours = serializeSignedAuthorization(request.authorization, await root.sign({ hash: request.signPayload }));
    expect(ours).toBe(KeyAuthorization.serialize(viaSdk));
    expect(serializeSignedAuthorization(viaSdk)).toBe(ours);
  });

  it('changes the payload when any term changes', () => {
    const base = buildAccessKeyAuthorization(policy()).signPayload;
    const variants = [
      policy({ limit: 10_000_001n }),
      policy({ periodSeconds: 7_200 }),
      policy({ expiry: EXPIRY + 1 }),
      policy({ chainId: 4217 }),
      policy({ token: BETA }),
      policy({ recipients: PAYEES.slice(0, 2) }),
      policy({ accessKeyAddress: generateAccessKey().address }),
    ];
    for (const variant of variants) expect(buildAccessKeyAuthorization(variant).signPayload).not.toBe(base);
  });

  it('rejects terms that would not bound the key', () => {
    const bad: [string, Partial<Parameters<typeof buildAccessKeyAuthorization>[0]>][] = [
      ['zero limit', { limit: 0n }],
      ['negative period', { periodSeconds: -1 }],
      ['fractional period', { periodSeconds: 1.5 }],
      ['chain 0 is every chain', { chainId: 0 }],
      ['expiry in milliseconds', { expiry: EXPIRY * 1000 }],
      ['no expiry', { expiry: 0 }],
      ['root as its own access key', { accessKeyAddress: root.address }],
      ['bad token', { token: '0x1234' as never }],
      ['bad recipient', { recipients: ['0xnope' as never] }],
      ['duplicate recipient', { recipients: [PAYEES[0], PAYEES[0].toLowerCase() as never] }],
      ['too many recipients', { recipients: Array.from({ length: MAX_SCOPED_RECIPIENTS + 1 }, () => generateAccessKey().address) }],
    ];
    for (const [label, over] of bad) expect(() => buildAccessKeyAuthorization(policy(over)), label).toThrow(RangeError);
  });
});

describe('the signed authorization', () => {
  it('refuses to serialize without a signature', () => {
    expect(() => serializeSignedAuthorization(buildAccessKeyAuthorization(policy()).authorization)).toThrow(RangeError);
  });

  it('reads back in the terms of the keychain', async () => {
    const request = buildAccessKeyAuthorization(policy());
    const wire = serializeSignedAuthorization(request.authorization, await root.sign({ hash: request.signPayload }));
    const read = readSignedAuthorization(wire);
    expect(read).toMatchObject({
      accessKey: key.address,
      chainId: 42431,
      expiry: EXPIRY,
      limits: [{ token: TOKEN, limit: 10_000_000n, period: 3_600 }],
      isScoped: true,
      scopes: [{ target: TOKEN, selectorRules: [{ selector: TRANSFER_WITH_MEMO_SELECTOR, recipients: PAYEES }] }],
    });
    expect(read.signed.signature.type).toBe('secp256k1');
  });

  it('carries a passkey signature the same way', async () => {
    // A software stand-in for a browser passkey: real WebAuthn-shaped signatures, no ceremony.
    const passkey = Account.fromHeadlessWebAuthn(P256.randomPrivateKey(), { rpId: 'treasury.example', origin: 'https://treasury.example' });
    const request = buildAccessKeyAuthorization(policy({ rootAddress: passkey.address }));
    const wire = serializeSignedAuthorization(request.authorization, await passkey.sign({ hash: request.signPayload }));
    const { signed } = readSignedAuthorization(wire);
    expect(signed.signature.type).toBe('webAuthn');
    expect(KeyAuthorization.getSignPayload(signed)).toBe(request.signPayload);
    expect(SignatureEnvelope.verify(signed.signature, { address: passkey.address, payload: request.signPayload })).toBe(true);
    expect(SignatureEnvelope.verify(signed.signature, { address: root.address, payload: request.signPayload })).toBe(false);
    const viaSdk = await passkey.signKeyAuthorization(request.key, request.policy);
    expect(KeyAuthorization.getSignPayload(viaSdk)).toBe(request.signPayload);
  });

  it('refuses an unsigned or an admin authorization', async () => {
    const request = buildAccessKeyAuthorization(policy());
    expect(() => readSignedAuthorization(KeyAuthorization.serialize(request.authorization))).toThrow(/not signed/);
    const admin = await root.signKeyAuthorization(request.key, { chainId: 42431n, admin: true });
    expect(() => readSignedAuthorization(KeyAuthorization.serialize(admin))).toThrow(/admin/);
  });

  it('shows the status the key will have once provisioned', async () => {
    const request = buildAccessKeyAuthorization(policy());
    const read = readSignedAuthorization(serializeSignedAuthorization(request.authorization, await root.sign({ hash: request.signPayload })));
    expect(grantedStatus(read, TOKEN, START)).toMatchObject({
      authorized: true,
      live: true,
      mismatch: [],
      revoked: false,
      expiresAt: EXPIRY * 1000,
      limited: true,
      remaining: 10_000_000n,
      scope: { unrestricted: false, selectors: [TRANSFER_WITH_MEMO_SELECTOR], recipients: PAYEES, otherTargets: [] },
    });
    // The same authorization is not a payout key for a token it does not name.
    expect(grantedStatus(read, BETA, START)).toMatchObject({ authorized: false, live: true, remaining: 0n, scope: { selectors: [], recipients: [], otherTargets: [TOKEN] } });
  });
});

describe('checking a signed authorization before it is submitted', () => {
  const expected = policy();
  const sign = async (over: Partial<Parameters<typeof buildAccessKeyAuthorization>[0]> = {}, signer: { sign: (i: { hash: `0x${string}` }) => Promise<`0x${string}`> } = root) => {
    const request = buildAccessKeyAuthorization(policy(over));
    return serializeSignedAuthorization(request.authorization, await signer.sign({ hash: request.signPayload }));
  };
  const check = (wire: `0x${string}`, over: Partial<Parameters<typeof verifySignedAuthorization>[0]> = {}) =>
    verifySignedAuthorization({ wire, expected, account: root.address, accessKey: key.address, token: TOKEN, chainId: 42431, ...over });
  const problemsOf = (result: ReturnType<typeof verifySignedAuthorization>) => (result.ok ? [] : result.problems);

  /** A wire the root really signed for terms no policy of this rail describes. */
  async function signRaw(terms: Record<string, unknown>) {
    const authorization = KeyAuthorization.from({ address: key.address, type: 'p256', chainId: 42431n, expiry: EXPIRY, ...terms } as never) as KeyAuthorization.KeyAuthorization<false>;
    return serializeSignedAuthorization(authorization, await root.sign({ hash: KeyAuthorization.getSignPayload(authorization) }));
  }
  const limits = [{ token: TOKEN, limit: 10_000_000n, period: 3_600 }];
  const scopes = [{ address: TOKEN, selector: TRANSFER_WITH_MEMO_SELECTOR, recipients: PAYEES }];

  it('accepts exactly the authorization built from the expected policy and signed by the account', async () => {
    const result = check(await sign());
    expect(result.ok).toBe(true);
    expect(result.ok && result.authorization.accessKey).toBe(key.address);
  });

  it('accepts a passkey root', async () => {
    const passkey = Account.fromHeadlessWebAuthn(P256.randomPrivateKey(), { rpId: 'treasury.example', origin: 'https://treasury.example' });
    const terms = policy({ rootAddress: passkey.address });
    const request = buildAccessKeyAuthorization(terms);
    const wire = serializeSignedAuthorization(request.authorization, await passkey.sign({ hash: request.signPayload }));
    expect(check(wire, { expected: terms, account: passkey.address }).ok).toBe(true);
    expect(problemsOf(check(wire, { expected: policy(), account: root.address }))).toEqual([`the authorization is not signed by the root key of ${root.address}`]);
  });

  it('refuses terms that differ from the expected ones, naming the difference', async () => {
    const differing: [Partial<Parameters<typeof buildAccessKeyAuthorization>[0]>, RegExp][] = [
      [{ limit: 10_000_001n }, /it allows 10\.000001 per 3600 s, expected 10\.00 per 3600 s/],
      [{ periodSeconds: 0 }, /it allows 10\.00 per 0 s, expected 10\.00 per 3600 s/],
      [{ expiry: EXPIRY + 1 }, /it expires .*, expected /],
      [{ recipients: PAYEES.slice(0, 2) }, /it may pay \[.*\], expected \[/],
      [{ recipients: [] }, /it may pay anyone, expected \[/],
      [{ token: BETA }, /its spending limit is on token /],
      [{ chainId: 4217 }, /the authorization is for chain 4217, this rail runs on chain 42431/],
      [{ accessKeyAddress: generateAccessKey().address }, /the authorization is for key /],
    ];
    for (const [over, message] of differing) {
      const problems = problemsOf(check(await sign(over)));
      expect(problems.join(' | '), JSON.stringify(over, (_k, v) => (typeof v === 'bigint' ? `${v}` : v))).toMatch(message);
    }
    // The other way round: the wire is narrow, the expectation asks for any payee.
    expect(problemsOf(check(await sign(), { expected: policy({ recipients: [] }) })).join()).toMatch(/it may pay \[.*\], expected anyone/);
  });

  it('refuses every grant that is broader than a bounded payout key', async () => {
    const broader: [string, Record<string, unknown>, string][] = [
      ['no limit', { scopes }, 'it sets no spending limit'],
      ['a second limited token', { limits: [...limits, { token: BETA, limit: 1n, period: 0 }], scopes }, 'it sets 2 spending limits, expected exactly one'],
      ['no scope', { limits }, `its call scope is not transferWithMemo on ${TOKEN} alone`],
      ['the whole token', { limits, scopes: [{ address: TOKEN }] }, `its call scope is not transferWithMemo on ${TOKEN} alone`],
      ['a second function', { limits, scopes: [...scopes, { address: TOKEN, selector: '0xa9059cbb' }] }, `its call scope is not transferWithMemo on ${TOKEN} alone`],
      ['a second contract', { limits, scopes: [...scopes, { address: BETA, selector: TRANSFER_WITH_MEMO_SELECTOR }] }, `its call scope is not transferWithMemo on ${TOKEN} alone`],
      ['no expiry', { limits, scopes, expiry: undefined }, 'it expires never, expected'],
    ];
    for (const [label, terms, message] of broader) {
      const problems = problemsOf(check(await signRaw(terms)));
      expect(problems.join(' | '), label).toContain(`the authorization differs from the expected policy: ${message}`);
    }
  });

  it('refuses a wire that matches in every named term but is not the expected authorization', async () => {
    const witnessed = await signRaw({ limits, scopes, witness: `0x${'11'.repeat(32)}` });
    expect(problemsOf(check(witnessed))).toEqual(['the authorization is not the one built from the expected policy']);
  });

  it('refuses a signature that is not the root key\'s of the account', async () => {
    const stranger = Account.fromSecp256k1('0x8da4ef21b864d2cc526dbdb2a120bd2874c36c9d0a1fb7f8c63d7f7a8b41de8f');
    expect(problemsOf(check(await sign({}, stranger)))).toEqual([`the authorization is not signed by the root key of ${root.address}`]);
    // Signed by the right root, but over other terms: the signature does not carry over.
    const request = buildAccessKeyAuthorization(expected);
    const other = buildAccessKeyAuthorization(policy({ limit: 1n }));
    const transplanted = serializeSignedAuthorization(request.authorization, await root.sign({ hash: other.signPayload }));
    expect(problemsOf(check(transplanted))).toEqual([`the authorization is not signed by the root key of ${root.address}`]);
  });

  it('refuses an expectation that is not about this account, key, token or chain', async () => {
    const wire = await sign();
    expect(problemsOf(check(wire, { account: PAYEES[0] }))).toEqual([`the expected policy is for account ${root.address}, not ${PAYEES[0]}`]);
    expect(problemsOf(check(wire, { accessKey: PAYEES[0] }))).toContain(`the expected policy is for key ${key.address}, this rail signs with ${PAYEES[0]}`);
    expect(problemsOf(check(wire, { token: BETA }))).toContain(`the expected policy is for token ${TOKEN}, this rail pays in ${BETA}`);
    expect(problemsOf(check(wire, { chainId: 4217 }))).toContain('the expected policy is for chain 42431, this rail runs on chain 4217');
    expect(problemsOf(check(wire, { expected: policy({ limit: 0n }) }))).toEqual(['the expected policy is not valid: limit must be positive']);
  });

  it('refuses what it cannot read', () => {
    expect(problemsOf(check('0x1234'))).toEqual([expect.stringContaining('the authorization cannot be read')]);
    const unsigned = KeyAuthorization.serialize(buildAccessKeyAuthorization(expected).authorization);
    expect(problemsOf(check(unsigned))).toEqual(['the authorization cannot be read: the authorization is not signed']);
  });
});

describe('revoking', () => {
  it('is a revokeKey call on the keychain precompile', () => {
    const call = buildRevoke({ accessKeyAddress: key.address });
    expect(call.to).toBe(Addresses.accountKeychain);
    expect(decodeFunctionData({ abi: Abis.accountKeychain, data: call.data })).toMatchObject({ functionName: 'revokeKey', args: [key.address] });
    expect(() => buildRevoke({ accessKeyAddress: '0x12' as never })).toThrow(RangeError);
  });
});

describe('key status from the keychain getters', () => {
  const raw = {
    keyId: key.address,
    expiry: BigInt(EXPIRY),
    enforceLimits: true,
    isRevoked: false,
    remaining: 5_750_000n,
    periodEnd: BigInt(START + 3_600),
    isScoped: true,
    scopes: [{ target: TOKEN, selectorRules: [{ selector: TRANSFER_WITH_MEMO_SELECTOR, recipients: PAYEES }] }],
  };
  const zero = '0x0000000000000000000000000000000000000000' as const;

  it('reads a live, bounded key', () => {
    expect(toKeyStatus(raw, key.address, TOKEN, START)).toEqual({
      accessKey: key.address,
      authorized: true,
      live: true,
      mismatch: [],
      revoked: false,
      expiresAt: EXPIRY * 1000,
      limited: true,
      remaining: 5_750_000n,
      periodEnd: (START + 3_600) * 1000,
      scope: { unrestricted: false, selectors: [TRANSFER_WITH_MEMO_SELECTOR], recipients: PAYEES, otherTargets: [] },
    });
  });

  it('reads a revoked key the way the chain reports it: zeroed, with the revoked flag', () => {
    const revoked = { ...raw, keyId: zero, expiry: 0n, isRevoked: true, remaining: 0n, periodEnd: 0n, scopes: [] };
    expect(toKeyStatus(revoked, key.address, TOKEN, START)).toMatchObject({ authorized: false, live: false, mismatch: [], revoked: true, expiresAt: null, remaining: 0n, periodEnd: null, scope: { selectors: [], recipients: [] } });
  });

  it('reads a key the account never authorized', () => {
    const unknown = { ...raw, keyId: zero, expiry: 0n, enforceLimits: false, remaining: 0n, periodEnd: 0n, scopes: [] };
    expect(toKeyStatus(unknown, key.address, TOKEN, START)).toMatchObject({ authorized: false, live: false, mismatch: [], revoked: false, expiresAt: null, remaining: 0n });
  });

  it('stops trusting a key at its expiry, whatever the limit says', () => {
    expect(toKeyStatus(raw, key.address, TOKEN, EXPIRY - 1).authorized).toBe(true);
    expect(toKeyStatus(raw, key.address, TOKEN, EXPIRY)).toMatchObject({ authorized: false, live: false, revoked: false, remaining: 0n, periodEnd: null, expiresAt: EXPIRY * 1000 });
  });

  it('reports a one-off limit without a reset time', () => {
    expect(toKeyStatus({ ...raw, periodEnd: 0n }, key.address, TOKEN, START).periodEnd).toBeNull();
  });

  it('does not count a live key as authorized when it is broader than a bounded payout key', () => {
    const memo = { selector: TRANSFER_WITH_MEMO_SELECTOR, recipients: PAYEES };
    const unlimited = toKeyStatus({ ...raw, enforceLimits: false, remaining: 0n, periodEnd: 0n }, key.address, TOKEN, START);
    expect(unlimited).toMatchObject({ authorized: false, live: true, limited: false, remaining: 0n, mismatch: ['it has no spending limit'] });
    const unscoped = toKeyStatus({ ...raw, isScoped: false, scopes: [] }, key.address, TOKEN, START);
    expect(unscoped).toMatchObject({ authorized: false, live: true, remaining: 0n, periodEnd: null, mismatch: ['it has no call scope and may call anything'] });
    const both = toKeyStatus({ ...raw, enforceLimits: false, isScoped: false, scopes: [] }, key.address, TOKEN, START);
    expect(both.mismatch).toEqual(['it has no spending limit', 'it has no call scope and may call anything']);
    const wide = toKeyStatus({ ...raw, scopes: [{ target: TOKEN, selectorRules: [memo, { selector: '0xa9059cbb', recipients: [] }] }, { target: BETA, selectorRules: [] }] }, key.address, TOKEN, START);
    expect(wide).toMatchObject({ authorized: false, live: true, remaining: 0n });
    expect(wide.mismatch).toEqual([`it may call other contracts (${BETA})`, 'it may call other functions of the payout token (0xa9059cbb)']);
  });

  it('names every way a scope can be wider or other than transferWithMemo on the token', () => {
    const bounded = { unrestricted: false, selectors: [TRANSFER_WITH_MEMO_SELECTOR], recipients: null, otherTargets: [] };
    expect(boundProblems(true, bounded)).toEqual([]);
    expect(boundProblems(true, { ...bounded, recipients: PAYEES })).toEqual([]);
    expect(boundProblems(true, { ...bounded, selectors: null })).toEqual(['it may call every function of the payout token']);
    expect(boundProblems(true, { ...bounded, selectors: [] })).toEqual(['it may not call transferWithMemo on the payout token']);
    expect(boundProblems(true, { ...bounded, selectors: ['0xa9059cbb'] })).toEqual(['it may call other functions of the payout token (0xa9059cbb)', 'it may not call transferWithMemo on the payout token']);
    expect(boundProblems(false, bounded)).toEqual(['it has no spending limit']);
  });

  it('treats a key without expiry as never expiring', () => {
    expect(toKeyStatus({ ...raw, expiry: 2n ** 64n - 1n }, key.address, TOKEN, START)).toMatchObject({ authorized: true, expiresAt: null });
  });

  it('reduces call scopes to what a payout key may do', () => {
    const memoRule = (recipients: readonly `0x${string}`[]) => ({ selector: TRANSFER_WITH_MEMO_SELECTOR as `0x${string}`, recipients });
    expect(scopeOf(false, [], TOKEN)).toEqual({ unrestricted: true, selectors: null, recipients: null, otherTargets: [] });
    expect(scopeOf(true, [], TOKEN)).toEqual({ unrestricted: false, selectors: [], recipients: [], otherTargets: [] });
    expect(scopeOf(true, [{ target: TOKEN, selectorRules: [] }], TOKEN)).toEqual({ unrestricted: false, selectors: null, recipients: null, otherTargets: [] });
    expect(scopeOf(true, [{ target: TOKEN, selectorRules: [memoRule([])] }], TOKEN)).toMatchObject({ selectors: [TRANSFER_WITH_MEMO_SELECTOR], recipients: null });
    expect(scopeOf(true, [{ target: TOKEN, selectorRules: [{ selector: '0xa9059cbb', recipients: [] }] }], TOKEN)).toMatchObject({ selectors: ['0xa9059cbb'], recipients: [] });
    expect(scopeOf(true, [{ target: BETA, selectorRules: [memoRule([])] }], TOKEN)).toEqual({
      unrestricted: false,
      selectors: [],
      recipients: [],
      otherTargets: [BETA],
    });
  });
});
