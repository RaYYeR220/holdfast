import * as Secp256k1 from 'ox/Secp256k1';
import { SignatureEnvelope, TxEnvelopeTempo } from 'ox/tempo';
import { type Address, type Hex, decodeFunctionData, encodeFunctionData, getAddress, maxUint256, toEventSelector } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { Abis, Account, Addresses, P256, Transaction } from 'viem/tempo';
import { describe, expect, it } from 'vitest';
import {
  type ChainLog,
  REVOCATION_GAS,
  REVOCATION_NONCE_KEY,
  REVOCATION_PRIORITY_FEE,
  REVOCATION_VALIDITY_SECONDS,
  type RevocationRequest,
  TOKENS,
  type TempoChain,
  buildRevocation,
  buildRevoke,
  generateAccessKey,
  keyRevokedIn,
  revocationEnvelope,
  revocationProblems,
  revocationSignPayload,
  sponsorProblem,
  sponsorRevocation,
  transferCall,
  verifySignedRevocation,
} from '../src/index';
import { KEY_NOT_FOUND, OUTSIDER, PAYEES, ROOT, ROOT_ACCOUNT, START, TOKEN as ALPHA, line, setup, signRevocation } from './fake-chain';

const TOKEN = getAddress(ALPHA);
const key = generateAccessKey();
const sponsor = Account.fromSecp256k1(generatePrivateKey());
const BASE_FEE = 600_000_000n;
const CHAIN_ID = 42431;

const request = (over: Partial<Parameters<typeof buildRevocation>[0]> = {}): RevocationRequest =>
  buildRevocation({ accessKeyAddress: key.address, chainId: CHAIN_ID, nonce: 0, baseFeePerGas: BASE_FEE, now: START, feePayer: sponsor.address, feeToken: TOKEN, ...over });

const check = (serialized: Hex, over: Partial<Parameters<typeof verifySignedRevocation>[0]> = {}) => verifySignedRevocation({ serialized, account: ROOT, accessKey: key.address, chainId: CHAIN_ID, ...over });
const problemsOf = (result: ReturnType<typeof verifySignedRevocation>) => (result.ok ? [] : result.problems);
const passkey = () => Account.fromHeadlessWebAuthn(P256.randomPrivateKey(), { rpId: 'treasury.example', origin: 'https://treasury.example' });

describe('building the revocation', () => {
  it('describes one transaction of the account itself, at twice the base fee, good for two minutes', () => {
    expect(request({ nonce: 3 })).toEqual({
      chainId: CHAIN_ID,
      accessKey: key.address,
      nonce: 3,
      nonceKey: 0n,
      gas: 600_000n,
      maxFeePerGas: 1_200_000_000n,
      maxPriorityFeePerGas: 1n,
      feePayer: sponsor.address,
      feeToken: TOKEN,
      validBefore: START + 120,
    });
    expect([REVOCATION_NONCE_KEY, REVOCATION_GAS, REVOCATION_PRIORITY_FEE, REVOCATION_VALIDITY_SECONDS]).toEqual([0n, 600_000n, 1n, 120]);
    // A chain without a base fee still gets a fee the tip fits under.
    expect(request({ baseFeePerGas: 0n })).toMatchObject({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
    // Addresses come back the way everything else in the package writes them.
    expect(request({ accessKeyAddress: key.address.toLowerCase() as Address }).accessKey).toBe(key.address);
  });

  it('rejects what is not a key, a chain, a nonce or a time', () => {
    const bad: [string, Partial<Parameters<typeof buildRevocation>[0]>][] = [
      ['a key that is not an address', { accessKeyAddress: '0x12' as never }],
      ['chain 0', { chainId: 0 }],
      ['a negative nonce', { nonce: -1 }],
      ['a fractional nonce', { nonce: 1.5 }],
      ['no time', { now: 0 }],
    ];
    for (const [label, over] of bad) expect(() => request(over), label).toThrow(RangeError);
  });

  it('is one call, revokeKey on the keychain, marked for a fee payer and naming no fee token', () => {
    const envelope = revocationEnvelope(request());
    expect(envelope.calls).toHaveLength(1);
    expect(envelope.calls[0]?.to).toBe(Addresses.accountKeychain);
    expect(decodeFunctionData({ abi: Abis.accountKeychain, data: envelope.calls[0]?.data as Hex })).toMatchObject({ functionName: 'revokeKey', args: [key.address] });
    expect(envelope).toMatchObject({ chainId: CHAIN_ID, nonce: 0n, nonceKey: 0n, gas: 600_000n, maxFeePerGas: 1_200_000_000n, maxPriorityFeePerGas: 1n, validBefore: START + 120, feePayerSignature: null });
    expect(envelope.feeToken).toBeUndefined();
    expect(envelope.signature).toBeUndefined();
  });

  it('produces the payload the SDK itself signs when it is told a fee payer follows', async () => {
    for (const root of [ROOT_ACCOUNT, passkey()]) {
      const serialized = await signRevocation(request(), root);
      // What a sender hands to a fee payer: the transaction under 0x78, with the sender's address where the fee payer signs.
      expect(serialized).toMatch(/^0x78/);
      const { signature } = TxEnvelopeTempo.deserialize(serialized as TxEnvelopeTempo.Serialized);
      if (signature === undefined) throw new Error('the transaction is not signed');
      expect(SignatureEnvelope.verify(signature, { address: root.address, payload: revocationSignPayload(request()) })).toBe(true);
    }
  });

  it('is another payload than that of the same call paid by the account itself', async () => {
    const selfPaid = await signRevocation(request(), ROOT_ACCOUNT, { feePayer: undefined, feeToken: TOKEN });
    expect(selfPaid).toMatch(/^0x76/);
    const { signature, ...unsigned } = TxEnvelopeTempo.deserialize(selfPaid as TxEnvelopeTempo.Serialized);
    if (signature === undefined) throw new Error('the transaction is not signed');
    expect(TxEnvelopeTempo.getSignPayload(unsigned)).not.toBe(revocationSignPayload(request()));
    // So the signature on one is none on the other: a fee payer cannot be added to a transaction signed without the marker.
    expect(SignatureEnvelope.verify(signature, { address: ROOT, payload: revocationSignPayload(request()) })).toBe(false);
  });

  it('changes the payload when any term changes', () => {
    const base = revocationSignPayload(request());
    const variants: RevocationRequest[] = [
      request({ accessKeyAddress: generateAccessKey().address }),
      request({ chainId: 4217 }),
      request({ nonce: 1 }),
      request({ baseFeePerGas: BASE_FEE + 1n }),
      request({ now: START + 1 }),
      { ...request(), gas: 600_001n },
      { ...request(), maxPriorityFeePerGas: 2n },
    ];
    for (const variant of variants) expect(revocationSignPayload(variant)).not.toBe(base);
    // Who pays and in what is not the root's to sign.
    expect(revocationSignPayload(request({ feeToken: getAddress(TOKENS.moderato.BetaUSD), feePayer: OUTSIDER }))).toBe(base);
  });
});

describe('checking a signed revocation before it is sent', () => {
  it('accepts exactly the revocation of the key, signed by the account for a fee payer', async () => {
    const result = check(await signRevocation(request({ nonce: 2 })));
    if (!result.ok) throw new Error(result.problems.join('; '));
    expect(result.revocation).toMatchObject({ nonce: 2, maxFeePerGas: 1_200_000_000n, validBefore: START + 120 });
    expect(result.revocation.envelope).toMatchObject({ ...revocationEnvelope(request({ nonce: 2 })), signature: { type: 'secp256k1' } });
  });

  it('accepts a passkey root, and only for its own account', async () => {
    const root = passkey();
    const serialized = await signRevocation(request(), root);
    const result = check(serialized, { account: root.address });
    expect(result.ok).toBe(true);
    expect(result.ok && result.revocation.envelope.signature.type).toBe('webAuthn');
    expect(problemsOf(check(serialized))).toEqual([`the transaction is sent by ${root.address}, not by ${ROOT}`]);
  });

  it('refuses a transaction that calls something else, another key, or more than the revocation', async () => {
    const revoke = buildRevoke({ accessKeyAddress: key.address });
    const other = generateAccessKey().address;
    const raise = { to: Addresses.accountKeychain, data: encodeFunctionData({ abi: Abis.accountKeychain, functionName: 'updateSpendingLimit', args: [key.address, TOKEN, maxUint256] }) };
    const notTheCall = `the transaction's call is not revokeKey(${key.address}) on the Account Keychain`;
    const cases: [string, Record<string, unknown>, string][] = [
      ['a payment from the account', { calls: [transferCall(TOKEN, OUTSIDER, 1_000_000n)] }, notTheCall],
      ['a raised spending limit', { calls: [raise] }, notTheCall],
      ['the revocation of another key', { calls: [buildRevoke({ accessKeyAddress: other })] }, `the transaction revokes key ${other}, this rail's key is ${key.address}`],
      ['the revocation and a payment', { calls: [revoke, transferCall(TOKEN, OUTSIDER, 1_000_000n)] }, 'the transaction makes 2 calls, expected the revocation alone'],
      ['the revocation twice', { calls: [revoke, revoke] }, 'the transaction makes 2 calls, expected the revocation alone'],
      ['the revocation with value', { calls: [{ ...revoke, value: 1n }] }, notTheCall],
      ['the revocation with bytes after it', { calls: [{ ...revoke, data: `${revoke.data}00` }] }, notTheCall],
      ['the same call to another contract', { calls: [{ ...revoke, to: TOKEN }] }, notTheCall],
      ['another chain', { chainId: 4217 }, 'the transaction is for chain 4217, this rail runs on chain 42431'],
      ['another gas limit', { gas: 30_000_000n }, 'the transaction carries a gas limit of 30000000, expected 600000'],
      ['another tip', { maxPriorityFeePerGas: 1_000_000_000n }, 'the transaction offers a tip of 1000000000 per gas, expected 1'],
      ['a nonce lane of its own', { nonceKey: 7n }, "the transaction is numbered on nonce key 7, expected the account's own sequence"],
      ['no deadline', { validBefore: undefined }, 'the transaction never expires'],
    ];
    for (const [label, over, message] of cases) expect(problemsOf(check(await signRevocation(request(), ROOT_ACCOUNT, over))), label).toContain(message);
  });

  it('refuses a transaction that matches in every named term and carries something more', async () => {
    const authorization = await ROOT_ACCOUNT.signKeyAuthorization({ address: generateAccessKey().address, type: 'p256' }, { chainId: BigInt(CHAIN_ID), expiry: START + 86_400 });
    const more: [string, Record<string, unknown>][] = [
      ['a new key, authorized in the same transaction', { keyAuthorization: authorization }],
      ['a time before which it cannot be included', { validAfter: START - 60 }],
      ['an access list', { accessList: [{ address: TOKEN, storageKeys: [] }] }],
    ];
    for (const [label, over] of more) expect(problemsOf(check(await signRevocation(request(), ROOT_ACCOUNT, over))), label).toEqual(['the transaction carries more than the revocation']);
  });

  it('refuses a revocation the account signed to pay for itself, or one that is paid for already', async () => {
    const selfPaid = await signRevocation(request(), ROOT_ACCOUNT, { feePayer: undefined, feeToken: TOKEN });
    expect(problemsOf(check(selfPaid))).toEqual(['the transaction is signed for the account to pay the fee itself, not for the fee sponsor to pay it']);
    // A fee payer of somebody's own choosing has signed: the rail's sponsor adds nothing to that.
    const complete = await signRevocation(request(), ROOT_ACCOUNT, { feePayer: Account.fromSecp256k1(generatePrivateKey()), feeToken: TOKEN });
    expect(complete).toMatch(/^0x76/);
    expect(problemsOf(check(complete))).toEqual(["the transaction already carries a fee payer's signature"]);
  });

  it('refuses a signature that is not the root key’s of the account', async () => {
    const stranger = Account.fromSecp256k1('0x8da4ef21b864d2cc526dbdb2a120bd2874c36c9d0a1fb7f8c63d7f7a8b41de8f');
    const theirs = await signRevocation(request(), stranger);
    expect(problemsOf(check(theirs))).toEqual([`the transaction is sent by ${stranger.address}, not by ${ROOT}`]);

    // The same transaction with the account's address written where the sender is named: the signature is still the stranger's.
    const { signature } = TxEnvelopeTempo.deserialize(theirs as TxEnvelopeTempo.Serialized);
    if (signature === undefined) throw new Error('the transaction is not signed');
    const relabelled = TxEnvelopeTempo.serialize(revocationEnvelope(request()), { format: 'feePayer', sender: ROOT, signature });
    expect(problemsOf(check(relabelled))).toEqual([`the transaction is not signed by the root key of ${ROOT}`]);

    // Signed by the right root, but over another nonce: the signature does not carry over.
    const elsewhere = TxEnvelopeTempo.deserialize((await signRevocation(request({ nonce: 9 }))) as TxEnvelopeTempo.Serialized).signature;
    if (elsewhere === undefined) throw new Error('the transaction is not signed');
    const transplanted = TxEnvelopeTempo.serialize(revocationEnvelope(request()), { format: 'feePayer', sender: ROOT, signature: elsewhere });
    expect(problemsOf(check(transplanted))).toEqual([`the transaction is not signed by the root key of ${ROOT}`]);
  });

  it('refuses the access key signing for the account: only the root takes a key back', async () => {
    const asAccount = Account.fromP256(key.privateKey, { access: ROOT });
    const serialized = await signRevocation(request(), asAccount);
    expect(problemsOf(check(serialized))).toEqual(['the transaction carries a keychain signature, which cannot be checked against the account; the root has to be a secp256k1 key or a passkey']);
  });

  it('refuses a revocation of another rail’s key, or for another account', async () => {
    const serialized = await signRevocation(request());
    expect(problemsOf(check(serialized, { accessKey: PAYEES[0] }))).toEqual([`the transaction revokes key ${key.address}, this rail's key is ${PAYEES[0]}`]);
    expect(problemsOf(check(serialized, { account: OUTSIDER }))).toEqual([`the transaction is sent by ${ROOT}, not by ${OUTSIDER}`]);
    expect(problemsOf(check(serialized, { chainId: 4217 }))).toEqual(['the transaction is for chain 42431, this rail runs on chain 4217']);
  });

  it('refuses what it cannot read', async () => {
    for (const serialized of ['0x', '0x1234', '0x76', '0x76zz', '0x02f86c', '0x78c0', 'nonsense'] as Hex[]) {
      expect(problemsOf(check(serialized)), serialized).toEqual([expect.stringContaining('the transaction cannot be read: ')]);
    }
    const unsigned = TxEnvelopeTempo.serialize(revocationEnvelope(request()));
    expect(problemsOf(check(unsigned))).toEqual(['the transaction is not signed']);
  });
});

describe('holding a signed revocation against the chain', () => {
  const facts = { now: START + 30, baseFeePerGas: BASE_FEE, nonce: 0, sponsor: sponsor.address, sponsorBalance: 1_000_000n };
  const signed = { nonce: 0, maxFeePerGas: 1_200_000_000n, validBefore: START + 120 };

  it('finds nothing wrong with a revocation that was just prepared', () => {
    expect(revocationProblems(signed, facts)).toEqual([]);
    // The base fee may move some between preparing and sending.
    expect(revocationProblems(signed, { ...facts, baseFeePerGas: 1_200_000_000n })).toEqual([]);
    expect(revocationProblems(signed, { ...facts, baseFeePerGas: 400_000_000n })).toEqual([]);
  });

  it('refuses one that has expired, or that would stay valid longer than a revocation is prepared for', () => {
    expect(revocationProblems(signed, { ...facts, now: START + 120 })).toEqual(['the transaction expired at 2026-10-10T13:48:40.000Z; prepare the revocation again']);
    expect(revocationProblems({ ...signed, validBefore: START + 86_400 }, facts)).toEqual(['the transaction stays valid until 2026-10-11T13:46:40.000Z, longer than the 120 s a revocation is prepared for']);
    // The latest deadline that is still within the window, and the first beyond it.
    expect(revocationProblems({ ...signed, validBefore: facts.now + 120 }, facts)).toEqual([]);
    expect(revocationProblems({ ...signed, validBefore: facts.now + 121 }, facts)).toHaveLength(1);
  });

  it('refuses a fee the base fee has outrun, and one beyond what the rail pays', () => {
    expect(revocationProblems(signed, { ...facts, baseFeePerGas: 1_200_000_001n })).toEqual(['the transaction offers 1200000000 per gas and the base fee is 1200000001 now; prepare the revocation again']);
    expect(revocationProblems({ ...signed, maxFeePerGas: 1_800_000_001n }, facts)).toEqual(['the transaction offers 1800000001 per gas, more than the 1800000000 this rail pays at a base fee of 600000000']);
    expect(revocationProblems({ ...signed, maxFeePerGas: 10n ** 30n }, facts)).toHaveLength(1);
    expect(revocationProblems({ ...signed, maxFeePerGas: 2n }, { ...facts, baseFeePerGas: 0n })).toEqual(['the transaction offers 2 per gas, more than the 1 this rail pays at a base fee of 0']);
  });

  it('refuses a nonce that is used or not yet due', () => {
    expect(revocationProblems(signed, { ...facts, nonce: 1 })).toEqual(['nonce 0 of the transaction is used already, the next of the account is 1; prepare the revocation again']);
    expect(revocationProblems({ ...signed, nonce: 4 }, facts)).toEqual(["nonce 4 of the transaction is ahead of the account's next, 0; prepare the revocation again"]);
  });

  it('refuses when the sponsor could not pay the most the transaction may cost', () => {
    // 600,000 gas at three times the base fee of 0.0000000006 dollars is 0.00108 dollars.
    const short = { ...facts, sponsorBalance: 1_079n };
    expect(sponsorProblem(short)).toBe(`fee sponsor ${sponsor.address} holds 0.001079 of the fee token, the fee may reach 0.00108`);
    expect(revocationProblems(signed, short)).toEqual([sponsorProblem(short)]);
    expect(sponsorProblem({ ...facts, sponsorBalance: 1_080n })).toBeNull();
  });
});

describe('the sponsor’s signature on a revocation', () => {
  it('pays for this sender’s transaction in the fee token, and leaves the root’s signature as it was', async () => {
    const checked = check(await signRevocation(request()));
    if (!checked.ok) throw new Error(checked.problems.join('; '));
    const { serialized, hash } = await sponsorRevocation({ envelope: checked.revocation.envelope, root: ROOT, feeToken: TOKEN, sponsor });
    expect(serialized).toMatch(/^0x76/);

    const final = TxEnvelopeTempo.deserialize(serialized as TxEnvelopeTempo.Serialized);
    expect(TxEnvelopeTempo.hash(final as TxEnvelopeTempo.Signed)).toBe(hash);
    expect(final.feeToken?.toString().toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(final.calls).toEqual(revocationEnvelope(request()).calls.map((call) => ({ to: call.to?.toLowerCase(), data: call.data })));
    if (final.signature === undefined || !final.feePayerSignature) throw new Error('a signature is missing');
    // The node checks the root's signature against the transaction without the fee token, as the root signed it.
    expect(SignatureEnvelope.verify(final.signature, { address: ROOT, payload: TxEnvelopeTempo.getSignPayload(final) })).toBe(true);
    expect(TxEnvelopeTempo.getSignPayload(final)).toBe(revocationSignPayload(request()));
    // The fee payer's covers the fee token and the sender, and is the sponsor's.
    const feePayerPayload = TxEnvelopeTempo.getFeePayerSignPayload(final, { sender: ROOT });
    expect(Secp256k1.recoverAddress({ payload: feePayerPayload, signature: final.feePayerSignature }).toLowerCase()).toBe(sponsor.address.toLowerCase());
    expect(Secp256k1.recoverAddress({ payload: TxEnvelopeTempo.getFeePayerSignPayload(final, { sender: OUTSIDER }), signature: final.feePayerSignature }).toLowerCase()).not.toBe(sponsor.address.toLowerCase());
  });

  it('gives the transaction the SDK builds when one process holds both keys', async () => {
    const checked = check(await signRevocation(request()));
    if (!checked.ok) throw new Error(checked.problems.join('; '));
    const ours = await sponsorRevocation({ envelope: checked.revocation.envelope, root: ROOT, feeToken: TOKEN, sponsor });
    const theirs = await signRevocation(request(), ROOT_ACCOUNT, { feePayer: sponsor, feeToken: TOKEN });
    expect(ours.serialized).toBe(theirs);
    expect(Transaction.deserialize(ours.serialized as `0x76${string}`)).toMatchObject({ chainId: CHAIN_ID, nonce: 0, gas: 600_000n, feeToken: TOKEN.toLowerCase(), validBefore: START + 120 });
  });
});

describe('the keychain’s record of a revocation', () => {
  const topic = toEventSelector('KeyRevoked(address,address)');
  const pad = (address: Address) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}` as Hex;
  const log = (over: { address?: Address; topics?: Hex[] } = {}): ChainLog => ({ address: Addresses.accountKeychain, topics: [topic, pad(ROOT), pad(key.address)], data: '0x' as Hex, logIndex: 0, transactionHash: `0x${'ab'.repeat(32)}` as Hex, blockNumber: 1n, ...over });

  it('is the KeyRevoked event of the keychain for this account and this key, and no other', () => {
    expect(keyRevokedIn([log()], ROOT, key.address)).toBe(true);
    expect(keyRevokedIn([], ROOT, key.address)).toBe(false);
    expect(keyRevokedIn([log()], OUTSIDER, key.address)).toBe(false);
    expect(keyRevokedIn([log()], ROOT, PAYEES[0])).toBe(false);
    // The same topics from a contract that is not the keychain, and the keychain's event for a key it authorized.
    expect(keyRevokedIn([log({ address: TOKEN })], ROOT, key.address)).toBe(false);
    expect(keyRevokedIn([log({ topics: [toEventSelector('KeyAuthorized(address,address,uint8,uint64)'), pad(ROOT), pad(key.address)] })], ROOT, key.address)).toBe(false);
  });
});

describe('revoking through the rail', () => {
  const everyCall: (keyof TempoChain)[] = ['assertChain', 'head', 'keyState', 'balanceOf', 'laneNonce', 'accountNonce', 'memoLogs', 'receipt', 'signPayout', 'signForced', 'signRevocation', 'broadcast', 'revertData'];

  /** A rail over a chain that holds its key live, and the revocation the root signed after asking what to sign. */
  async function prepared() {
    const made = setup();
    const preparation = await made.rail.prepareRevocation(ROOT);
    if (!preparation.ok) throw new Error(preparation.problems.join('; '));
    return { ...made, request: preparation.request, signedTransaction: await signRevocation(preparation.request) };
  }

  it('says what the root signs, as the chain stands now, and sends nothing', async () => {
    const { rail, chain, accessKey } = setup();
    chain.useOwnNonce();
    const preparation = await rail.prepareRevocation(ROOT);
    expect(preparation).toEqual({
      ok: true,
      request: {
        chainId: CHAIN_ID,
        accessKey: accessKey.address,
        nonce: 1,
        nonceKey: 0n,
        gas: 600_000n,
        maxFeePerGas: 1_200_000_000n,
        maxPriorityFeePerGas: 1n,
        feePayer: rail.sponsorAddress,
        feeToken: TOKEN,
        validBefore: chain.time + 120,
      },
    });
    expect([chain.signed, chain.revocations, chain.broadcasts]).toEqual([[], [], []]);
  });

  it('prepares the revocation of a live key the rail would not pay with: that one most of all', async () => {
    const { rail, chain } = setup();
    chain.key = { ...chain.key, enforceLimits: false, isScoped: false, scopes: [] };
    expect((await rail.keyStatus(ROOT)).authorized).toBe(false);
    expect((await rail.prepareRevocation(ROOT)).ok).toBe(true);
  });

  it('has nothing to prepare for a key that is revoked, unknown or expired, or for another account', async () => {
    const revoked = setup();
    revoked.chain.revoke();
    expect(await revoked.rail.prepareRevocation(ROOT)).toEqual({ ok: false, problems: [`access key ${revoked.accessKey.address} is already revoked on this account; there is nothing to revoke`] });

    const unknown = setup();
    unknown.chain.forget();
    expect(await unknown.rail.prepareRevocation(ROOT)).toEqual({ ok: false, problems: [`access key ${unknown.accessKey.address} is not authorized on this account; there is nothing to revoke`] });

    const expired = setup();
    expired.chain.time = START + 86_400;
    expect(await expired.rail.prepareRevocation(ROOT)).toEqual({ ok: false, problems: [`access key ${expired.accessKey.address} expired at 2026-10-11T13:46:40.000Z and can sign nothing; there is nothing to revoke`] });

    const { rail, accessKey } = setup();
    expect(await rail.prepareRevocation(OUTSIDER)).toEqual({ ok: false, problems: [`access key ${accessKey.address} is not authorized on this account; there is nothing to revoke`] });
    expect(await rail.prepareRevocation('nope')).toEqual({ ok: false, problems: ['account "nope" is not a valid address'] });
    expect((await rail.prepareRevocation(rail.sponsorAddress)).ok).toBe(false);
  });

  it('leaves a key the keychain holds with an expiry of zero for the root to take back, and does not read it as one that ran out', async () => {
    const { rail, chain, accessKey } = setup();
    // Not a state the keychain is known to report for a key it holds; whatever it means, the key is there and is not revoked.
    chain.key = { ...chain.key, expiry: 0n };
    expect(await rail.keyStatus(ROOT)).toMatchObject({ live: false, revoked: false, expiresAt: 0 });
    const preparation = await rail.prepareRevocation(ROOT);
    if (!preparation.ok) throw new Error(preparation.problems.join('; '));
    expect(preparation.request.accessKey).toBe(accessKey.address);
    expect(await rail.submitRevocation({ account: ROOT, signedTransaction: await signRevocation(preparation.request) })).toMatchObject({ ok: true });
    expect((await rail.keyStatus(ROOT)).revoked).toBe(true);
  });

  it('does not have the root sign what the sponsor could not pay to send', async () => {
    const { rail, chain } = setup();
    chain.sponsorBalance = 1_079n;
    expect(await rail.prepareRevocation(ROOT)).toEqual({ ok: false, problems: [`fee sponsor ${rail.sponsorAddress} holds 0.001079 of the fee token, the fee may reach 0.00108`] });
  });

  it('rejects when the chain cannot be read, since there is nothing to report', async () => {
    for (const method of ['assertChain', 'head', 'keyState', 'accountNonce', 'balanceOf'] as const) {
      const { rail, chain } = setup();
      chain.failing.add(method);
      await expect(rail.prepareRevocation(ROOT), method).rejects.toThrow(`${method} failed: fetch failed`);
    }
    const { rail, chain } = setup();
    chain.wrongChain = true;
    await expect(rail.prepareRevocation(ROOT)).rejects.toThrow('the RPC serves chain 4217');
  });

  it('sends the revocation the root signed, the sponsor paying, and reports it from the receipt', async () => {
    const { rail, chain, accessKey, request, signedTransaction } = await prepared();
    const result = await rail.submitRevocation({ account: ROOT, signedTransaction });
    expect(result).toEqual({ ok: true, tx: chain.broadcasts[0], error: null, gasUsed: 285_944n });
    expect(chain.broadcasts).toHaveLength(1);

    // What the sponsor signed for: the revocation rebuilt from the checked terms, with the root's signature.
    expect(chain.revocations).toHaveLength(1);
    expect(chain.revocations[0]).toMatchObject({ root: ROOT, accessKey: accessKey.address, nonce: 0, validBefore: request.validBefore });
    expect(chain.revocations[0]?.envelope).toMatchObject({ ...revocationEnvelope(request), signature: { type: 'secp256k1' } });

    // The account's own sequence moved; the payout lane did not.
    expect([chain.ownNonce, chain.nonce]).toEqual([1, 0]);
    expect(keyRevokedIn(chain.receipts.get(result.tx as Hex)?.logs ?? [], ROOT, accessKey.address)).toBe(true);
    expect(await rail.keyStatus(ROOT)).toMatchObject({ revoked: true, authorized: false, live: false, remaining: 0n });
    const RUN = 'HF-2026-10-0001';
    const paid = await rail.pay({ account: ROOT, lines: [line(RUN, 1, PAYEES[0], 1_000_000n)], runId: RUN });
    expect(paid).toMatchObject({ ok: false, tx: null });
    expect(paid.error).toContain('was revoked');
  });

  it('does the same for an account whose root is a passkey', async () => {
    const root = passkey();
    const { rail, chain, accessKey } = setup();
    chain.account = root.address;
    const preparation = await rail.prepareRevocation(root.address);
    if (!preparation.ok) throw new Error(preparation.problems.join('; '));
    const result = await rail.submitRevocation({ account: root.address, signedTransaction: await signRevocation(preparation.request, root) });
    expect(result).toMatchObject({ ok: true, tx: chain.broadcasts[0] });
    expect(chain.revocations[0]?.envelope.signature.type).toBe('webAuthn');
    expect(await rail.keyStatus(root.address)).toMatchObject({ accessKey: accessKey.address, revoked: true });
  });

  it('refuses anything but the revocation of its own key by the root, without asking the chain', async () => {
    const { rail, chain, accessKey, request } = await prepared();
    // Every chain call would fail: the refusals below are reached on the transaction alone.
    for (const method of everyCall) chain.failing.add(method);
    const stranger = Account.fromSecp256k1(generatePrivateKey());
    const other = generateAccessKey().address;
    const refused: [string, Hex, string][] = [
      ['a payment', await signRevocation(request, ROOT_ACCOUNT, { calls: [transferCall(TOKEN, OUTSIDER, 5_000_000n)] }), `the transaction's call is not revokeKey(${accessKey.address}) on the Account Keychain`],
      ['another key', await signRevocation(request, ROOT_ACCOUNT, { calls: [buildRevoke({ accessKeyAddress: other })] }), `the transaction revokes key ${other}, this rail's key is ${accessKey.address}`],
      ['the revocation and a payment', await signRevocation(request, ROOT_ACCOUNT, { calls: [buildRevoke({ accessKeyAddress: accessKey.address }), transferCall(TOKEN, OUTSIDER, 1n)] }), 'the transaction makes 2 calls, expected the revocation alone'],
      ['another account’s signature', await signRevocation(request, stranger), `the transaction is sent by ${stranger.address}, not by ${ROOT}`],
      ['a transaction the account pays for itself', await signRevocation(request, ROOT_ACCOUNT, { feePayer: undefined, feeToken: TOKEN }), 'the transaction is signed for the account to pay the fee itself, not for the fee sponsor to pay it'],
      ['another chain', await signRevocation(request, ROOT_ACCOUNT, { chainId: 4217 }), 'the transaction is for chain 4217, this rail runs on chain 42431'],
      ['a gas limit of its own', await signRevocation(request, ROOT_ACCOUNT, { gas: 30_000_000n }), 'the transaction carries a gas limit of 30000000, expected 600000'],
      ['nothing a node would take', '0x1234', 'the transaction cannot be read: it is not a Tempo transaction'],
    ];
    for (const [label, signedTransaction, message] of refused) {
      const result = await rail.submitRevocation({ account: ROOT, signedTransaction });
      expect(result, label).toEqual({ ok: false, tx: null, error: message, gasUsed: null });
    }
    expect((await rail.submitRevocation({ account: 'nope', signedTransaction: '0x' })).error).toBe('account "nope" is not a valid address');
    expect([chain.revocations, chain.broadcasts]).toEqual([[], []]);
  });

  it('refuses a revocation the chain has moved past: expired, its nonce used, its fee outrun', async () => {
    const late = await prepared();
    late.chain.time = late.request.validBefore;
    expect((await late.rail.submitRevocation({ account: ROOT, signedTransaction: late.signedTransaction })).error).toMatch(/^the transaction expired at 2026-10-10T.*; prepare the revocation again$/);

    const used = await prepared();
    used.chain.useOwnNonce();
    expect((await used.rail.submitRevocation({ account: ROOT, signedTransaction: used.signedTransaction })).error).toBe('nonce 0 of the transaction is used already, the next of the account is 1; prepare the revocation again');

    const dearer = await prepared();
    dearer.chain.baseFee = 1_300_000_000n;
    expect((await dearer.rail.submitRevocation({ account: ROOT, signedTransaction: dearer.signedTransaction })).error).toBe('the transaction offers 1200000000 per gas and the base fee is 1300000000 now; prepare the revocation again');

    for (const { chain } of [late, used, dearer]) expect([chain.revocations, chain.broadcasts]).toEqual([[], []]);
  });

  it('refuses terms of the root’s own making that the sponsor would pay for or wait on', async () => {
    const { rail, chain, request } = await prepared();
    const lavish = await signRevocation({ ...request, maxFeePerGas: 10n ** 24n });
    expect((await rail.submitRevocation({ account: ROOT, signedTransaction: lavish })).error).toBe('the transaction offers 1000000000000000000000000 per gas, more than the 1800000000 this rail pays at a base fee of 600000000');
    const patient = await signRevocation({ ...request, validBefore: START + 365 * 86_400 });
    expect((await rail.submitRevocation({ account: ROOT, signedTransaction: patient })).error).toMatch(/^the transaction stays valid until 2027-10-10T.*, longer than the 120 s a revocation is prepared for$/);
    chain.sponsorBalance = 0n;
    const unpaid = await rail.submitRevocation({ account: ROOT, signedTransaction: await signRevocation(request) });
    expect(unpaid.error).toBe(`fee sponsor ${rail.sponsorAddress} holds 0.00 of the fee token, the fee may reach 0.00108`);
    expect([chain.revocations, chain.broadcasts]).toEqual([[], []]);
  });

  it('sends nothing for a key that is no longer there to revoke', async () => {
    const gone = await prepared();
    gone.chain.revoke();
    expect(await gone.rail.submitRevocation({ account: ROOT, signedTransaction: gone.signedTransaction })).toEqual({
      ok: false,
      tx: null,
      error: `access key ${gone.accessKey.address} is already revoked on this account; there is nothing to revoke`,
      gasUsed: null,
    });
    expect(gone.chain.broadcasts).toEqual([]);

    // The same signed transaction a second time, after it went through.
    const twice = await prepared();
    expect((await twice.rail.submitRevocation({ account: ROOT, signedTransaction: twice.signedTransaction })).ok).toBe(true);
    const again = await twice.rail.submitRevocation({ account: ROOT, signedTransaction: twice.signedTransaction });
    expect(again).toMatchObject({ ok: false, tx: null });
    expect(again.error).toContain('is already revoked on this account');
    expect(twice.chain.broadcasts).toHaveLength(1);
  });

  it('reports a rejection by the node', async () => {
    const { rail, chain, signedTransaction } = await prepared();
    chain.broadcast = async () => ({ accepted: false, reason: 'fee payer balance insufficient: have 0 want 720' });
    expect(await rail.submitRevocation({ account: ROOT, signedTransaction })).toEqual({ ok: false, tx: null, error: 'the node rejected the transaction: fee payer balance insufficient: have 0 want 720', gasUsed: null });
    expect((await rail.keyStatus(ROOT)).revoked).toBe(false);
  });

  it('reports a transaction that was never included as expired, with its hash', async () => {
    const { rail, chain, request, signedTransaction } = await prepared();
    chain.onBroadcast = 'drop';
    const result = await rail.submitRevocation({ account: ROOT, signedTransaction });
    expect(result).toMatchObject({ ok: false, tx: chain.broadcasts[0], gasUsed: null });
    expect(result.error).toMatch(/^the transaction was not included before it expired at 2026-10-10T.*; it revoked nothing and can never be included$/);
    // It waited the two minutes of the revocation's own window out, and no longer.
    expect(chain.time).toBeGreaterThanOrEqual(request.validBefore);
    expect(chain.time).toBeLessThan(request.validBefore + 5);
    expect((await rail.keyStatus(ROOT)).revoked).toBe(false);
  });

  it('reports an unreachable node as expired once the window has closed, and finds a revocation whose answer was lost', async () => {
    const unreachable = await prepared();
    unreachable.chain.onBroadcast = 'unreachable';
    const result = await unreachable.rail.submitRevocation({ account: ROOT, signedTransaction: unreachable.signedTransaction });
    expect(result).toMatchObject({ ok: false, tx: unreachable.chain.broadcasts[0] });
    expect(result.error).toContain('(broadcast failed: fetch failed)');
    expect(result.error).toContain('it revoked nothing');

    const lost = await prepared();
    lost.chain.onBroadcast = 'lost';
    expect(await lost.rail.submitRevocation({ account: ROOT, signedTransaction: lost.signedTransaction })).toMatchObject({ ok: true, tx: lost.chain.broadcasts[0] });
  });

  it('says the outcome is unknown when the node stops answering, or shows the nonce used without a receipt', async () => {
    const silent = await prepared();
    const broadcast = silent.chain.broadcast.bind(silent.chain);
    silent.chain.broadcast = async (serialized) => {
      const sent = await broadcast(serialized);
      silent.chain.failing.add('receipt');
      return sent;
    };
    const result = await silent.rail.submitRevocation({ account: ROOT, signedTransaction: silent.signedTransaction });
    expect(result).toMatchObject({ ok: false, tx: silent.chain.broadcasts[0] });
    expect(result.error).toBe('the outcome is unknown (receipt failed: fetch failed); read the status of the key before preparing another revocation');
    // It did land: the key reads as revoked, which is what the caller is told to look at.
    silent.chain.failing.clear();
    expect((await silent.rail.keyStatus(ROOT)).revoked).toBe(true);

    const raced = await prepared();
    raced.chain.onBroadcast = 'drop';
    const head = raced.chain.head.bind(raced.chain);
    raced.chain.head = async () => {
      // Something of the root's own takes the nonce while the node shows no receipt for this hash.
      if (raced.chain.broadcasts.length === 1 && raced.chain.ownNonce === 0) raced.chain.useOwnNonce();
      return head();
    };
    const unknown = await raced.rail.submitRevocation({ account: ROOT, signedTransaction: raced.signedTransaction });
    expect(unknown.error).toContain('the outcome is unknown (the nonce was used but the node has no receipt for the transaction)');
  });

  it('turns a reverted receipt into a failure that names the reason', async () => {
    const { rail, chain, signedTransaction } = await prepared();
    const sign = chain.signRevocation.bind(chain);
    chain.signRevocation = async (tx) => {
      // The key leaves the account between the rail's read and the block.
      const signed = await sign(tx);
      chain.forget();
      return signed;
    };
    const result = await rail.submitRevocation({ account: ROOT, signedTransaction });
    expect(result).toEqual({ ok: false, tx: chain.broadcasts[0], error: 'the transaction reverted on chain and revoked nothing (KeyNotFound: the access key is not authorized on this account)', gasUsed: 285_944n });
    expect(chain.receipts.get(result.tx as Hex)?.status).toBe('reverted');
    expect(KEY_NOT_FOUND).toMatch(/^0x[0-9a-f]{8}$/);
  });

  it('does not report success unless the receipt shows the keychain revoking the key', async () => {
    const { rail, chain, signedTransaction } = await prepared();
    chain.tamper = (logs) => logs.filter((log) => log.address !== Addresses.accountKeychain);
    const result = await rail.submitRevocation({ account: ROOT, signedTransaction });
    expect(result).toMatchObject({ ok: false, tx: chain.broadcasts[0], gasUsed: 285_944n });
    expect(result.error).toBe('the transaction succeeded but its receipt does not show the keychain revoking the key');
  });

  it('asks for the nonce again when the node that answers has not reached the head yet, and gives up after a few times', async () => {
    const { rail, chain } = setup();
    const accountNonce = chain.accountNonce.bind(chain);
    let short = 0;
    const reads: (bigint | undefined)[] = [];
    chain.accountNonce = async (root, atBlock) => {
      reads.push(atBlock);
      // Behind a load balancer, the node that serves this read may be a block short of the one that served the head.
      if (short > 0) {
        short -= 1;
        throw Object.assign(new Error(`block not found: 0x${atBlock?.toString(16)}`), { code: -32001 });
      }
      return accountNonce(root, atBlock);
    };

    short = 2;
    const preparation = await rail.prepareRevocation(ROOT);
    if (!preparation.ok) throw new Error(preparation.problems.join('; '));
    // Three reads, every one of them as of the same block: the answer is never older than the head it goes with.
    expect(reads).toHaveLength(3);
    expect(new Set(reads).size).toBe(1);
    expect(reads[0]).toBe(chain.block);

    short = 3;
    expect(await rail.submitRevocation({ account: ROOT, signedTransaction: await signRevocation(preparation.request) })).toMatchObject({ ok: true });

    // A node that stays behind is a read that failed: nothing is prepared, and nothing sent, on a nonce nobody could read.
    const behind = setup();
    behind.chain.accountNonce = async (_root, atBlock) => {
      throw Object.assign(new Error(`block not found: 0x${atBlock?.toString(16)}`), { code: -32001 });
    };
    await expect(behind.rail.prepareRevocation(ROOT)).rejects.toThrow('block not found');
    const late = await prepared();
    late.chain.accountNonce = behind.chain.accountNonce;
    const result = await late.rail.submitRevocation({ account: ROOT, signedTransaction: late.signedTransaction });
    expect(result).toMatchObject({ ok: false, tx: null });
    expect(result.error).toContain('block not found');
    expect(late.chain.broadcasts).toEqual([]);
  });

  it('never throws, whatever fails underneath', async () => {
    for (const method of ['assertChain', 'head', 'keyState', 'accountNonce', 'balanceOf', 'signRevocation', 'broadcast', 'receipt', 'revertData'] as const) {
      const { rail, chain, signedTransaction } = await prepared();
      chain.failing.add(method);
      const result = await rail.submitRevocation({ account: ROOT, signedTransaction });
      // Reading a revert reason is the one of these a successful revocation never needs.
      expect(result.ok, method).toBe(method === 'revertData');
      if (method !== 'revertData') expect(result.error, method).toContain('fetch failed');
    }
  });

  it('does not wait behind a payout that is on its way', async () => {
    const { rail, chain, signedTransaction } = await prepared();
    const RUN = 'HF-2026-10-0001';
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const signPayout = chain.signPayout.bind(chain);
    chain.signPayout = async (tx) => {
      await held;
      return signPayout(tx);
    };
    const paying = rail.pay({ account: ROOT, lines: [line(RUN, 1, PAYEES[0], 1_000_000n)], runId: RUN });
    // The payout is stuck before it is signed; the revocation goes through all the same.
    expect(await rail.submitRevocation({ account: ROOT, signedTransaction })).toMatchObject({ ok: true });
    release();
    // And the payout that was on its way is refused by the node, the key being gone.
    expect(await paying).toMatchObject({ ok: false });
  });
});
