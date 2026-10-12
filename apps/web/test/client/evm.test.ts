import { approveAgentAction, submitApproveAgent } from '@holdfast/hyperliquid';
import { getAddress, recoverMessageAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hyperEvm, hyperliquidEvmTestnet } from 'viem/chains';
import { parseSiweMessage } from 'viem/siwe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HyperliquidApprovalRequest, SignInChallenge } from '../../src/client/api';
import { ClientError } from '../../src/client/errors';
import { type EvmState, type EvmWallet, connectEvmWallet, sameAddress, watchEvmWallets } from '../../src/client/evm';
import { HYPERLIQUID_AGENT_NAME, approveAgentTypedData, checkedApprovalTypedData } from '../../src/client/hyperliquid';
import { buildSignInMessage, sessionMatches } from '../../src/client/session';
import { issueNonce, signIn as serverSignIn } from '../../src/server/auth/sign-in';
import type { Deps } from '../../src/server/deps';
import { AGENT_NAME } from '../../src/server/hyperliquid/service';
import { HOST, ORIGIN, SESSION_SECRET } from '../support/world';
import { FakeEvmWallet, announce, fakeWindow } from './support/wallets';

const OWNER = privateKeyToAccount(`0x${'a1'.repeat(32)}`);
const OTHER = privateKeyToAccount(`0x${'b2'.repeat(32)}`);
const AGENT = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
const NOW = 1_791_640_000_000;
const STATEMENT = 'Sign in to Holdfast. This proves you hold this address and moves no funds.';

const walletOf = (provider: FakeEvmWallet, name = 'Test Wallet'): EvmWallet => ({ id: 'test', name, icon: null, rdns: 'test.wallet', provider });

async function failure(promise: Promise<unknown>): Promise<ClientError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ClientError) return error;
    throw error;
  }
  throw new Error('expected a failure');
}

describe('finding EVM wallets', () => {
  let page: ReturnType<typeof fakeWindow>;

  beforeEach(() => {
    page = fakeWindow();
    vi.stubGlobal('window', page);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('lists the wallets that announce themselves, those already there and those that come later', () => {
    const rabby = new FakeEvmWallet([OWNER]);
    const metamask = new FakeEvmWallet([OTHER]);
    announce(page, rabby, { uuid: 'uuid-rabby', name: 'Rabby', rdns: 'io.rabby' });

    const seen: EvmWallet[][] = [];
    const stop = watchEvmWallets((wallets) => seen.push(wallets));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([{ id: 'uuid-rabby', name: 'Rabby', rdns: 'io.rabby', icon: 'data:image/svg+xml;base64,PHN2Zy8+', provider: rabby }]);

    announce(page, metamask, { uuid: 'uuid-metamask', name: 'MetaMask', rdns: 'io.metamask' });
    expect(seen).toHaveLength(2);
    expect(seen[1]?.map((wallet) => wallet.name)).toEqual(['Rabby', 'MetaMask']);
    expect(seen[1]?.[1]?.provider).toBe(metamask);

    // A wallet that announces itself again is the wallet already listed.
    page.dispatchEvent(new Event('eip6963:requestProvider'));
    expect(seen).toHaveLength(2);

    stop();
    announce(page, new FakeEvmWallet([OTHER]), { uuid: 'uuid-late', name: 'Late', rdns: 'late.wallet' });
    expect(seen).toHaveLength(2);
  });

  it('falls back on window.ethereum only while no wallet has announced itself', () => {
    const legacy = new FakeEvmWallet([OWNER]);
    page.ethereum = legacy;
    const seen: EvmWallet[][] = [];
    watchEvmWallets((wallets) => seen.push(wallets));
    expect(seen[0]).toEqual([{ id: 'injected', name: 'Browser wallet', icon: null, rdns: null, provider: legacy }]);

    announce(page, legacy, { uuid: 'uuid-1', name: 'MetaMask', rdns: 'io.metamask' });
    expect(seen[1]?.map((wallet) => wallet.id)).toEqual(['uuid-1']);
  });

  it('takes no announcement that is not one, and no icon that is not a data URI', () => {
    const seen: EvmWallet[][] = [];
    watchEvmWallets((wallets) => seen.push(wallets));
    for (const detail of [null, {}, { info: { uuid: 'x', name: 'X', rdns: 'x' } }, { info: { name: 'X' }, provider: new FakeEvmWallet([OWNER]) }, { info: { uuid: 'x', name: 'X', rdns: 'x' }, provider: {} }]) {
      page.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
    }
    expect(seen).toEqual([[]]);
    announce(page, new FakeEvmWallet([OWNER]), { uuid: 'uuid-2', name: 'Remote', rdns: 'remote.wallet', icon: 'https://tracker.example/icon.png' });
    expect(seen[1]?.[0]?.icon).toBeNull();
  });

  it('finds nothing, and touches nothing, where there is no window', () => {
    vi.unstubAllGlobals();
    const seen: EvmWallet[][] = [];
    const stop = watchEvmWallets((wallets) => seen.push(wallets));
    expect(seen).toEqual([[]]);
    expect(() => stop()).not.toThrow();
  });
});

describe('connecting to an EVM wallet', () => {
  it('asks for the accounts, and reads the address and the chain', async () => {
    const provider = new FakeEvmWallet([OWNER], 42_161);
    const connection = await connectEvmWallet(walletOf(provider));
    expect(connection.state()).toEqual({ address: OWNER.address, chainId: 42_161 });
    expect(connection.wallet.name).toBe('Test Wallet');
    expect(provider.requests.map((request) => request.method)).toEqual(['eth_requestAccounts', 'eth_chainId']);
  });

  it('reconnects without opening the wallet, and only if the site may already see an account', async () => {
    const provider = new FakeEvmWallet([OWNER]);
    expect(await connectEvmWallet(walletOf(provider), { silent: true })).toBeNull();
    expect(provider.requests.map((request) => request.method)).toEqual(['eth_accounts']);

    provider.authorized = true;
    const connection = await connectEvmWallet(walletOf(provider), { silent: true });
    expect(connection?.state()).toEqual({ address: OWNER.address, chainId: 42_161 });
    expect(provider.count('eth_requestAccounts')).toBe(0);
  });

  it('follows the wallet when it changes account or chain, and when it locks', async () => {
    const provider = new FakeEvmWallet([OWNER], 1);
    const connection = await connectEvmWallet(walletOf(provider));
    const seen: EvmState[] = [];
    const stop = connection.subscribe((state) => seen.push(state));

    provider.selectAccounts([OTHER, OWNER]);
    provider.selectChain(42_161);
    provider.selectChain(42_161);
    provider.selectAccounts([]);
    expect(seen).toEqual([
      { address: OTHER.address, chainId: 1 },
      { address: OTHER.address, chainId: 42_161 },
      { address: null, chainId: 42_161 },
    ]);
    expect(connection.state()).toEqual({ address: null, chainId: 42_161 });
    expect((await failure(connection.signMessage('hello'))).code).toBe('wallet_unavailable');

    stop();
    provider.selectAccounts([OWNER]);
    expect(seen).toHaveLength(3);
    expect(connection.state().address).toBe(OWNER.address);
  });

  it('reads the chain from the wallet itself when asked, and can ask the wallet to switch', async () => {
    const provider = new FakeEvmWallet([OWNER], 1);
    const connection = await connectEvmWallet(walletOf(provider));
    // A wallet that changed chain without saying so.
    provider.chainId = 10;
    expect(connection.state().chainId).toBe(1);
    expect(await connection.readChainId()).toBe(10);
    expect(connection.state().chainId).toBe(10);

    await connection.switchChain(42_161);
    expect(provider.requests.slice(-2)).toEqual([{ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xa4b1' }] }, { method: 'eth_chainId', params: undefined }]);
    expect(connection.state().chainId).toBe(42_161);
  });

  it('gives the wallet a chain it does not know, when told what the chain is, and makes sure the wallet got there', async () => {
    const provider = new FakeEvmWallet([OWNER], 1);
    provider.knownChains = new Set([1]);
    const connection = await connectEvmWallet(walletOf(provider));

    // Without the chain's description there is nothing to give the wallet.
    const unknown = await failure(connection.switchChain(999));
    expect({ code: unknown.code, message: unknown.message }).toEqual({ code: 'wallet_failed', message: expect.stringContaining('switching chain failed in the wallet') });
    expect(provider.count('wallet_addEthereumChain')).toBe(0);

    await connection.switchChain(999, { add: hyperEvm });
    const added = provider.requests.find((request) => request.method === 'wallet_addEthereumChain');
    expect(added?.params).toEqual([expect.objectContaining({ chainId: '0x3e7', chainName: 'HyperEVM', rpcUrls: ['https://rpc.hyperliquid.xyz/evm'], nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 } })]);
    expect(connection.state().chainId).toBe(999);

    // A wallet that adds a chain and stays where it was is asked once more to move.
    const staying = new FakeEvmWallet([OWNER], 1);
    staying.knownChains = new Set([1]);
    staying.switchesOnAdd = false;
    const second = await connectEvmWallet(walletOf(staying));
    await second.switchChain(998, { add: hyperliquidEvmTestnet });
    expect(staying.requests.filter((request) => request.method.startsWith('wallet_')).map((request) => request.method)).toEqual(['wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_switchEthereumChain']);
    expect(second.state().chainId).toBe(998);

    // The description of another chain than the one asked for is not handed to the wallet.
    expect((await failure(second.switchChain(999, { add: hyperliquidEvmTestnet }))).code).toBe('wallet_failed');
    expect(staying.count('wallet_addEthereumChain')).toBe(1);

    // And a refusal to add is the treasurer's to give.
    const declining = new FakeEvmWallet([OWNER], 1);
    declining.knownChains = new Set([1]);
    const refusing = { request: async (args: { method: string; params?: unknown }) => (args.method === 'wallet_addEthereumChain' ? Promise.reject(Object.assign(new Error('User rejected the request.'), { code: 4001 })) : declining.request(args)) };
    const third = await connectEvmWallet({ ...walletOf(declining), provider: refusing });
    expect(await failure(third.switchChain(999, { add: hyperEvm }))).toMatchObject({ code: 'wallet_rejected', message: 'adding the chain was declined in the wallet' });
    expect(third.state().chainId).toBe(1);
  });

  it('has the wallet send a call from the selected account, and sends it once', async () => {
    const provider = new FakeEvmWallet([OWNER], 999);
    const connection = await connectEvmWallet(walletOf(provider));
    const call = { to: '0x5FbDB2315678afecb367f032d93F642f64180aa3', data: '0x2f2ff15d' };

    const hash = await connection.sendCall(call);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(provider.transactions).toEqual([{ chainId: 999, from: OWNER.address, to: call.to, data: call.data, hash }]);
    // Fee, nonce and chain are the wallet's to set: nothing but the call is handed over.
    expect(provider.requests.at(-1)).toEqual({ method: 'eth_sendTransaction', params: [{ from: OWNER.address, to: call.to, data: call.data }] });

    provider.failNext = { code: 4001, message: 'User rejected the request.' };
    expect(await failure(connection.sendCall(call))).toMatchObject({ code: 'wallet_rejected', message: 'sending the transaction was declined in the wallet' });
    // viem's transport repeats a request that failed with an internal error three times unless told not to.
    // A transaction is the last thing to ask a wallet for again, so the connection's transport never repeats.
    provider.failNext = { code: -32603, message: 'Internal JSON-RPC error.' };
    expect((await failure(connection.sendCall(call))).code).toBe('wallet_failed');
    expect(provider.count('eth_sendTransaction')).toBe(3);
    expect(provider.transactions).toHaveLength(1);

    for (const bad of [{ to: 'the contract', data: '0x' }, { to: call.to, data: 'setAttester()' }, { ...call, chainId: 0 }]) {
      expect((await failure(connection.sendCall(bad))).code).toBe('invalid_argument');
    }
    expect(provider.count('eth_sendTransaction')).toBe(3);
  });

  it('sends a call only on the chain it is for, and names the chain to the wallet', async () => {
    const provider = new FakeEvmWallet([OWNER], 999);
    const connection = await connectEvmWallet(walletOf(provider));
    const call = { to: '0x5FbDB2315678afecb367f032d93F642f64180aa3', data: '0x2f2ff15d', from: OWNER.address, chainId: 999 };

    await connection.sendCall(call);
    expect(provider.requests.slice(-2)).toEqual([
      { method: 'eth_chainId', params: undefined },
      { method: 'eth_sendTransaction', params: [{ from: OWNER.address, to: call.to, data: call.data, chainId: '0x3e7' }] },
    ]);

    // The wallet moved to another chain without the page being told: it is asked, and nothing is sent.
    provider.chainId = 1;
    const elsewhere = await failure(connection.sendCall(call));
    expect({ code: elsewhere.code, message: elsewhere.message }).toEqual({ code: 'wallet_failed', message: 'Test Wallet is on chain 1, and the transaction is for chain 999; nothing was sent' });
    expect(provider.transactions).toHaveLength(1);
  });

  it('can be let go of without a word to the wallet', async () => {
    const provider = new FakeEvmWallet([OWNER]);
    const connection = await connectEvmWallet(walletOf(provider));
    const seen: EvmState[] = [];
    connection.subscribe((state) => seen.push(state));
    const before = provider.requests.length;

    connection.close();
    expect(seen).toEqual([{ address: null, chainId: null }]);
    expect([provider.listenerCount('accountsChanged'), provider.listenerCount('chainChanged')]).toEqual([0, 0]);
    // The wallet was asked nothing and keeps the site's access.
    expect(provider.requests).toHaveLength(before);
    expect(provider.authorized).toBe(true);
  });

  it('disconnects: stops listening, forgets the account and asks the wallet to withdraw access', async () => {
    const provider = new FakeEvmWallet([OWNER]);
    const connection = await connectEvmWallet(walletOf(provider));
    const seen: EvmState[] = [];
    connection.subscribe((state) => seen.push(state));
    expect([provider.listenerCount('accountsChanged'), provider.listenerCount('chainChanged')]).toEqual([1, 1]);

    await connection.disconnect();
    expect(seen).toEqual([{ address: null, chainId: null }]);
    expect([provider.listenerCount('accountsChanged'), provider.listenerCount('chainChanged')]).toEqual([0, 0]);
    expect(provider.requests.at(-1)).toEqual({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] });
    expect(provider.authorized).toBe(false);
    provider.selectAccounts([OTHER]);
    expect(seen).toHaveLength(1);
  });

  it('disconnects from a wallet that knows no way to withdraw access', async () => {
    const provider = new FakeEvmWallet([OWNER]);
    const bare = { request: async (args: { method: string; params?: unknown }) => (args.method === 'wallet_revokePermissions' ? Promise.reject(Object.assign(new Error('no such method'), { code: -32601 })) : provider.request(args)) };
    const connection = await connectEvmWallet({ ...walletOf(provider), provider: bare });
    await expect(connection.disconnect()).resolves.toBeUndefined();
    expect(connection.state()).toEqual({ address: null, chainId: null });
  });

  it('says that the treasurer declined, and asks nothing a second time', async () => {
    const provider = new FakeEvmWallet([OWNER]);
    provider.failNext = { code: 4001, message: 'User rejected the request.' };
    const declined = await failure(connectEvmWallet(walletOf(provider)));
    expect({ code: declined.code, status: declined.status, message: declined.message }).toEqual({ code: 'wallet_rejected', status: null, message: 'connecting was declined in the wallet' });
    expect(provider.count('eth_requestAccounts')).toBe(1);

    const connection = await connectEvmWallet(walletOf(provider));
    provider.failNext = { code: 4001, message: 'User rejected the request.' };
    expect((await failure(connection.signMessage('hello'))).code).toBe('wallet_rejected');
    expect(provider.count('personal_sign')).toBe(1);

    // An internal error is the kind a client library sends again; a wallet must not be opened twice for one request.
    provider.failNext = { code: -32603, message: 'Internal JSON-RPC error.' };
    const failed = await failure(connection.signMessage('hello'));
    expect(failed.code).toBe('wallet_failed');
    expect(failed.message).toContain('signing the message failed in the wallet');
    expect(provider.count('personal_sign')).toBe(2);

    provider.failNext = { message: 'the device was unplugged' };
    expect((await failure(connection.signTypedData(approveAgentTypedData({ chainId: 42_161, hyperliquidChain: 'Mainnet', agentAddress: AGENT, agentName: 'holdfast', nonce: NOW })))).code).toBe('wallet_failed');
    expect(provider.count('eth_signTypedData_v4')).toBe(1);
  });

  it('reports a wallet that shares no account', async () => {
    const provider = new FakeEvmWallet([]);
    const error = await failure(connectEvmWallet(walletOf(provider)));
    expect({ code: error.code, message: error.message }).toEqual({ code: 'wallet_unavailable', message: 'Test Wallet shared no account' });
  });

  it('compares addresses without case, and nothing with a missing one', () => {
    expect(sameAddress(OWNER.address, OWNER.address.toLowerCase())).toBe(true);
    expect(sameAddress(OWNER.address, OTHER.address)).toBe(false);
    expect(sameAddress(null, null)).toBe(false);
    expect(sessionMatches({ address: OWNER.address.toLowerCase() as `0x${string}` }, OWNER.address)).toBe(true);
    expect(sessionMatches({ address: OWNER.address.toLowerCase() as `0x${string}` }, OTHER.address)).toBe(false);
    expect(sessionMatches(null, OWNER.address)).toBe(false);
  });
});

describe('the sign-in message', () => {
  /** The server's side of signing in, over a store that keeps nonces and nothing else. */
  function server(now = () => NOW) {
    const nonces = new Map<string, number>();
    const deps = {
      now,
      secrets: { session: SESSION_SECRET, tick: '' },
      store: {
        issueNonce: async (nonce: string, ttlMs: number) => {
          nonces.set(nonce, now() + ttlMs);
          return now() + ttlMs;
        },
        consumeNonce: async (nonce: string) => {
          const expiresAt = nonces.get(nonce);
          nonces.delete(nonce);
          return expiresAt !== undefined && expiresAt > now();
        },
      },
    } as unknown as Pick<Deps, 'store' | 'now' | 'secrets'>;
    const challenge = async (): Promise<SignInChallenge> => ({ ...(await issueNonce(deps)), domain: HOST, version: '1', statement: STATEMENT });
    return { deps, challenge };
  }

  it('is the EIP-4361 message for the challenge, with nothing in it the server did not ask for', async () => {
    const challenge: SignInChallenge = { nonce: 'abcdef0123456789abcdef0123456789', expiresAt: NOW + 600_000, domain: HOST, version: '1', statement: STATEMENT };
    const message = buildSignInMessage(challenge, { address: OWNER.address.toLowerCase(), chainId: 42_161, origin: ORIGIN, issuedAt: new Date(NOW) });
    expect(message).toBe(
      [
        `${HOST} wants you to sign in with your Ethereum account:`,
        OWNER.address,
        '',
        STATEMENT,
        '',
        `URI: ${ORIGIN}`,
        'Version: 1',
        'Chain ID: 42161',
        'Nonce: abcdef0123456789abcdef0123456789',
        `Issued At: ${new Date(NOW).toISOString()}`,
      ].join('\n'),
    );
    expect(parseSiweMessage(message)).toEqual({ address: OWNER.address, chainId: 42_161, domain: HOST, nonce: challenge.nonce, uri: ORIGIN, version: '1', statement: STATEMENT, issuedAt: new Date(NOW) });
  });

  it('is accepted by the server’s own verification when the wallet signs it with personal_sign', async () => {
    const { deps, challenge } = server();
    const provider = new FakeEvmWallet([OWNER], 8_453);
    const connection = await connectEvmWallet(walletOf(provider));

    const message = buildSignInMessage(await challenge(), { address: OWNER.address, chainId: await connection.readChainId(), origin: ORIGIN, issuedAt: new Date(NOW) });
    const signature = await connection.signMessage(message);
    expect(provider.requests.at(-1)?.method).toBe('personal_sign');
    expect(await recoverMessageAddress({ message, signature })).toBe(OWNER.address);

    const session = await serverSignIn(deps, { message, signature, host: HOST });
    expect(session.address).toBe(OWNER.address.toLowerCase());
    // The challenge is spent: the same signed message opens nothing a second time.
    await expect(serverSignIn(deps, { message, signature, host: HOST })).rejects.toThrow('the nonce is unknown, has expired or was used before');
  });

  it('is refused by the server when it was written for another site, and accepted on a host with a port', async () => {
    const { deps, challenge } = server();
    const connection = await connectEvmWallet(walletOf(new FakeEvmWallet([OWNER])));
    const elsewhere = buildSignInMessage(await challenge(), { address: OWNER.address, chainId: 1, origin: 'https://evil.example', issuedAt: new Date(NOW) });
    await expect(serverSignIn(deps, { message: elsewhere, signature: await connection.signMessage(elsewhere), host: HOST })).rejects.toThrow('names another site as its URI');

    const local = buildSignInMessage({ ...(await challenge()), domain: 'localhost:3000' }, { address: OWNER.address, chainId: 1, origin: 'http://localhost:3000', issuedAt: new Date(NOW) });
    expect((await serverSignIn(deps, { message: local, signature: await connection.signMessage(local), host: 'localhost:3000' })).address).toBe(OWNER.address.toLowerCase());
  });

  it('is still accepted when the clock of the browser runs fast', async () => {
    const { deps, challenge } = server();
    const connection = await connectEvmWallet(walletOf(new FakeEvmWallet([OWNER])));
    const issued = await challenge();
    // A browser three hours ahead: the server refuses a message dated that far in the future.
    const message = buildSignInMessage(issued, { address: OWNER.address, chainId: 1, origin: ORIGIN, issuedAt: new Date(NOW + 3 * 3_600_000) });
    expect(parseSiweMessage(message).issuedAt).toEqual(new Date(issued.expiresAt));
    expect((await serverSignIn(deps, { message, signature: await connection.signMessage(message), host: HOST })).address).toBe(OWNER.address.toLowerCase());

    // A slow clock needs nothing done about it.
    const late = buildSignInMessage(await challenge(), { address: OWNER.address, chainId: 1, origin: ORIGIN, issuedAt: new Date(NOW - 86_400_000) });
    expect(parseSiweMessage(late).issuedAt).toEqual(new Date(NOW - 86_400_000));
    expect((await serverSignIn(deps, { message: late, signature: await connection.signMessage(late), host: HOST })).address).toBe(OWNER.address.toLowerCase());
  });
});

describe('the typed data of an agent approval', () => {
  const exchange = () => {
    const sent: unknown[] = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ status: 'ok', response: { type: 'default' } });
    };
    return { fetch, sent };
  };
  /** What the server answers `GET …/hyperliquid/approval` with, built by the package the server builds it with. */
  const requestFor = (chainId: number | undefined, validUntil?: number, over: { agentName?: string; nonce?: number; network?: 'mainnet' | 'testnet' } = {}): HyperliquidApprovalRequest => ({
    agentAddress: AGENT,
    agentName: over.agentName ?? 'holdfast',
    nonce: over.nonce ?? NOW,
    signatureChainId: chainId ?? null,
    validUntil: validUntil ?? null,
    typedData: approveAgentAction({
      agentAddress: AGENT,
      agentName: over.agentName ?? 'holdfast',
      network: over.network ?? 'mainnet',
      nonce: over.nonce ?? NOW,
      ...(chainId === undefined ? {} : { signatureChainId: chainId }),
      ...(validUntil === undefined ? {} : { validUntil }),
    }).typedData,
  });

  it('is what the Hyperliquid package builds for the same terms, under the name the server approves its agent under', () => {
    expect(HYPERLIQUID_AGENT_NAME).toBe(AGENT_NAME);
    for (const [chainId, validUntil] of [[42_161, undefined], [1, NOW + 86_400_000], [8_453, undefined]] as const) {
      const built = approveAgentAction({ agentAddress: AGENT, agentName: AGENT_NAME, network: 'mainnet', nonce: NOW, signatureChainId: chainId, ...(validUntil === undefined ? {} : { validUntil }) }).typedData;
      expect(approveAgentTypedData({ chainId, hyperliquidChain: 'Mainnet', agentAddress: AGENT, agentName: HYPERLIQUID_AGENT_NAME, nonce: NOW, ...(validUntil === undefined ? {} : { validUntil }) })).toEqual(built);
    }
    expect(approveAgentTypedData({ chainId: 421_614, hyperliquidChain: 'Testnet', agentAddress: AGENT, agentName: HYPERLIQUID_AGENT_NAME, nonce: NOW })).toEqual(
      approveAgentAction({ agentAddress: AGENT, agentName: AGENT_NAME, network: 'testnet', nonce: NOW }).typedData,
    );
  });

  it('is signed with eth_signTypedData_v4 on the wallet’s own chain and passes the server-side check', async () => {
    for (const chainId of [42_161, 1, 8_453]) {
      const provider = new FakeEvmWallet([OWNER], chainId);
      const connection = await connectEvmWallet(walletOf(provider));
      const validUntil = NOW + 30 * 86_400_000;
      const typedData = checkedApprovalTypedData(requestFor(chainId, validUntil), { chainId, validUntil, network: 'Mainnet' });
      const signature = await connection.signTypedData(typedData, OWNER.address);

      const request = provider.requests.at(-1);
      expect(request?.method).toBe('eth_signTypedData_v4');
      const [signer, payload] = request?.params as [string, string];
      expect(getAddress(signer)).toBe(OWNER.address);
      const signed = JSON.parse(payload) as { domain: unknown; primaryType: string; types: Record<string, unknown>; message: unknown };
      expect(signed.domain).toEqual({ name: 'HyperliquidSignTransaction', version: '1', chainId, verifyingContract: '0x0000000000000000000000000000000000000000' });
      expect(signed.primaryType).toBe('HyperliquidTransaction:ApproveAgent');
      expect(signed.message).toEqual({ hyperliquidChain: 'Mainnet', agentAddress: AGENT, agentName: `holdfast valid_until ${validUntil}`, nonce: NOW });

      // The check the server makes before anything goes to Hyperliquid: the signature recovers to the organisation's own account.
      const { fetch, sent } = exchange();
      const reply = await submitApproveAgent({ agentAddress: AGENT, agentName: 'holdfast', network: 'mainnet', nonce: NOW, signatureChainId: chainId, validUntil, user: OWNER.address, signature, fetch });
      expect(reply).toMatchObject({ ok: true, delivered: true });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ nonce: NOW, action: { type: 'approveAgent', signatureChainId: `0x${chainId.toString(16)}`, agentAddress: AGENT } });

      // The same signature is turned away for any other account, and nothing is sent.
      const other = exchange();
      const refused = await submitApproveAgent({ agentAddress: AGENT, agentName: 'holdfast', network: 'mainnet', nonce: NOW, signatureChainId: chainId, validUntil, user: OTHER.address, signature, fetch: other.fetch });
      expect(refused).toMatchObject({ ok: false, delivered: false });
      expect(other.sent).toEqual([]);
    }
  });

  it('cannot be signed by the wallet for a chain it is not on, which is why it is asked for the wallet’s chain', async () => {
    const provider = new FakeEvmWallet([OWNER], 8_453);
    const connection = await connectEvmWallet(walletOf(provider));
    // The server's default is Arbitrum; a wallet on Base refuses that.
    const arbitrum = approveAgentTypedData({ chainId: 42_161, hyperliquidChain: 'Mainnet', agentAddress: AGENT, agentName: 'holdfast', nonce: NOW });
    expect((await failure(connection.signTypedData(arbitrum))).code).toBe('wallet_failed');
    await expect(connection.signTypedData(checkedApprovalTypedData(requestFor(8_453), { chainId: 8_453 }))).resolves.toMatch(/^0x[0-9a-f]{130}$/);
  });

  it('is signed as the account named and as no other, however the wallet has moved since', async () => {
    const provider = new FakeEvmWallet([OWNER], 8_453);
    const connection = await connectEvmWallet(walletOf(provider));
    const typedData = checkedApprovalTypedData(requestFor(8_453), { chainId: 8_453 });

    provider.selectAccounts([OTHER]);
    const moved = await failure(connection.signTypedData(typedData, OWNER.address));
    expect({ code: moved.code, message: moved.message }).toEqual({ code: 'wrong_account', message: `Test Wallet has ${OTHER.address} selected, and this has to be signed by ${OWNER.address}` });
    expect((await failure(connection.signMessage('hello', OWNER.address))).code).toBe('wrong_account');
    expect((await failure(connection.sendCall({ to: AGENT, data: '0x', from: OWNER.address }))).code).toBe('wrong_account');
    expect(provider.requests.filter((request) => ['eth_signTypedData_v4', 'personal_sign', 'eth_sendTransaction'].includes(request.method))).toEqual([]);

    // Written in either case, it is the same account.
    provider.selectAccounts([OWNER]);
    await expect(connection.signTypedData(typedData, OWNER.address.toLowerCase())).resolves.toMatch(/^0x/);
    await expect(connection.signMessage('hello', OWNER.address.toLowerCase())).resolves.toMatch(/^0x/);
  });

  it('is refused unless the server prepared exactly the approval of its agent on the wallet’s chain', () => {
    const good = requestFor(8_453);
    expect(checkedApprovalTypedData(good, { chainId: 8_453 })).toEqual(good.typedData);
    expect(checkedApprovalTypedData(good, { chainId: 8_453, network: 'Mainnet' })).toEqual(good.typedData);
    // Written with a checksum or without, the agent is the same agent.
    expect(checkedApprovalTypedData({ ...good, agentAddress: getAddress(AGENT) }, { chainId: 8_453 })).toEqual(good.typedData);

    const withMessage = (message: Record<string, string | number>): HyperliquidApprovalRequest => ({ ...good, typedData: { ...good.typedData, message: { ...good.typedData.message, ...message } } });
    const cases: [string, HyperliquidApprovalRequest, { chainId: number; validUntil?: number; network?: 'Mainnet' | 'Testnet' }][] = [
      ['data for another chain than the wallet is on', requestFor(42_161), { chainId: 8_453 }],
      ['data for the default chain when the wallet is elsewhere', requestFor(undefined), { chainId: 8_453 }],
      ['another agent in the message than the request names', withMessage({ agentAddress: OTHER.address.toLowerCase() }), { chainId: 8_453 }],
      ['another nonce in the message', withMessage({ nonce: NOW + 1 }), { chainId: 8_453 }],
      ['an expiry that was not asked for', requestFor(8_453, NOW + 86_400_000), { chainId: 8_453 }],
      ['no expiry where one was asked for', good, { chainId: 8_453, validUntil: NOW + 86_400_000 }],
      // Each of the next four is consistent in itself: the request and its typed data say the same thing.
      ['another name, which would put out the agent that holds it', requestFor(8_453, undefined, { agentName: 'mybot' }), { chainId: 8_453 }],
      ['an expiry smuggled in through the name', { ...good, agentName: 'holdfast valid_until 1', typedData: withMessage({ agentName: 'holdfast valid_until 1' }).typedData }, { chainId: 8_453 }],
      ['a nonce that is not a time', { ...requestFor(8_453), nonce: 1.5 }, { chainId: 8_453 }],
      ['the other Hyperliquid than the page said', requestFor(8_453, undefined, { network: 'testnet' }), { chainId: 8_453, network: 'Mainnet' }],
      ['a network that is not one', withMessage({ hyperliquidChain: 'Devnet' }), { chainId: 8_453 }],
      ['a field more in the message', withMessage({ destination: OTHER.address }), { chainId: 8_453 }],
      ['another domain', { ...good, typedData: { ...good.typedData, domain: { ...good.typedData.domain, name: 'Exchange' as never } } }, { chainId: 8_453 }],
      [
        'a withdrawal dressed as an approval',
        {
          ...good,
          typedData: {
            ...good.typedData,
            primaryType: 'HyperliquidTransaction:Withdraw',
            types: { 'HyperliquidTransaction:Withdraw': [{ name: 'hyperliquidChain', type: 'string' }, { name: 'destination', type: 'string' }, { name: 'amount', type: 'string' }, { name: 'time', type: 'uint64' }] },
            message: { hyperliquidChain: 'Mainnet', destination: OTHER.address, amount: '1000000', time: NOW },
          },
        },
        { chainId: 8_453 },
      ],
    ];
    for (const [what, request, expectation] of cases) {
      let thrown: unknown;
      try {
        checkedApprovalTypedData(request, expectation);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, what).toBeInstanceOf(ClientError);
      expect((thrown as ClientError).code, what).toBe('unexpected_request');
    }
    // An expiry before the approval is made is the caller's mistake, not the server's.
    expect(() => checkedApprovalTypedData(good, { chainId: 8_453, validUntil: NOW - 1 })).toThrow('the approval has to lapse after it is made');
  });
});
