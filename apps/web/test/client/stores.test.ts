import { getWallets } from '@wallet-standard/app';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApi } from '../../src/client/api';
import { ClientError } from '../../src/client/errors';
import { type UseAsyncAction, type UseEvmWallet, type UseSession, type UseSolanaWallet, type UseTempoAccount, useAsyncAction, useEvmWallet, useSession, useSolanaWallet, useTempoAccount } from '../../src/client/hooks';
import { createAsyncAction, createEvmWalletStore, createSessionStore, createSolanaWalletStore, createTempoAccountStore } from '../../src/client/stores';
import { FakeEvmWallet, announce, fakeSolanaWallet, fakeWindow, softwareAuthenticator } from './support/wallets';

const OWNER = privateKeyToAccount(`0x${'a1'.repeat(32)}`);
const OTHER = privateKeyToAccount(`0x${'b2'.repeat(32)}`);
const ORG = '7b0e7a52-8b65-4f0e-9d3a-2f1c4c1f9a10';

/** A promise and the two ends of it. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

afterEach(() => vi.unstubAllGlobals());

describe('an asynchronous action', () => {
  it('goes from idle through pending to done, and tells its listeners each time', async () => {
    const gate = deferred<number>();
    const action = createAsyncAction(async (factor: number) => (await gate.promise) * factor);
    const seen: string[] = [];
    action.subscribe(() => seen.push(action.get().status));
    expect(action.get()).toEqual({ status: 'idle', result: null, error: null });
    expect(action.initial).toEqual({ status: 'idle', result: null, error: null });

    const run = action.run(3);
    expect(action.get()).toEqual({ status: 'pending', result: null, error: null });
    gate.resolve(14);
    expect(await run).toBe(42);
    expect(action.get()).toEqual({ status: 'done', result: 42, error: null });
    expect(seen).toEqual(['pending', 'done']);

    action.reset();
    expect(action.get()).toEqual({ status: 'idle', result: null, error: null });
  });

  it('never rejects: a failure is the failed state, with the error as the client’s one kind', async () => {
    const refused = new ClientError('refused', 'Hyperliquid refused the approval', { status: 409 });
    const typed = createAsyncAction(async () => {
      throw refused;
    });
    expect(await typed.run()).toBeUndefined();
    expect(typed.get()).toEqual({ status: 'failed', result: null, error: refused });

    const untyped = createAsyncAction(async () => {
      throw new TypeError('x is not a function');
    });
    await untyped.run();
    const state = untyped.get();
    expect(state.status).toBe('failed');
    expect(state.error).toBeInstanceOf(ClientError);
    expect(state.error?.message).toBe('x is not a function');
    expect(state.error?.status).toBeNull();

    // It can be run again after a failure.
    let attempts = 0;
    const flaky = createAsyncAction(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('first time');
      return 'second time';
    });
    await flaky.run();
    expect(await flaky.run()).toBe('second time');
    expect(flaky.get()).toEqual({ status: 'done', result: 'second time', error: null });
  });

  it('starts nothing while a run is pending, so that a second click does not open the wallet twice', async () => {
    const gate = deferred<string>();
    const body = vi.fn(async (_label: string) => gate.promise);
    const action = createAsyncAction(body);
    const first = action.run('first');
    const second = action.run('second');
    expect(second).toBe(first);
    expect(body).toHaveBeenCalledTimes(1);
    gate.resolve('signed');
    expect(await Promise.all([first, second])).toEqual(['signed', 'signed']);
    await action.run('third');
    expect(body).toHaveBeenCalledTimes(2);
  });

  it('drops the outcome of a run that was reset away', async () => {
    const gate = deferred<string>();
    const action = createAsyncAction(async () => gate.promise);
    const run = action.run();
    action.reset();
    expect(action.get().status).toBe('idle');
    gate.resolve('late');
    expect(await run).toBe('late');
    expect(action.get().status).toBe('idle');
  });
});

describe('the session store', () => {
  it('holds who the server says is signed in, nobody, or that it could not be asked', async () => {
    let answer: () => Response = () => Response.json({ error: 'unauthenticated', message: 'sign in first' }, { status: 401 });
    const store = createSessionStore({ api: createApi({ fetch: async () => answer() }), origin: 'https://app.holdfast.test' });
    await store.refresh();
    expect(store.get()).toEqual({ status: 'signed-out', session: null, error: null });

    const me = { address: OWNER.address.toLowerCase(), expiresAt: 5, orgs: [{ id: ORG, name: 'Acme Labs', createdAt: 1, lockEnabled: false }] };
    answer = () => Response.json(me);
    await store.refresh();
    expect(store.get()).toEqual({ status: 'signed-in', session: me, error: null });

    // An unreachable server is not the same as nobody being signed in.
    answer = () => {
      throw new TypeError('Failed to fetch');
    };
    await store.refresh();
    expect(store.get()).toMatchObject({ status: 'unknown', session: null, error: { code: 'network' } });
    answer = () => Response.json({ error: 'unavailable', message: 'the database is unavailable', source: 'database' }, { status: 503 });
    await store.refresh();
    expect(store.get()).toMatchObject({ status: 'unknown', error: { status: 503, code: 'unavailable' } });
  });

  it('does not let an answer to an older question undo what was learnt since', async () => {
    const me = { address: OWNER.address.toLowerCase(), expiresAt: 5, orgs: [] };
    const slow = deferred<Response>();
    let asked = 0;
    const store = createSessionStore({
      api: createApi({
        fetch: async (input) => {
          if (!String(input).endsWith('/api/auth/me')) return Response.json({ ok: true });
          asked += 1;
          // The first question is answered at once; the second is held back.
          return asked === 2 ? slow.promise : Response.json(me);
        },
      }),
    });
    await store.refresh();
    expect(store.get().status).toBe('signed-in');

    // Asked while still signed in, answered after signing out.
    const stale = store.refresh();
    await store.signOut();
    expect(store.get().status).toBe('signed-out');
    slow.resolve(Response.json(me));
    await stale;
    expect(store.get()).toEqual({ status: 'signed-out', session: null, error: null });

    // And a question asked later is answered as usual.
    await store.refresh();
    expect(store.get().status).toBe('signed-in');
  });
});

describe('the EVM wallet store', () => {
  let page: ReturnType<typeof fakeWindow>;

  beforeEach(() => {
    page = fakeWindow();
    vi.stubGlobal('window', page);
  });

  /** A wallet that stays open on the request to connect until the treasurer answers it. */
  function slowToConnect(provider: FakeEvmWallet) {
    const answered = deferred<void>();
    return {
      answer: answered.resolve,
      provider: {
        request: async (args: { method: string; params?: unknown }) => {
          if (args.method === 'eth_requestAccounts') await answered.promise;
          return provider.request(args);
        },
        on: (event: string, listener: (payload: unknown) => void) => provider.on(event, listener),
        removeListener: (event: string, listener: (payload: unknown) => void) => provider.removeListener(event, listener),
      },
    };
  }

  it('never makes a connection of an attempt that was given up while the wallet was open', async () => {
    const provider = new FakeEvmWallet([OWNER]);
    const slow = slowToConnect(provider);
    const wallet = { id: 'slow', name: 'Slow Wallet', icon: null, rdns: 'slow.wallet', provider: slow.provider };
    const store = createEvmWalletStore();

    const connecting = store.connect(wallet);
    const outcome = connecting.then(
      () => 'connected',
      (error: unknown) => (error as ClientError).code,
    );
    expect(store.get().status).toBe('connecting');
    await store.disconnect();
    expect(store.get().status).toBe('disconnected');

    // The treasurer agrees in the wallet after all: too late.
    slow.answer();
    expect(await outcome).toBe('aborted');
    expect(store.get()).toMatchObject({ status: 'disconnected', wallet: null, address: null });
    expect(store.connection()).toBeNull();
    // Nothing of the abandoned attempt is left listening, and the wallet was not asked to withdraw what it had just given.
    expect([provider.listenerCount('accountsChanged'), provider.listenerCount('chainChanged')]).toEqual([0, 0]);
    expect(provider.count('wallet_revokePermissions')).toBe(0);
    expect(page.localStorage.getItem('holdfast.evm.wallet')).toBeNull();
  });

  it('keeps the later of two attempts, whichever wallet answers first', async () => {
    const first = new FakeEvmWallet([OWNER]);
    const second = new FakeEvmWallet([OTHER]);
    const slow = slowToConnect(first);
    const store = createEvmWalletStore();

    const early = store.connect({ id: 'first', name: 'First', icon: null, rdns: 'first.wallet', provider: slow.provider }).then(
      () => 'connected',
      (error: unknown) => (error as ClientError).code,
    );
    const late = await store.connect({ id: 'second', name: 'Second', icon: null, rdns: 'second.wallet', provider: second });
    expect(store.get()).toMatchObject({ status: 'connected', address: OTHER.address, wallet: { name: 'Second' } });

    slow.answer();
    expect(await early).toBe('aborted');
    expect(store.get()).toMatchObject({ status: 'connected', address: OTHER.address, wallet: { name: 'Second' } });
    expect(store.connection()).toBe(late);
    expect(first.listenerCount('accountsChanged')).toBe(0);
    expect(page.localStorage.getItem('holdfast.evm.wallet')).toBe('second.wallet');
  });

  it('disconnects the wallet before when another takes its place, and only lets go when it is the same one again', async () => {
    const first = new FakeEvmWallet([OWNER]);
    const second = new FakeEvmWallet([OTHER]);
    const store = createEvmWalletStore();
    const one = { id: 'first', name: 'First', icon: null, rdns: 'first.wallet', provider: first };

    const earlier = await store.connect(one);
    const again = await store.connect(one);
    // The same wallet connected a second time: one connection follows it, and it keeps the site's access.
    expect(again).not.toBe(earlier);
    expect(store.connection()).toBe(again);
    expect(first.listenerCount('accountsChanged')).toBe(1);
    expect(first.authorized).toBe(true);
    expect(earlier.state()).toEqual({ address: null, chainId: null });

    await store.connect({ id: 'second', name: 'Second', icon: null, rdns: 'second.wallet', provider: second });
    expect(store.get()).toMatchObject({ status: 'connected', address: OTHER.address });
    await vi.waitFor(() => expect(first.authorized).toBe(false));
    expect(first.listenerCount('accountsChanged')).toBe(0);
    expect(second.listenerCount('accountsChanged')).toBe(1);
  });

  it('does not give up on a wallet being connected because the one before it locked', async () => {
    const first = new FakeEvmWallet([OWNER]);
    const second = new FakeEvmWallet([OTHER]);
    const slow = slowToConnect(second);
    const store = createEvmWalletStore();
    await store.connect({ id: 'first', name: 'First', icon: null, rdns: 'first.wallet', provider: first });

    const connecting = store.connect({ id: 'second', name: 'Second', icon: null, rdns: 'second.wallet', provider: slow.provider });
    first.selectAccounts([]);
    expect(store.get()).toMatchObject({ status: 'connecting', address: null, wallet: { name: 'Second' } });
    expect(store.connection()).toBeNull();

    slow.answer();
    await connecting;
    expect(store.get()).toMatchObject({ status: 'connected', address: OTHER.address, wallet: { name: 'Second' } });
  });

  it('lists the wallets while anybody watches, and connects to one', async () => {
    const provider = new FakeEvmWallet([OWNER], 8_453);
    announce(page, provider, { uuid: 'uuid-1', name: 'Rabby', rdns: 'io.rabby' });
    const store = createEvmWalletStore();
    expect(store.get()).toEqual({ wallets: [], status: 'disconnected', wallet: null, address: null, chainId: null, error: null });

    const stopFirst = store.watch();
    const stopSecond = store.watch();
    const [wallet] = store.get().wallets;
    expect(wallet?.name).toBe('Rabby');
    if (wallet === undefined) throw new Error('unreachable');

    const connecting = store.connect(wallet);
    expect(store.get()).toMatchObject({ status: 'connecting', wallet });
    const connection = await connecting;
    expect(store.get()).toMatchObject({ status: 'connected', wallet, address: OWNER.address, chainId: 8_453, error: null });
    expect(store.connection()).toBe(connection);
    expect(page.localStorage.getItem('holdfast.evm.wallet')).toBe('io.rabby');

    // The watch ends with its last watcher.
    stopFirst();
    stopFirst();
    announce(page, new FakeEvmWallet([OTHER]), { uuid: 'uuid-2', name: 'MetaMask', rdns: 'io.metamask' });
    expect(store.get().wallets.map((found) => found.name)).toEqual(['Rabby', 'MetaMask']);
    stopSecond();
    announce(page, new FakeEvmWallet([OTHER]), { uuid: 'uuid-3', name: 'Late', rdns: 'late.wallet' });
    expect(store.get().wallets).toHaveLength(2);
  });

  it('follows the connected wallet, and is disconnected once the wallet locks', async () => {
    const provider = new FakeEvmWallet([OWNER], 1);
    announce(page, provider, { uuid: 'uuid-1', name: 'Rabby', rdns: 'io.rabby' });
    const store = createEvmWalletStore();
    store.watch();
    await store.connect(store.get().wallets[0] as never);

    provider.selectChain(42_161);
    expect(store.get()).toMatchObject({ status: 'connected', address: OWNER.address, chainId: 42_161 });
    provider.selectAccounts([OTHER]);
    expect(store.get()).toMatchObject({ status: 'connected', address: OTHER.address });

    provider.selectAccounts([]);
    expect(store.get()).toMatchObject({ status: 'disconnected', wallet: null, address: null, chainId: null });
    expect(store.connection()).toBeNull();
    expect(page.localStorage.getItem('holdfast.evm.wallet')).toBeNull();
  });

  it('reconnects on the next visit to the wallet used on the last, without opening it', async () => {
    const provider = new FakeEvmWallet([OWNER]);
    announce(page, provider, { uuid: 'uuid-1', name: 'Rabby', rdns: 'io.rabby' });
    const earlier = createEvmWalletStore();
    earlier.watch();
    await earlier.connect(earlier.get().wallets[0] as never);
    const prompts = provider.count('eth_requestAccounts');

    // A new page: a new store, the same browser storage, the same wallet with its permission still granted.
    const later = createEvmWalletStore();
    later.watch();
    await vi.waitFor(() => expect(later.get().status).toBe('connected'));
    expect(later.get()).toMatchObject({ address: OWNER.address, wallet: { rdns: 'io.rabby' } });
    expect(provider.count('eth_requestAccounts')).toBe(prompts);

    // Disconnecting forgets the wallet: the visit after that starts disconnected.
    await later.disconnect();
    expect(later.get()).toMatchObject({ status: 'disconnected', address: null });
    expect(provider.authorized).toBe(false);
    const afterwards = createEvmWalletStore();
    afterwards.watch();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(afterwards.get().status).toBe('disconnected');
  });

  it('does not reconnect to a wallet that has withdrawn its permission since', async () => {
    const provider = new FakeEvmWallet([OWNER]);
    announce(page, provider, { uuid: 'uuid-1', name: 'Rabby', rdns: 'io.rabby' });
    page.localStorage.setItem('holdfast.evm.wallet', 'io.rabby');
    const store = createEvmWalletStore();
    store.watch();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.get().status).toBe('disconnected');
    expect(provider.requests.map((request) => request.method)).toEqual(['eth_accounts']);
  });

  it('keeps why connecting failed, and stays as it was', async () => {
    const provider = new FakeEvmWallet([OWNER]);
    announce(page, provider, { uuid: 'uuid-1', name: 'Rabby', rdns: 'io.rabby' });
    const store = createEvmWalletStore();
    store.watch();
    provider.failNext = { code: 4001, message: 'User rejected the request.' };
    await expect(store.connect(store.get().wallets[0] as never)).rejects.toMatchObject({ code: 'wallet_rejected' });
    expect(store.get()).toMatchObject({ status: 'disconnected', wallet: null, address: null, error: { code: 'wallet_rejected' } });
    expect(page.localStorage.getItem('holdfast.evm.wallet')).toBeNull();

    await store.connect(store.get().wallets[0] as never);
    expect(store.get()).toMatchObject({ status: 'connected', error: null });
  });
});

describe('the Solana wallet store', () => {
  const registered: (() => void)[] = [];
  afterEach(() => {
    for (const unregister of registered.splice(0)) unregister();
  });

  it('lists, connects, follows and reconnects the way the EVM one does', async () => {
    const page = fakeWindow();
    vi.stubGlobal('window', page);
    const fake = await fakeSolanaWallet({ name: 'Phantom' });
    registered.push(getWallets().register(fake.wallet));

    const store = createSolanaWalletStore();
    expect(store.get()).toEqual({ wallets: [], status: 'disconnected', wallet: null, address: null, error: null });
    const stop = store.watch();
    const [wallet] = store.get().wallets;
    if (wallet === undefined) throw new Error('the wallet is not listed');

    const connection = await store.connect(wallet, fake.address);
    expect(store.get()).toMatchObject({ status: 'connected', wallet, address: fake.address, error: null });
    expect(store.connection()).toBe(connection);
    expect(page.localStorage.getItem('holdfast.solana.wallet')).toBe('standard:Phantom');

    const next = await fake.switchAccount();
    expect(store.get()).toMatchObject({ status: 'connected', address: next });

    const later = createSolanaWalletStore();
    later.watch();
    await vi.waitFor(() => expect(later.get().status).toBe('connected'));
    expect(later.get().address).toBe(next);
    expect(fake.prompts).toBe(1);

    await store.disconnect();
    expect(store.get()).toMatchObject({ status: 'disconnected', wallet: null, address: null });
    expect(page.localStorage.getItem('holdfast.solana.wallet')).toBeNull();
    stop();
  });
});

describe('the Tempo account store', () => {
  it('follows the account from nothing, through a passkey not yet recorded, to ready', async () => {
    vi.stubGlobal('window', fakeWindow());
    const authenticator = softwareAuthenticator();
    let down = true;
    const api = createApi({
      fetch: async (_input, init) => {
        if (down) return Response.json({ error: 'unavailable', message: 'the database is unavailable', source: 'database' }, { status: 503 });
        return Response.json({ id: ORG, tempoAccount: (JSON.parse(String(init?.body)) as { tempoAccount: string }).tempoAccount });
      },
    });
    const store = createTempoAccountStore({ api, createFn: authenticator.createFn });
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.get().status));
    expect(store.get()).toEqual({ status: 'loading', address: null, passkey: null });
    await expect(store.create('Acme Labs payroll')).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(store.link()).rejects.toMatchObject({ code: 'invalid_argument' });

    store.show({ id: ORG, tempoAccount: null });
    expect(store.get()).toEqual({ status: 'none', address: null, passkey: null });
    await expect(store.link()).rejects.toMatchObject({ code: 'invalid_argument', message: 'there is no passkey waiting to be recorded' });

    // The passkey is made, and the server cannot be told of it.
    await expect(store.create('Acme Labs payroll')).rejects.toMatchObject({ status: 503 });
    const pending = store.get();
    expect(pending.status).toBe('pending');
    expect(authenticator.created).toHaveLength(1);

    down = false;
    const org = await store.link();
    expect(org.tempoAccount).toBe(pending.address);
    // Ready at once, though the organisation the store was shown does not name the account yet.
    expect(store.get()).toEqual({ status: 'ready', address: pending.address, passkey: pending.passkey });
    store.show({ id: ORG, tempoAccount: pending.address });
    expect(store.get().status).toBe('ready');
    expect(authenticator.created).toHaveLength(1);

    // Another organisation is another account; none is shown while none is read.
    store.show({ id: 'another-org', tempoAccount: null });
    expect(store.get().status).toBe('none');
    store.show({ id: 'another-org', tempoAccount: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' });
    expect(store.get()).toEqual({ status: 'elsewhere', address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', passkey: null });
    store.show(null);
    expect(store.get().status).toBe('loading');
    expect(seen.at(-1)).toBe('loading');
  });

  it('finds the passkey of an account again, and is ready then', async () => {
    const page = fakeWindow();
    vi.stubGlobal('window', page);
    const authenticator = softwareAuthenticator();
    const api = createApi({ fetch: async (_input, init) => Response.json({ id: ORG, tempoAccount: (JSON.parse(String(init?.body)) as { tempoAccount: string }).tempoAccount }) });
    const made = createTempoAccountStore({ api, createFn: authenticator.createFn });
    made.show({ id: ORG, tempoAccount: null });
    const { tempoAccount } = await made.create('Acme Labs payroll');
    await expect(made.recover()).rejects.toMatchObject({ code: 'invalid_argument' });

    // The same organisation, seen from a browser that never held the passkey's public key.
    page.localStorage.clear();
    const store = createTempoAccountStore({ api, getFn: authenticator.getFn });
    store.show({ id: ORG, tempoAccount });
    expect(store.get()).toEqual({ status: 'elsewhere', address: tempoAccount, passkey: null });

    authenticator.declineNext = true;
    await expect(store.recover()).rejects.toMatchObject({ code: 'wallet_rejected' });
    expect(store.get().status).toBe('elsewhere');

    const passkey = await store.recover();
    expect(passkey.address).toBe(tempoAccount);
    expect(store.get()).toEqual({ status: 'ready', address: tempoAccount, passkey });
  });

  it('creates and records in one step when nothing is in the way', async () => {
    vi.stubGlobal('window', fakeWindow());
    const authenticator = softwareAuthenticator();
    const api = createApi({ fetch: async (_input, init) => Response.json({ id: ORG, tempoAccount: (JSON.parse(String(init?.body)) as { tempoAccount: string }).tempoAccount }) });
    const store = createTempoAccountStore({ api, createFn: authenticator.createFn });
    store.show({ id: ORG, tempoAccount: null });
    const org = await store.create('Acme Labs payroll');
    expect(store.get()).toMatchObject({ status: 'ready', address: org.tempoAccount });
  });
});

describe('the hooks', () => {
  it('render on the server, and in the browser’s first pass, with nothing connected and nothing asked', () => {
    expect(typeof window).toBe('undefined');
    const fetched = vi.fn();
    vi.stubGlobal('fetch', fetched);
    const seen: { session?: UseSession; evm?: UseEvmWallet; solana?: UseSolanaWallet; tempo?: UseTempoAccount; none?: UseTempoAccount; action?: UseAsyncAction<[number], number> } = {};
    function Probe() {
      seen.session = useSession();
      seen.evm = useEvmWallet();
      seen.solana = useSolanaWallet();
      seen.tempo = useTempoAccount({ id: ORG, tempoAccount: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' });
      seen.none = useTempoAccount(null);
      seen.action = useAsyncAction(async (n: number) => n * 2);
      return null;
    }
    expect(renderToString(createElement(Probe))).toBe('');

    expect(seen.session).toMatchObject({ status: 'loading', session: null, error: null });
    expect(seen.evm).toMatchObject({ wallets: [], status: 'disconnected', wallet: null, address: null, chainId: null, error: null, connection: null });
    expect(seen.solana).toMatchObject({ wallets: [], status: 'disconnected', wallet: null, address: null, error: null, connection: null });
    expect(seen.tempo).toMatchObject({ status: 'loading', address: null, passkey: null, root: null });
    expect(seen.none).toMatchObject({ status: 'loading', root: null });
    expect(seen.action).toMatchObject({ status: 'idle', result: null, error: null });
    for (const value of [seen.session?.signIn, seen.session?.signOut, seen.session?.refresh, seen.evm?.connect, seen.evm?.disconnect, seen.solana?.connect, seen.tempo?.create, seen.tempo?.link, seen.action?.run, seen.action?.reset]) {
      expect(typeof value).toBe('function');
    }
    // Rendering is not a reason to ask the server anything.
    expect(fetched).not.toHaveBeenCalled();
  });

  it('let an action be run through the hook’s own function', async () => {
    let captured: UseAsyncAction<[number], number> | undefined;
    function Probe() {
      captured = useAsyncAction(async (n: number) => n * 2);
      return null;
    }
    renderToString(createElement(Probe));
    expect(await captured?.run(21)).toBe(42);
  });
});

describe('importing the client', () => {
  it('touches no window: every module loads where there is none', async () => {
    expect(typeof window).toBe('undefined');
    const modules = await Promise.all([
      import('../../src/client/api'),
      import('../../src/client/errors'),
      import('../../src/client/evm'),
      import('../../src/client/session'),
      import('../../src/client/hyperliquid'),
      import('../../src/client/tempo'),
      import('../../src/client/solana'),
      import('../../src/client/zcash'),
      import('../../src/client/qr'),
      import('../../src/client/stores'),
      import('../../src/client/hooks'),
    ]);
    expect(modules.every((module) => Object.keys(module).length > 0)).toBe(true);
  });
});
