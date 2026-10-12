import { hedgeAttestorAbi } from '@holdfast/attest';
import type { PgliteConnection } from '@holdfast/db';
import { generateAccessKey, readSignedAuthorization, revocationSignPayload } from '@holdfast/tempo';
import { parsePaymentUri } from '@holdfast/zcash';
import { getWallets } from '@wallet-standard/app';
import { decodeFunctionData, encodeFunctionData, erc20Abi, getAddress } from 'viem';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Api, createApi } from '../../src/client/api';
import { registerAttester, startAttestationSeries, waitForAttester } from '../../src/client/attestor';
import { ClientError } from '../../src/client/errors';
import { type EvmConnection, connectEvmWallet } from '../../src/client/evm';
import { approveHyperliquidAgent } from '../../src/client/hyperliquid';
import { encodeQr } from '../../src/client/qr';
import { readSession, signIn, signOut } from '../../src/client/session';
import { type SolanaWallet, approveSolanaDelegate, base58Encode, connectSolanaWallet, readSolanaTransaction, revokeSolanaDelegate, waitForSolanaAllowance, watchSolanaWallets } from '../../src/client/solana';
import { createSessionStore } from '../../src/client/stores';
import { authorizeTempoAccessKey, checkedRevokeFields, createTempoAccount, revokeTempoAccessKey, signTempoAuthorization, signTempoRevoke, storedPasskey, tempoGrant, tempoRoot } from '../../src/client/tempo';
import { zcashPaymentRequest } from '../../src/client/zcash';
import { solanaPort } from '../../src/server/adapters/solana';
import { buildDelegateApproval, buildDelegateRevoke } from '../../src/server/adapters/solana-package.js';
import { ORIGIN, PAYEES, START, STARTUP_TIMEOUT_MS, UFVK, type World, keyAddress, migratedPglite, newAccount, world } from '../support/world';
import { type App, app } from './support/app';
import { FakeEvmWallet, fakeSolanaWallet, fakeWindow, softwareAuthenticator } from './support/wallets';

/**
 * The flows from end to end: the client on one side, and on the other the
 * application's own endpoints over its real store, with the chains and the
 * venue faked the way the server's own tests fake them. Nothing here answers
 * for the server; what the client sends is what the server takes or refuses.
 */

let database: PgliteConnection;
let w: World;

beforeAll(async () => {
  database = await migratedPglite();
}, STARTUP_TIMEOUT_MS);

afterAll(() => database.close());

beforeEach(() => {
  w = world(database);
});

afterEach(() => vi.unstubAllGlobals());

async function failure(promise: Promise<unknown>): Promise<ClientError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ClientError) return error;
    throw error;
  }
  throw new Error('expected a failure');
}

interface Treasurer {
  account: ReturnType<typeof newAccount>;
  provider: FakeEvmWallet;
  connection: EvmConnection;
  served: App;
  api: Api;
}

/** A treasurer with a wallet, on the application's own pages, not signed in yet. */
async function treasurer(chainId = 42_161): Promise<Treasurer> {
  const account = newAccount();
  const provider = new FakeEvmWallet([account], chainId);
  const connection = await connectEvmWallet({ id: 'test', name: 'Test Wallet', icon: null, rdns: 'test.wallet', provider });
  const served = app(w);
  return { account, provider, connection, served, api: createApi({ fetch: served.fetch }) };
}

/** The same, signed in and with an organisation registered through the API. */
async function withOrganisation(chainId = 42_161) {
  const t = await treasurer(chainId);
  await signIn(t.connection, { api: t.api, origin: ORIGIN, now: w.clock.now });
  const org = await t.api.createOrg({ name: 'Acme Labs', ufvk: UFVK, birthday: 3_512_000, monthlyBurnUsd: 42_500 });
  return { ...t, org };
}

describe('signing in', () => {
  it('takes a challenge, has the wallet sign the message for it, and holds a session afterwards', async () => {
    const t = await treasurer(8_453);
    expect(await readSession({ api: t.api })).toBeNull();

    const me = await signIn(t.connection, { api: t.api, origin: ORIGIN, now: w.clock.now });
    expect(me).toEqual({ address: t.account.address.toLowerCase(), expiresAt: expect.any(Number), orgs: [] });
    expect(t.served.signedIn()).toBe(true);
    expect(t.served.calls.map((call) => `${call.method} ${call.pattern} ${call.status}`)).toEqual(['GET /api/auth/me 401', 'GET /api/auth/nonce 200', 'POST /api/auth/verify 200', 'GET /api/auth/me 200']);

    // One signature, by personal_sign, over a message for this site and the wallet's chain.
    expect(t.provider.count('personal_sign')).toBe(1);
    const { message } = t.served.calls[2]?.body as { message: string };
    expect(message).toContain(`app.holdfast.test wants you to sign in with your Ethereum account:\n${t.account.address}\n`);
    expect(message).toContain(`URI: ${ORIGIN}\nVersion: 1\nChain ID: 8453\n`);

    expect(await readSession({ api: t.api })).toEqual(me);
    await signOut({ api: t.api });
    expect(t.served.signedIn()).toBe(false);
    expect(await readSession({ api: t.api })).toBeNull();
  });

  it('signs in whatever the clock of the browser says', async () => {
    // The world's clock is not the machine's: the message is dated by the machine and still taken.
    const t = await treasurer();
    const me = await signIn(t.connection, { api: t.api, origin: ORIGIN });
    expect(me.address).toBe(t.account.address.toLowerCase());
    const fast = await treasurer();
    expect((await signIn(fast.connection, { api: fast.api, origin: ORIGIN, now: () => w.clock.now() + 5 * 3_600_000 })).address).toBe(fast.account.address.toLowerCase());
  });

  it('does not ask the wallet for a signature the server would refuse: a page on another host', async () => {
    const t = await treasurer();
    const error = await failure(signIn(t.connection, { api: t.api, origin: 'https://holdfast-preview.example' }));
    expect({ code: error.code, message: error.message }).toEqual({ code: 'wrong_site', message: 'this page is served from holdfast-preview.example, and the service signs in for app.holdfast.test' });
    expect(t.provider.count('personal_sign')).toBe(0);
    expect(t.served.signedIn()).toBe(false);
  });

  it('reads the page’s origin from the window when it is not given', async () => {
    vi.stubGlobal('window', fakeWindow(ORIGIN));
    const t = await treasurer();
    expect((await signIn(t.connection, { api: t.api, now: w.clock.now })).address).toBe(t.account.address.toLowerCase());
  });

  it('leaves nobody signed in when the treasurer declines, and passes on why the server refused', async () => {
    const t = await treasurer();
    t.provider.failNext = { code: 4001, message: 'User rejected the request.' };
    expect((await failure(signIn(t.connection, { api: t.api, origin: ORIGIN, now: w.clock.now }))).code).toBe('wallet_rejected');
    expect(t.served.signedIn()).toBe(false);
    expect(t.served.calls.some((call) => call.pattern === '/api/auth/verify')).toBe(false);

    // A wallet that signs with another key than the account it shows: the server's refusal comes through as it is.
    const stranger = newAccount();
    const lying = { request: async (args: { method: string; params?: unknown }) => (args.method === 'personal_sign' ? stranger.signMessage({ message: { raw: (args.params as [`0x${string}`])[0] } }) : t.provider.request(args)) };
    const connection = await connectEvmWallet({ id: 'lying', name: 'Lying Wallet', icon: null, rdns: null, provider: lying });
    const refused = await failure(signIn(connection, { api: t.api, origin: ORIGIN, now: w.clock.now }));
    expect({ status: refused.status, code: refused.code, message: refused.message }).toEqual({ status: 401, code: 'sign_in_failed', message: 'sign-in failed: the signature is not that of the address in the message' });
    expect(t.served.signedIn()).toBe(false);
  });

  it('is kept by the session store, which asks the server once and follows signing in and out', async () => {
    const t = await treasurer();
    const store = createSessionStore({ api: t.api, origin: ORIGIN });
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.get().status));
    expect(store.get()).toEqual({ status: 'loading', session: null, error: null });
    expect(store.initial).toEqual({ status: 'loading', session: null, error: null });

    store.load();
    store.load();
    await vi.waitFor(() => expect(store.get().status).toBe('signed-out'));
    expect(t.served.calls.filter((call) => call.pattern === '/api/auth/me')).toHaveLength(1);

    const me = await store.signIn(t.connection);
    expect(store.get()).toEqual({ status: 'signed-in', session: me, error: null });
    await store.refresh();
    expect(store.get().session?.address).toBe(t.account.address.toLowerCase());
    await store.signOut();
    expect(store.get()).toEqual({ status: 'signed-out', session: null, error: null });
    expect(seen).toEqual(['signed-out', 'signed-in', 'signed-in', 'signed-out']);

    // A failed sign-in changes nothing about who is signed in, and is the caller's to hear of.
    t.provider.failNext = { code: 4001, message: 'User rejected the request.' };
    await expect(store.signIn(t.connection)).rejects.toMatchObject({ code: 'wallet_rejected' });
    expect(store.get().status).toBe('signed-out');
  });
});

describe('approving the Hyperliquid agent', () => {
  it('signs the approval on whichever chain the wallet is on, and the server hands it to Hyperliquid', async () => {
    // Base: not the chain the server would pick by itself.
    const { provider, connection, api, served, org, account } = await withOrganisation(8_453);
    const agent = await keyAddress(w, org.id, 'hl_agent');
    expect(org.serviceKeys.find((key) => key.kind === 'hl_agent')?.address).toBe(agent);
    const validUntil = w.clock.now() + 30 * 86_400_000;

    const approval = await approveHyperliquidAgent(connection, org.id, { api, validUntil });
    expect(approval).toEqual({ approved: true, agentAddress: agent });

    // The data was asked for the wallet's chain, and the same chain went back with the signature.
    const asked = served.calls.find((call) => call.method === 'GET' && call.pattern === '/api/orgs/[orgId]/hyperliquid/approval');
    expect(asked?.url).toBe(`/api/orgs/${org.id}/hyperliquid/approval?chainId=8453&validUntil=${validUntil}`);
    const submitted = served.calls.find((call) => call.method === 'POST' && call.pattern === '/api/orgs/[orgId]/hyperliquid/approval');
    expect(submitted?.body).toEqual({ nonce: w.clock.now(), signature: expect.stringMatching(/^0x[0-9a-f]{130}$/), signatureChainId: 8_453, validUntil });

    expect(provider.count('eth_signTypedData_v4')).toBe(1);
    expect(provider.count('wallet_switchEthereumChain')).toBe(0);
    // What reached the venue: the approval of this agent by this account, bound to the wallet's chain.
    expect(w.exchange.calls).toHaveLength(1);
    expect(w.exchange.calls[0]).toMatchObject({
      nonce: w.clock.now(),
      action: { type: 'approveAgent', hyperliquidChain: 'Mainnet', signatureChainId: '0x2105', agentAddress: agent, agentName: `holdfast valid_until ${validUntil}` },
    });
    expect(account.address.toLowerCase()).toBe(org.owner);
  });

  it('follows the wallet to a chain it moved to, and needs no expiry', async () => {
    const { provider, connection, api, org } = await withOrganisation(42_161);
    provider.selectChain(10);
    expect(await approveHyperliquidAgent(connection, org.id, { api })).toMatchObject({ approved: true });
    expect(w.exchange.calls[0]).toMatchObject({ action: { signatureChainId: '0xa', agentName: 'holdfast' } });
  });

  it('opens no wallet that holds another account than the owner’s', async () => {
    const { provider, connection, api, served, org } = await withOrganisation();
    provider.selectAccounts([newAccount()]);
    const error = await failure(approveHyperliquidAgent(connection, org.id, { api }));
    expect(error.code).toBe('wrong_account');
    expect(error.message).toContain(org.owner);
    expect(provider.count('eth_signTypedData_v4')).toBe(0);
    expect(served.calls.some((call) => call.pattern === '/api/orgs/[orgId]/hyperliquid/approval')).toBe(false);
    expect(w.exchange.calls).toEqual([]);
  });

  it('passes on what Hyperliquid said when it turned the approval down, and sends nothing a second time', async () => {
    const { provider, connection, api, org } = await withOrganisation();
    w.exchange.answer = () => ({ status: 'err', response: 'Extra agent already used.' });
    const refused = await failure(approveHyperliquidAgent(connection, org.id, { api }));
    expect({ status: refused.status, code: refused.code, message: refused.message }).toEqual({ status: 409, code: 'refused', message: 'Hyperliquid refused the approval: Extra agent already used.' });
    expect(w.exchange.calls).toHaveLength(1);

    provider.failNext = { code: 4001, message: 'User rejected the request.' };
    expect((await failure(approveHyperliquidAgent(connection, org.id, { api }))).code).toBe('wallet_rejected');
    expect(w.exchange.calls).toHaveLength(1);
  });

  it('passes on no signature that is not the owner’s, whatever the wallet answered with', async () => {
    const { provider, account, api, served, org } = await withOrganisation();
    // A wallet that shows the owner's account and signs with another key.
    const stranger = newAccount();
    const lying = {
      request: async (args: { method: string; params?: unknown }) => {
        if (args.method !== 'eth_signTypedData_v4') return provider.request(args);
        const { domain, types, primaryType, message } = JSON.parse((args.params as [string, string])[1]) as { domain: object; types: Record<string, unknown>; primaryType: string; message: object };
        const { EIP712Domain: _, ...rest } = types;
        return stranger.signTypedData({ domain, types: rest, primaryType, message } as Parameters<typeof stranger.signTypedData>[0]);
      },
    };
    const connection = await connectEvmWallet({ id: 'lying', name: 'Lying Wallet', icon: null, rdns: null, provider: lying });
    const error = await failure(approveHyperliquidAgent(connection, org.id, { api }));
    expect(error.code).toBe('wrong_account');
    expect(error.message).toContain(`the wallet signed as ${stranger.address}`);
    expect(error.message).toContain(account.address.toLowerCase());
    // The server never saw it, and neither did the venue.
    expect(served.calls.some((call) => call.method === 'POST' && call.pattern === '/api/orgs/[orgId]/hyperliquid/approval')).toBe(false);
    expect(w.exchange.calls).toEqual([]);
  });

  it('signs for the Hyperliquid the organisation’s deployment is on, with no word from the page', async () => {
    const { provider, connection, api, served, org } = await withOrganisation();
    expect(org.network).toBe('mainnet');

    // The organisation says testnet, and the approval the server prepared is for mainnet: it is not signed.
    w.deps.network = 'testnet';
    const other = await failure(approveHyperliquidAgent(connection, org.id, { api }));
    expect({ code: other.code, message: other.message }).toEqual({ code: 'unexpected_request', message: 'the approval the server prepared is for Hyperliquid Mainnet, not Testnet; nothing was signed' });
    w.deps.network = 'mainnet';

    // An organisation that names no network is not signed for on the strength of what the approval itself says.
    const silent = createApi({
      fetch: async (input, init) => {
        const response = await served.fetch(input, init);
        if (String(input) !== `/api/orgs/${org.id}`) return response;
        const { network: _, ...rest } = (await response.json()) as Record<string, unknown>;
        return Response.json(rest);
      },
    });
    const unnamed = await failure(approveHyperliquidAgent(connection, org.id, { api: silent }));
    expect({ code: unnamed.code, message: unnamed.message }).toEqual({ code: 'unexpected_request', message: 'the organisation does not say which Hyperliquid its deployment trades on; nothing was signed' });
    expect(provider.count('eth_signTypedData_v4')).toBe(0);
    expect(w.exchange.calls).toEqual([]);

    expect(await approveHyperliquidAgent(connection, org.id, { api })).toMatchObject({ approved: true });
    expect(w.exchange.calls).toHaveLength(1);
    expect(w.exchange.calls[0]).toMatchObject({ action: { type: 'approveAgent', hyperliquidChain: 'Mainnet' } });
  });

  it('signs for the Hyperliquid the page says it is on, where the page knows', async () => {
    const { provider, connection, api, org } = await withOrganisation();
    // The world runs on mainnet.
    expect((await failure(approveHyperliquidAgent(connection, org.id, { api, network: 'Testnet' }))).code).toBe('unexpected_request');
    expect(provider.count('eth_signTypedData_v4')).toBe(0);
    expect(await approveHyperliquidAgent(connection, org.id, { api, network: 'Mainnet' })).toMatchObject({ approved: true });
  });

  it('is refused for somebody else’s organisation the way the server refuses it', async () => {
    const owner = await withOrganisation();
    const stranger = await treasurer();
    await signIn(stranger.connection, { api: stranger.api, origin: ORIGIN, now: w.clock.now });
    const error = await failure(approveHyperliquidAgent(stranger.connection, owner.org.id, { api: stranger.api }));
    expect({ status: error.status, code: error.code }).toEqual({ status: 404, code: 'not_found' });
    expect(stranger.provider.count('eth_signTypedData_v4')).toBe(0);
  });
});

describe('the Tempo account and its access key', () => {
  const TERMS = { limit: 10_000_000n, periodSeconds: 3_600, expiry: START + 86_400, recipients: [...PAYEES] };

  it('creates the passkey account, records it, and has its root sign what the server asks for', async () => {
    const page = fakeWindow(ORIGIN);
    vi.stubGlobal('window', page);
    const authenticator = softwareAuthenticator(ORIGIN);
    const { api, served, org } = await withOrganisation();
    expect(org.tempoAccount).toBeNull();

    const { passkey, org: updated } = await createTempoAccount(org.id, { label: 'Acme Labs payroll', createFn: authenticator.createFn, api });
    expect(updated.tempoAccount).toBe(passkey.address);
    expect((await api.getOrg(org.id)).tempoAccount).toBe(passkey.address);
    expect((await api.tempoRail(org.id)).account).toBe(passkey.address);
    expect(storedPasskey(passkey.address)).toEqual(passkey);

    // The root signs what the server asks for, once, and the server provisions the key with it.
    const root = tempoRoot(passkey, { getFn: authenticator.getFn });
    const accessKey = await keyAddress(w, org.id, 'tempo_access');
    const result = await authorizeTempoAccessKey(root, org.id, TERMS, { api });
    expect(result).toEqual({ authorized: true, tx: expect.stringMatching(/^0x[0-9a-f]{64}$/), txUrl: `https://explore.testnet.tempo.xyz/tx/${result.tx}`, sent: true });
    expect(authenticator.asserted).toHaveLength(1);
    expect(served.calls.slice(-2).map((call) => `${call.method} ${call.pattern} ${call.status}`)).toEqual([
      'POST /api/orgs/[orgId]/rails/tempo/authorization 200',
      'POST /api/orgs/[orgId]/rails/tempo/authorization/submit 200',
    ]);
    // What was signed is for the key, the token and the chain the organisation's own rail shows.
    expect(await tempoGrant(passkey.address, org.id, { api })).toEqual({ accessKey, token: w.deps.tempo.token, chainId: 42_431 });

    // The rail checked the authorization against the account before sending: what went to the chain is the passkey's own.
    const [provisioned] = w.tempoChain(accessKey).signed;
    expect(provisioned?.root).toBe(passkey.address);
    expect(provisioned?.keyAuthorization).toMatchObject({ address: accessKey.toLowerCase(), chainId: 42_431n, expiry: TERMS.expiry, limits: [{ limit: 10_000_000n, period: 3_600 }], signature: { type: 'webAuthn' } });
    const submitted = served.calls.find((call) => call.pattern === '/api/orgs/[orgId]/rails/tempo/authorization/submit')?.body as { terms: unknown; signedWire: `0x${string}` };
    expect(submitted.terms).toEqual({ limit: '10000000', periodSeconds: 3_600, expiry: TERMS.expiry, recipients: [...PAYEES] });
    expect(readSignedAuthorization(submitted.signedWire).signed.signature.type).toBe('webAuthn');
  });

  it('is turned down by the server when the signature is another passkey’s, and never signs other terms', async () => {
    vi.stubGlobal('window', fakeWindow(ORIGIN));
    const authenticator = softwareAuthenticator(ORIGIN);
    const { api, org } = await withOrganisation();
    const { passkey } = await createTempoAccount(org.id, { label: 'Acme Labs payroll', createFn: authenticator.createFn, api });
    const request = await api.tempoAuthorization(org.id, TERMS);
    const grant = await tempoGrant(passkey.address, org.id, { api });

    // Another passkey of the same treasurer signs the same digest: the server will not have it for this account.
    const other = await createTempoAccount('some-other-organisation', { label: 'Other', createFn: authenticator.createFn, api: createApi({ fetch: async () => Response.json({ tempoAccount: null }) }) });
    const forged = await signTempoAuthorization(tempoRoot(other.passkey, { getFn: authenticator.getFn }), request, grant, TERMS);
    const refused = await failure(api.submitTempoAuthorization(org.id, { terms: TERMS, signedWire: forged }));
    expect({ status: refused.status, code: refused.code }).toEqual({ status: 409, code: 'refused' });
    expect(refused.message).toContain(`not signed by the root key of ${passkey.address}`);
    // And the flow itself does not let a passkey sign for an organisation whose account it is not the root of.
    const before = authenticator.asserted.length;
    expect((await failure(authorizeTempoAccessKey(tempoRoot(other.passkey, { getFn: authenticator.getFn }), org.id, TERMS, { api }))).code).toBe('wrong_account');

    // The treasurer set a limit of ten; the page asks for the terms it shows and signs no others.
    const root = tempoRoot(passkey, { getFn: authenticator.getFn });
    expect((await failure(signTempoAuthorization(root, request, grant, { ...TERMS, limit: 5_000_000n }))).code).toBe('unexpected_request');
    expect(authenticator.asserted).toHaveLength(before);
    // Terms the server will not build an authorization for never reach the passkey: an expiry given in milliseconds.
    await expect(authorizeTempoAccessKey(root, org.id, { ...TERMS, expiry: (START + 86_400) * 1_000 }, { api })).rejects.toMatchObject({ status: 400, code: 'invalid_input' });
    expect(authenticator.asserted).toHaveLength(before);
  });

  /** A treasurer whose passkey account has authorized the organisation's access key, over a chain that holds the key on that account. */
  async function withAuthorizedKey() {
    vi.stubGlobal('window', fakeWindow(ORIGIN));
    const authenticator = softwareAuthenticator(ORIGIN);
    const t = await withOrganisation();
    const { passkey } = await createTempoAccount(t.org.id, { label: 'Acme Labs payroll', createFn: authenticator.createFn, api: t.api });
    const accessKey = await keyAddress(w, t.org.id, 'tempo_access');
    const chain = w.tempoChain(accessKey);
    chain.account = passkey.address;
    chain.forget();
    const root = tempoRoot(passkey, { getFn: authenticator.getFn });
    await authorizeTempoAccessKey(root, t.org.id, TERMS, { api: t.api });
    expect((await t.api.tempoRail(t.org.id)).key).toMatchObject({ status: 'ok', value: { authorized: true, revoked: false } });
    return { ...t, authenticator, passkey, root, accessKey, chain };
  }

  it('takes the access key back with one passkey signature, the service paying, and reads it revoked from the chain', async () => {
    const { api, served, org, authenticator, passkey, root, accessKey, chain } = await withAuthorizedKey();
    const prompts = authenticator.asserted.length;
    const sentBefore = chain.broadcasts.length;

    const revoked = await revokeTempoAccessKey(root, org.id, { api });
    expect(revoked).toEqual({ tx: expect.stringMatching(/^0x[0-9a-f]{64}$/), txUrl: `https://explore.testnet.tempo.xyz/tx/${revoked.tx}` });
    expect(served.calls.slice(-2).map((call) => `${call.method} ${call.pattern} ${call.status}`)).toEqual([
      'POST /api/orgs/[orgId]/rails/tempo/revoke 200',
      'POST /api/orgs/[orgId]/rails/tempo/revoke/submit 200',
    ]);
    expect(served.calls.at(-1)?.body).toEqual({ signedTransaction: expect.stringMatching(/^0x78[0-9a-f]+$/) });

    // One transaction went to the chain, for this account and this key, and the sponsor signed for nothing else.
    expect(chain.broadcasts).toHaveLength(sentBefore + 1);
    expect(chain.broadcasts.at(-1)).toBe(revoked.tx);
    const [sent] = chain.revocations;
    if (sent === undefined) throw new Error('nothing was handed to the sponsor');
    expect(chain.revocations).toHaveLength(1);
    expect(sent).toMatchObject({ root: passkey.address, accessKey, nonce: 0, envelope: { signature: { type: 'webAuthn' } } });

    // One prompt, for this credential on this site, over the digest of the revocation of the organisation's key.
    expect(authenticator.asserted).toHaveLength(prompts + 1);
    expect(authenticator.asserted.at(-1)).toMatchObject({ rpId: 'app.holdfast.test', credentialId: passkey.credentialId });
    const digest = revocationSignPayload({ chainId: 42_431, accessKey: accessKey as `0x${string}`, nonce: 0, gas: 600_000n, maxFeePerGas: 1_200_000_000n, maxPriorityFeePerGas: 1n, validBefore: sent.validBefore });
    expect(`0x${Buffer.from(authenticator.asserted.at(-1)?.challenge ?? []).toString('hex')}`).toBe(digest);

    // The server's word is not taken for it either: the rail reads the key from the chain.
    expect((await api.tempoRail(org.id)).key).toMatchObject({ status: 'ok', source: 'tempo', value: { accessKey, revoked: true, authorized: false, live: false } });

    // There is nothing to revoke a second time, and the passkey is not asked.
    const again = await failure(revokeTempoAccessKey(root, org.id, { api }));
    expect({ status: again.status, code: again.code, message: again.message }).toEqual({ status: 409, code: 'refused', message: `access key ${accessKey} is already revoked on this account; there is nothing to revoke` });
    expect(authenticator.asserted).toHaveLength(prompts + 1);
    expect(chain.broadcasts).toHaveLength(sentBefore + 1);
  });

  it('signs no revocation but that of the organisation’s own key, and the server sends none that is anything else', async () => {
    const { api, served, org, authenticator, passkey, root, accessKey, chain } = await withAuthorizedKey();
    const prompts = authenticator.asserted.length;
    const sentBefore = chain.broadcasts.length;
    const another = generateAccessKey().address;

    // The application as it is, but for the key its revocation names: the passkey is never asked.
    const lying = createApi({
      fetch: async (input, init) => {
        const response = await served.fetch(input, init);
        if (!String(input).endsWith('/rails/tempo/revoke')) return response;
        return Response.json({ ...((await response.json()) as object), accessKey: another });
      },
    });
    const unsigned = await failure(revokeTempoAccessKey(root, org.id, { api: lying }));
    expect({ code: unsigned.code, message: unsigned.message }).toEqual({ code: 'unexpected_request', message: 'the revocation the server prepared is not for the access key of this organisation; nothing was signed' });
    expect(authenticator.asserted).toHaveLength(prompts);

    // What the passkey can be made to sign outside the flow, the server does not send.
    const fields = checkedRevokeFields(await api.tempoRevoke(org.id), await tempoGrant(passkey.address, org.id, { api }));
    const otherKey = await failure(api.submitTempoRevoke(org.id, { signedTransaction: await signTempoRevoke(root, { ...fields, accessKey: another }) }));
    expect({ status: otherKey.status, code: otherKey.code, message: otherKey.message }).toEqual({ status: 409, code: 'refused', message: `the transaction revokes key ${another}, this rail's key is ${accessKey}` });

    const { feePayer: _, ...selfPaid } = fields;
    const unsponsored = await failure(api.submitTempoRevoke(org.id, { signedTransaction: await signTempoRevoke(root, { ...selfPaid, feeToken: w.deps.tempo.token }) }));
    expect(unsponsored.message).toBe('the transaction is signed for the account to pay the fee itself, not for the fee sponsor to pay it');

    // Another passkey of the same treasurer signs the very revocation: it is not the root of this account.
    const other = await createTempoAccount('some-other-organisation', { label: 'Other', createFn: authenticator.createFn, api: createApi({ fetch: async () => Response.json({ tempoAccount: null }) }) });
    const forged = await failure(api.submitTempoRevoke(org.id, { signedTransaction: await signTempoRevoke(tempoRoot(other.passkey, { getFn: authenticator.getFn }), fields) }));
    expect({ status: forged.status, message: forged.message }).toEqual({ status: 409, message: `the transaction is sent by ${other.passkey.address}, not by ${passkey.address}` });
    // And the flow itself does not let that passkey try.
    expect((await failure(revokeTempoAccessKey(tempoRoot(other.passkey, { getFn: authenticator.getFn }), org.id, { api }))).code).toBe('wrong_account');

    expect([chain.revocations, chain.broadcasts.length]).toEqual([[], sentBefore]);
    expect((await api.tempoRail(org.id)).key).toMatchObject({ status: 'ok', value: { authorized: true, revoked: false } });
  });

  it('is given a new access key once the old one is dead, and authorizes that one with the same passkey', async () => {
    const { api, org, passkey, root, accessKey, chain } = await withAuthorizedKey();
    // While the key works there is no other to be had.
    const early = await failure(api.newTempoAccessKey(org.id));
    expect({ status: early.status, code: early.code, message: early.message }).toEqual({ status: 409, code: 'refused', message: `access key ${accessKey} is authorized on this account and can still pay; revoke it before a new key takes its place` });
    await revokeTempoAccessKey(root, org.id, { api });
    const sentWithOldKey = chain.broadcasts.length;

    // A key made from here on is new to the chain, which holds keys on the passkey's account.
    const make = w.deps.tempo.newAccessKey;
    w.deps.tempo.newAccessKey = () => {
      const key = make();
      const itsChain = w.tempoChain(key.address);
      itsChain.account = passkey.address;
      itsChain.forget();
      return key;
    };

    const rail = await api.newTempoAccessKey(org.id);
    const fresh = rail.accessKey;
    if (fresh === null) throw new Error('the rail names no access key');
    expect(fresh).not.toBe(accessKey);
    expect(rail).toMatchObject({ account: passkey.address, key: { status: 'ok', source: 'tempo', value: { accessKey: fresh, authorized: false, live: false, revoked: false, remaining: '0' } } });
    expect(await api.tempoRail(org.id)).toEqual(rail);
    expect((await api.getOrg(org.id)).serviceKeys.filter((key) => key.kind === 'tempo_access')).toEqual([{ kind: 'tempo_access', address: fresh }]);

    // The root authorizes the new key as it did the first, and what it signs names the new key.
    expect(await tempoGrant(passkey.address, org.id, { api })).toMatchObject({ accessKey: fresh });
    expect(await authorizeTempoAccessKey(root, org.id, TERMS, { api })).toMatchObject({ authorized: true, sent: true });
    expect(w.tempoChain(fresh).signed[0]?.keyAuthorization).toMatchObject({ address: fresh.toLowerCase(), signature: { type: 'webAuthn' } });
    expect((await api.tempoRail(org.id)).key).toMatchObject({ status: 'ok', value: { accessKey: fresh, authorized: true, revoked: false, remaining: '10000000' } });
    // The retired key sent nothing more, and a key that works is not replaced a second time.
    expect(chain.broadcasts).toHaveLength(sentWithOldKey);
    expect((await failure(api.newTempoAccessKey(org.id))).code).toBe('refused');
  });

  it('is refused for somebody else’s organisation the way the server refuses it', async () => {
    const owner = await withAuthorizedKey();
    const stranger = await treasurer();
    await signIn(stranger.connection, { api: stranger.api, origin: ORIGIN, now: w.clock.now });
    const error = await failure(revokeTempoAccessKey(owner.root, owner.org.id, { api: stranger.api }));
    expect({ status: error.status, code: error.code }).toEqual({ status: 404, code: 'not_found' });
    for (const refused of [
      await failure(stranger.api.tempoRevoke(owner.org.id)),
      await failure(stranger.api.submitTempoRevoke(owner.org.id, { signedTransaction: '0x78abcd' })),
      await failure(stranger.api.newTempoAccessKey(owner.org.id)),
    ]) {
      expect({ status: refused.status, code: refused.code, message: refused.message }).toEqual({ status: 404, code: 'not_found', message: 'not found' });
    }
    expect(owner.chain.revocations).toEqual([]);
  });
});

describe('the Solana delegate', () => {
  const registered: (() => void)[] = [];
  afterEach(() => {
    for (const unregister of registered.splice(0)) unregister();
  });

  /** A treasurer whose organisation names a real wallet as its Solana owner, over a world that builds real transactions. */
  async function withWallet() {
    const BLOCKHASH = base58Encode(new Uint8Array(32).fill(7));
    const node = {
      rpcUrl: 'http://node.invalid',
      transport: async ({ payload }: { payload: unknown }) => {
        const { id } = payload as { id: string };
        return { jsonrpc: '2.0', id, result: { context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 300_000_000 } } };
      },
    };
    // The world's Solana makes up its keys and transactions; here both are real, made by the Solana package.
    const real = solanaPort({ cluster: 'devnet', rpcUrl: node.rpcUrl, mint: w.solana.mint, decimals: w.solana.decimals, tokenSymbol: w.solana.tokenSymbol, markersFrom: undefined });
    w.solana.newDelegateKey = async () => {
      const key = await real.newDelegateKey();
      w.solana.know(key.secret, key.address);
      return key;
    };
    w.solana.buildApproval = (i) => buildDelegateApproval({ ...node, mint: w.solana.mint, decimals: w.solana.decimals, ...i });
    w.solana.buildRevoke = (i) => buildDelegateRevoke({ ...node, mint: w.solana.mint, ...i });

    const fake = await fakeSolanaWallet({ name: 'Phantom' });
    registered.push(getWallets().register(fake.wallet));
    let wallets: SolanaWallet[] = [];
    watchSolanaWallets((found) => {
      wallets = found;
    })();
    const [wallet] = wallets;
    if (wallet === undefined) throw new Error('the wallet is not listed');

    const t = await withOrganisation();
    const org = await t.api.updateOrg(t.org.id, { solanaOwner: fake.address });
    return { ...t, org, fake, wallet: await connectSolanaWallet(wallet, { address: fake.address }) };
  }

  it('approves the service key for an amount, with the wallet’s signature on the server’s transaction, and confirms from the server', async () => {
    const { api, served, org, fake, wallet } = await withWallet();
    const delegate = await keyAddress(w, org.id, 'solana_delegate');
    w.solana.allowance = 0n;

    const submission = await approveSolanaDelegate(wallet, org.id, 25_000_000n, { api });
    expect(served.calls.slice(-2).map((call) => `${call.method} ${call.pattern} ${call.status}`)).toEqual(['GET /api/orgs/[orgId]/rails/solana 200', 'POST /api/orgs/[orgId]/rails/solana/approval 200']);
    expect(served.calls.at(-1)?.body).toEqual({ amount: '25000000' });

    const [sent] = fake.sent;
    if (sent === undefined) throw new Error('the wallet sent nothing');
    expect(submission).toEqual({ signature: base58Encode(sent.signature), txUrl: `https://explorer.solana.com/tx/${base58Encode(sent.signature)}?cluster=devnet`, lastValidBlockHeight: '300000000' });
    expect(sent.chain).toBe('solana:devnet');
    const signed = readSolanaTransaction(sent.wire);
    expect(signed.signers).toEqual([fake.address]);
    expect(signed.instructions[0]?.accounts.slice(1)).toEqual([w.solana.mint, delegate, fake.address]);
    expect(await fake.verify(signed.message, sent.signature)).toBe(true);

    // The wallet's word is not taken for it: the allowance is read from the server until the chain shows it.
    const waiting = await failure(waitForSolanaAllowance(org.id, 25_000_000n, { api, attempts: 2, sleep: async () => undefined }));
    expect(waiting.code).toBe('not_confirmed');
    w.solana.allowance = 25_000_000n;
    const rail = await waitForSolanaAllowance(org.id, 25_000_000n, { api, sleep: async () => undefined });
    expect(rail).toMatchObject({ cluster: 'devnet', owner: fake.address, delegate, allowance: { status: 'ok', value: { remaining: '25000000' } } });
  });

  it('revokes the delegation the same way', async () => {
    const { api, org, fake, wallet } = await withWallet();
    const submission = await revokeSolanaDelegate(wallet, org.id, { api });
    const [sent] = fake.sent;
    if (sent === undefined) throw new Error('the wallet sent nothing');
    expect(submission.signature).toBe(base58Encode(sent.signature));
    const signed = readSolanaTransaction(sent.wire);
    expect(signed.instructions).toHaveLength(1);
    expect([...(signed.instructions[0]?.data ?? [])]).toEqual([5]);
    expect(await fake.verify(signed.message, sent.signature)).toBe(true);
    w.solana.allowance = 0n;
    expect((await waitForSolanaAllowance(org.id, 0n, { api, sleep: async () => undefined })).allowance).toMatchObject({ value: { remaining: '0' } });
  });

  it('refuses what the unmodified world hands out in place of a transaction', async () => {
    // The world's own stand-in for a transaction is a line of text: no wallet is shown that.
    const fake = await fakeSolanaWallet({ name: 'Phantom' });
    registered.push(getWallets().register(fake.wallet));
    let wallets: SolanaWallet[] = [];
    watchSolanaWallets((found) => {
      wallets = found;
    })();
    const t = await withOrganisation();
    await t.api.updateOrg(t.org.id, { solanaOwner: fake.address });
    const wallet = await connectSolanaWallet(wallets[0] as SolanaWallet);
    expect((await failure(approveSolanaDelegate(wallet, t.org.id, 1_000_000n, { api: t.api }))).code).toBe('unexpected_request');
    expect(fake.sent).toEqual([]);
  });
});

describe('letting the service attest', () => {
  it('has the owner’s wallet name the attester key on HyperEVM, and confirms from the server', async () => {
    // A wallet on Arbitrum that has never heard of HyperEVM.
    const { provider, connection, api, served, org, account } = await withOrganisation(42_161);
    provider.knownChains = new Set([42_161]);
    const attester = await keyAddress(w, org.id, 'hl_attester');
    expect((await api.attestor(org.id)).registered).toMatchObject({ status: 'ok', value: { registered: false } });

    const sent = await registerAttester(connection, org.id, { api });
    const [transaction] = provider.transactions;
    if (transaction === undefined) throw new Error('the wallet sent nothing');
    expect(sent).toEqual({ hash: transaction.hash, chainId: 999, contract: w.attestor.contract });
    // One call, from the organisation's own account, on the contract's chain: setAttester with the organisation's key.
    expect(provider.transactions).toHaveLength(1);
    expect(transaction).toMatchObject({ chainId: 999, from: account.address, to: w.attestor.contract });
    expect(decodeFunctionData({ abi: hedgeAttestorAbi, data: transaction.data })).toEqual({ functionName: 'setAttester', args: [getAddress(attester)] });
    expect(provider.requests.filter((request) => request.method.startsWith('wallet_')).map((request) => request.method)).toEqual(['wallet_switchEthereumChain', 'wallet_addEthereumChain']);
    expect(served.calls.at(-1)).toMatchObject({ method: 'GET', pattern: '/api/orgs/[orgId]/attestor', status: 200 });

    // The wallet's word is not taken for it: the server reads the chain.
    expect((await failure(waitForAttester(org.id, { api, attempts: 2, sleep: async () => undefined }))).code).toBe('not_confirmed');
    w.attestor.name(org.owner, attester);
    const view = await waitForAttester(org.id, { api, sleep: async () => undefined });
    expect(view.registered).toMatchObject({ status: 'ok', value: { attester, registered: true } });
  });

  it('has the wallet start a new series the same way', async () => {
    const { provider, connection, api, org, account } = await withOrganisation(999);
    const sent = await startAttestationSeries(connection, org.id, { api });
    const [transaction] = provider.transactions;
    expect(sent.hash).toBe(transaction?.hash);
    expect(transaction).toMatchObject({ chainId: 999, from: account.address, to: w.attestor.contract });
    expect(decodeFunctionData({ abi: hedgeAttestorAbi, data: transaction?.data ?? '0x' })).toMatchObject({ functionName: 'startSeries' });
    // Already on the chain: the wallet was not asked to move.
    expect(provider.count('wallet_switchEthereumChain')).toBe(0);
  });

  it('sends nothing from another account, nothing but those two calls, and nothing where there is no contract', async () => {
    const { provider, connection, api, served, org } = await withOrganisation(999);
    const honest = await api.attestor(org.id);

    // The server prepares something else under the same name: a token transfer, a call to another contract, another chain.
    const transfer = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: ['0x70997970C51812dc3A010C7d01b50e0d17dc79C8', 1_000_000n] });
    const prepared = honest.setAttester;
    if (prepared === null) throw new Error('the server prepared no call');
    const stranger = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
    const naming = (attester: string) => encodeFunctionData({ abi: hedgeAttestorAbi, functionName: 'setAttester', args: [attester as `0x${string}`] });
    /** The application as it is, but for what it says of the attester. */
    const lying = (view: unknown) => createApi({ fetch: async (input, init) => (String(input).endsWith('/attestor') ? Response.json(view) : served.fetch(input, init)) });
    const tampered: [string, unknown][] = [
      ['a token transfer in the place of the call', { ...honest, setAttester: { ...prepared, data: transfer } }],
      ['a call to another contract than the one named', { ...honest, setAttester: { ...prepared, to: stranger } }],
      ['a call for another chain than the one named', { ...honest, setAttester: { ...prepared, chainId: 1 } }],
      ['the other of the two calls', { ...honest, setAttester: honest.startSeries }],
      // Each of the next three says one thing throughout; it is the organisation's own profile, or the chain, that says another.
      ['an attester that is not the organisation’s key', { ...honest, attester: stranger, setAttester: { ...prepared, data: naming(stranger) } }],
      ['an account that is not the organisation’s', { ...honest, account: stranger }],
      ['a contract on a chain that is not HyperEVM', { ...honest, chainId: 1, setAttester: { ...prepared, chainId: 1 }, startSeries: honest.startSeries === null ? null : { ...honest.startSeries, chainId: 1 } }],
    ];
    for (const [what, view] of tampered) {
      expect((await failure(registerAttester(connection, org.id, { api: lying(view) }))).code, what).toBe('unexpected_request');
    }
    expect((await failure(startAttestationSeries(connection, org.id, { api: lying({ ...honest, startSeries: honest.setAttester }) }))).code).toBe('unexpected_request');
    expect((await failure(startAttestationSeries(connection, org.id, { api: lying({ ...honest, chainId: 1, startSeries: honest.startSeries === null ? null : { ...honest.startSeries, chainId: 1 } }) }))).code).toBe('unexpected_request');
    expect(provider.count('eth_sendTransaction')).toBe(0);
    expect(provider.count('wallet_switchEthereumChain')).toBe(0);

    // A deployment that records no attestations has nothing to send.
    w.deps.attestor = null;
    const none = await failure(registerAttester(connection, org.id, { api }));
    expect({ code: none.code, message: none.message }).toEqual({ code: 'nothing_to_sign', message: 'this deployment records no attestations' });
    expect((await failure(startAttestationSeries(connection, org.id, { api }))).code).toBe('nothing_to_sign');
    w.deps.attestor = w.attestor;

    // The wallet moved to another account: only the organisation's own can name its attester.
    provider.selectAccounts([newAccount()]);
    const wrong = await failure(registerAttester(connection, org.id, { api }));
    expect(wrong.code).toBe('wrong_account');
    expect(wrong.message).toContain(org.owner);
    expect(provider.transactions).toEqual([]);
    expect(provider.count('eth_sendTransaction')).toBe(0);
  });
});

describe('funding with ZEC', () => {
  it('turns the server’s payment request into text, a link and a QR code of the same URI', async () => {
    const { api, org } = await withOrganisation();
    const quote = await api.quoteFunding(org.id, { purpose: 'margin', amountZat: 250_000_000n, refundTo: 't1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC' });
    expect(quote.amountIn).toBe('250000000');
    if (quote.paymentUri === null) throw new Error('the quote carries no payment request');

    const request = zcashPaymentRequest(quote.paymentUri, { address: quote.depositAddress ?? '', amountZat: 250_000_000n });
    expect(request.uri).toBe(`zcash:${quote.depositAddress}?amount=2.5`);
    expect(request.href).toBe(request.uri);
    expect(parsePaymentUri(request.href)).toEqual([{ address: quote.depositAddress, amountZat: 250_000_000n }]);
    expect(request.qr).toEqual(encodeQr(request.uri));
    expect(request.qr.modules).toHaveLength(request.qr.size);

    // A dry quote has nothing to pay.
    const dry = await api.quoteFunding(org.id, { purpose: 'margin', amountZat: 250_000_000n, refundTo: 't1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC', dry: true });
    expect(dry.paymentUri).toBeNull();
    expect((await api.listSwaps(org.id)).swaps.map((swap) => swap.id)).toEqual([quote.swapId]);
  });
});
