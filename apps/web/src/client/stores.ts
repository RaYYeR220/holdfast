import type { Address } from 'viem';
import { type Api, type Me, type Organisation, api as defaultApi } from './api';
import { ClientError, toClientError } from './errors';
import { type EvmConnection, type EvmWallet, connectEvmWallet, watchEvmWallets } from './evm';
import { readSession, signIn, signOut } from './session';
import { type SolanaConnection, type SolanaWallet, connectSolanaWallet, watchSolanaWallets } from './solana';
import { type CreatePasskeyOptions, type RootOptions, type StoredPasskey, createTempoAccount, linkTempoAccount, pendingPasskey, recoverPasskey, storedPasskey } from './tempo';

/**
 * The state behind the hooks, kept outside React: each store holds one value,
 * tells its listeners when the value is replaced, and never changes a value
 * in place. The hooks in `hooks.ts` only subscribe to these.
 */

export interface Store<T> {
  /** The value the store starts with, which is what a page rendered on the server shows. */
  readonly initial: T;
  get(): T;
  /** Returns the function that stops the listener. */
  subscribe(listener: () => void): () => void;
}

interface Cell<T> extends Store<T> {
  set(next: T): void;
}

function cell<T>(initial: T): Cell<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    initial,
    get: () => value,
    set(next) {
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** A value this browser remembers between visits. Where storage is denied, nothing is remembered. */
function remembered(key: string) {
  const storage = (): Storage | null => {
    try {
      return typeof window === 'undefined' ? null : window.localStorage;
    } catch {
      return null;
    }
  };
  return {
    read: (): string | null => {
      try {
        return storage()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    write: (value: string | null): void => {
      try {
        if (value === null) storage()?.removeItem(key);
        else storage()?.setItem(key, value);
      } catch {
        // Not remembered; the wallet is simply chosen again on the next visit.
      }
    },
  };
}

// One action at a time.

export type AsyncState<R> =
  | { status: 'idle'; result: null; error: null }
  | { status: 'pending'; result: null; error: null }
  | { status: 'done'; result: R; error: null }
  | { status: 'failed'; result: null; error: ClientError };

export interface AsyncAction<A extends unknown[], R> extends Store<AsyncState<R>> {
  /**
   * Run the action. It does not reject: the outcome is in the state, and the
   * promise resolves with the result, or with undefined when the action
   * failed. While a run is pending, another call starts nothing and resolves
   * with that run, so a second click cannot open the wallet twice.
   */
  run(...args: A): Promise<R | undefined>;
  /** Back to idle. A run still pending is left to finish and its outcome is dropped. */
  reset(): void;
}

const IDLE = { status: 'idle', result: null, error: null } as const;
const PENDING = { status: 'pending', result: null, error: null } as const;

export function createAsyncAction<A extends unknown[], R>(action: (...args: A) => Promise<R>): AsyncAction<A, R> {
  const state = cell<AsyncState<R>>(IDLE);
  let pending: Promise<R | undefined> | null = null;
  let generation = 0;
  return {
    initial: state.initial,
    get: state.get,
    subscribe: state.subscribe,
    run(...args) {
      if (pending !== null) return pending;
      const mine = ++generation;
      state.set(PENDING);
      const settle = async (): Promise<R | undefined> => {
        try {
          const result = await action(...args);
          if (mine === generation) state.set({ status: 'done', result, error: null });
          return result;
        } catch (error) {
          if (mine === generation) state.set({ status: 'failed', result: null, error: toClientError(error) });
          return undefined;
        }
      };
      const run: Promise<R | undefined> = settle().finally(() => {
        if (pending === run) pending = null;
      });
      pending = run;
      return run;
    },
    reset() {
      generation += 1;
      pending = null;
      state.set(IDLE);
    },
  };
}

// Who is signed in.

export type SessionState =
  /** The server has not answered yet. */
  | { status: 'loading'; session: null; error: null }
  | { status: 'signed-out'; session: null; error: null }
  | { status: 'signed-in'; session: Me; error: null }
  /** The server could not be asked. Whether anybody is signed in is not known. */
  | { status: 'unknown'; session: null; error: ClientError };

export interface SessionStore extends Store<SessionState> {
  /** Ask the server who is signed in. Never rejects; a failure becomes the `unknown` state. */
  refresh(): Promise<void>;
  /** Ask once, the first time anything wants to know. */
  load(): void;
  /** Sign in with the account of a wallet. Rejects when it fails; whoever was signed in before stays signed in. */
  signIn(connection: EvmConnection): Promise<Me>;
  signOut(): Promise<void>;
}

export function createSessionStore(options: { api?: Api; origin?: string } = {}): SessionStore {
  const api = options.api ?? defaultApi;
  const state = cell<SessionState>({ status: 'loading', session: null, error: null });
  let loaded = false;
  // What the server last said counts. An answer to a question asked before something newer was learnt is dropped.
  let learnt = 0;
  const show = (session: Me | null) => state.set(session === null ? { status: 'signed-out', session: null, error: null } : { status: 'signed-in', session, error: null });

  const store: SessionStore = {
    initial: state.initial,
    get: state.get,
    subscribe: state.subscribe,
    async refresh() {
      loaded = true;
      const asked = ++learnt;
      try {
        const session = await readSession({ api });
        if (asked === learnt) show(session);
      } catch (error) {
        if (asked === learnt) state.set({ status: 'unknown', session: null, error: toClientError(error, 'network') });
      }
    },
    load() {
      if (!loaded) void store.refresh();
    },
    async signIn(connection) {
      const session = await signIn(connection, { api, ...(options.origin === undefined ? {} : { origin: options.origin }) });
      loaded = true;
      learnt += 1;
      show(session);
      return session;
    },
    async signOut() {
      await signOut({ api });
      loaded = true;
      learnt += 1;
      show(null);
    },
  };
  return store;
}

// The wallets.

/** What a store needs of a connection to a wallet, whichever chain the wallet is for. */
interface Followed<W> {
  readonly wallet: W;
  subscribe(listener: () => void): () => void;
  close(): void;
  disconnect(): Promise<void>;
}

/** What tells one kind of wallet from another: how its wallets are found, opened and read. */
interface WalletKind<W, C extends Followed<W>, V extends object> {
  /** Where the browser remembers the wallet used last. */
  remember: string;
  /** The name a wallet goes by between visits. */
  nameOf(wallet: W): string;
  /** Whether two entries are one wallet underneath. */
  sameWallet(a: W, b: W): boolean;
  watch(listener: (wallets: W[]) => void): () => void;
  /** Connect: with a prompt, or silently, in which case null means the wallet does not know the site. */
  open(wallet: W, options: { silent: boolean; hint?: string }): Promise<C | null>;
  /** What the connection shows now; null once the wallet has withdrawn its account. */
  view(connection: C): V | null;
  /** What is shown while nothing is connected. */
  none: V;
}

type WalletStatus = 'disconnected' | 'connecting' | 'connected';
type WalletState<W, V> = { wallets: W[]; status: WalletStatus; wallet: W | null; error: ClientError | null } & V;

interface WalletStore<W, C, V> extends Store<WalletState<W, V>> {
  watch(): () => void;
  connect(wallet: W, hint?: string): Promise<C>;
  disconnect(): Promise<void>;
  connection(): C | null;
}

/**
 * The state of one kind of wallet for the whole page: the wallets found, and
 * at most one connection. Every attempt to connect is numbered, and an
 * attempt that was given up while its wallet was still open (by a
 * disconnect, or by a later attempt) is let go of when it comes back and
 * never becomes the connection.
 */
function createWalletStore<W, C extends Followed<W>, V extends object>(kind: WalletKind<W, C, V>): WalletStore<W, C, V> {
  type State = WalletState<W, V>;
  const state = cell<State>({ wallets: [], status: 'disconnected', wallet: null, error: null, ...kind.none });
  const last = remembered(kind.remember);
  const show = (patch: Partial<State>): void => state.set({ ...state.get(), ...patch });
  const nothing = (error: ClientError | null = null): Partial<State> => ({ status: 'disconnected', wallet: null, error, ...kind.none }) as Partial<State>;
  let connection: C | null = null;
  let unfollow: (() => void) | null = null;
  let watchers = 0;
  let stopWatching: (() => void) | null = null;
  let attempt = 0;
  let restored = false;

  /** Stop treating the present connection as the connection. Its wallet is told nothing. */
  const release = (): C | null => {
    const ended = connection;
    connection = null;
    unfollow?.();
    unfollow = null;
    return ended;
  };

  const adopt = (made: C): void => {
    const previous = release();
    if (previous !== null && previous !== made) {
      // Another wallet takes the place of the one before, which is disconnected. The same wallet connected again is only let go of.
      if (kind.sameWallet(previous.wallet, made.wallet)) previous.close();
      else void previous.disconnect();
    }
    connection = made;
    const follow = (): void => {
      if (connection !== made) return;
      const view = kind.view(made);
      if (view !== null) {
        show({ status: 'connected', wallet: made.wallet, error: null, ...view } as Partial<State>);
        return;
      }
      // The wallet withdrew its account by itself. An attempt to connect that is under way is not this connection's to end.
      release()?.close();
      last.write(null);
      show(state.get().status === 'connecting' ? (kind.none as Partial<State>) : nothing());
    };
    unfollow = made.subscribe(follow);
    follow();
  };

  const restore = (wallets: W[]): void => {
    const wanted = last.read();
    const wallet = wanted === null ? undefined : wallets.find((candidate) => kind.nameOf(candidate) === wanted);
    if (restored || wallet === undefined || state.get().status !== 'disconnected') return;
    restored = true;
    const mine = ++attempt;
    void kind
      .open(wallet, { silent: true })
      .then((made) => {
        if (made === null) return;
        if (mine === attempt) adopt(made);
        else made.close();
      })
      .catch(() => undefined);
  };

  return {
    initial: state.initial,
    get: state.get,
    subscribe: state.subscribe,
    watch() {
      watchers += 1;
      if (stopWatching === null) {
        stopWatching = kind.watch((wallets) => {
          show({ wallets } as Partial<State>);
          restore(wallets);
        });
      }
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        watchers -= 1;
        if (watchers === 0) {
          stopWatching?.();
          stopWatching = null;
        }
      };
    },
    async connect(wallet, hint) {
      const mine = ++attempt;
      show({ status: 'connecting', wallet, error: null } as Partial<State>);
      let made: C | null;
      try {
        made = await kind.open(wallet, { silent: false, ...(hint === undefined ? {} : { hint }) });
        if (made === null) throw new ClientError('wallet_unavailable', 'the wallet shared no account');
      } catch (error) {
        const failure = toClientError(error);
        if (mine === attempt) {
          const kept = connection === null ? null : kind.view(connection);
          show(connection === null || kept === null ? nothing(failure) : ({ status: 'connected', wallet: connection.wallet, error: failure, ...kept } as Partial<State>));
        }
        throw failure;
      }
      if (mine !== attempt) {
        made.close();
        throw new ClientError('aborted', 'connecting was given up');
      }
      adopt(made);
      last.write(kind.nameOf(wallet));
      return made;
    },
    async disconnect() {
      attempt += 1;
      const ended = release();
      last.write(null);
      show(nothing());
      await ended?.disconnect();
    },
    connection: () => connection,
  };
}

export interface EvmWalletState {
  /** The wallets this browser has. */
  wallets: EvmWallet[];
  status: 'disconnected' | 'connecting' | 'connected';
  /** The wallet connected, or being connected to. */
  wallet: EvmWallet | null;
  /** The account the connected wallet has selected. */
  address: Address | null;
  chainId: number | null;
  /** Why the last attempt to connect failed. */
  error: ClientError | null;
}

export interface EvmWalletStore extends Store<EvmWalletState> {
  /**
   * Start looking for wallets and, the first time, reconnect without a
   * prompt to the wallet used on the last visit. Returns the function that
   * ends this caller's interest; the watch stops when nobody is left.
   */
  watch(): () => void;
  /**
   * Connect to a wallet, which opens it. Rejects when it fails, with the
   * reason also in the state, and with `aborted` when the attempt was given
   * up before the wallet answered. A wallet connected before is disconnected.
   */
  connect(wallet: EvmWallet): Promise<EvmConnection>;
  disconnect(): Promise<void>;
  /** The connection to sign with; null while there is none. */
  connection(): EvmConnection | null;
}

export function createEvmWalletStore(): EvmWalletStore {
  return createWalletStore<EvmWallet, EvmConnection, Pick<EvmWalletState, 'address' | 'chainId'>>({
    remember: 'holdfast.evm.wallet',
    nameOf: (wallet) => wallet.rdns ?? wallet.id,
    sameWallet: (a, b) => a.provider === b.provider,
    watch: watchEvmWallets,
    open: (wallet, { silent }) => (silent ? connectEvmWallet(wallet, { silent: true }) : connectEvmWallet(wallet)),
    view(connection) {
      const { address, chainId } = connection.state();
      return address === null ? null : { address, chainId };
    },
    none: { address: null, chainId: null },
  });
}

export interface SolanaWalletState {
  wallets: SolanaWallet[];
  status: 'disconnected' | 'connecting' | 'connected';
  wallet: SolanaWallet | null;
  /** The account the connected wallet shares, in base58. */
  address: string | null;
  error: ClientError | null;
}

export interface SolanaWalletStore extends Store<SolanaWalletState> {
  /** As `EvmWalletStore.watch`. */
  watch(): () => void;
  /** As `EvmWalletStore.connect`. `address` is the account wanted when the wallet shares several. */
  connect(wallet: SolanaWallet, address?: string): Promise<SolanaConnection>;
  disconnect(): Promise<void>;
  connection(): SolanaConnection | null;
}

export function createSolanaWalletStore(): SolanaWalletStore {
  return createWalletStore<SolanaWallet, SolanaConnection, Pick<SolanaWalletState, 'address'>>({
    remember: 'holdfast.solana.wallet',
    nameOf: (wallet) => wallet.id,
    sameWallet: (a, b) => a.handle === b.handle,
    watch: watchSolanaWallets,
    open: (wallet, { silent, hint }) => (silent ? connectSolanaWallet(wallet, { silent: true }) : connectSolanaWallet(wallet, hint === undefined ? {} : { address: hint })),
    view(connection) {
      const address = connection.address();
      return address === null ? null : { address };
    },
    none: { address: null },
  });
}

// The Tempo account.

export type TempoAccountState =
  /** The organisation is not read yet, or this browser has not been looked at. */
  | { status: 'loading'; address: null; passkey: null }
  /** The organisation names no Tempo account and no passkey is waiting to become one. */
  | { status: 'none'; address: null; passkey: null }
  /** A passkey was created here for the organisation, and its account is not in the organisation's profile yet. */
  | { status: 'pending'; address: Address; passkey: StoredPasskey }
  /** The organisation's account, with its passkey known to this browser: it can sign here. */
  | { status: 'ready'; address: Address; passkey: StoredPasskey }
  /** The organisation's account was made in another browser, or this one has lost its public key: it cannot sign here. */
  | { status: 'elsewhere'; address: string; passkey: null };

interface TempoOrganisation {
  id: string;
  tempoAccount: string | null;
}

/**
 * Where the organisation's Tempo account stands in this browser. Reads
 * `localStorage` and nothing else; a browser that denies the page its storage
 * knows no passkey.
 */
export function tempoAccountState(org: TempoOrganisation): Exclude<TempoAccountState, { status: 'loading' }> {
  const known = (find: () => StoredPasskey | null): StoredPasskey | null => {
    try {
      return find();
    } catch {
      return null;
    }
  };
  const { id, tempoAccount } = org;
  if (tempoAccount !== null) {
    const passkey = known(() => storedPasskey(tempoAccount));
    return passkey === null ? { status: 'elsewhere', address: tempoAccount, passkey: null } : { status: 'ready', address: passkey.address, passkey };
  }
  const pending = known(() => pendingPasskey(id));
  return pending === null ? { status: 'none', address: null, passkey: null } : { status: 'pending', address: pending.address, passkey: pending };
}

export interface TempoAccountStore extends Store<TempoAccountState> {
  /** Say which organisation this is about, as last read from the server; null while it is not read. */
  show(org: TempoOrganisation | null): void;
  /**
   * Create the account: a new passkey, kept in this browser, and its address
   * recorded in the organisation's profile. Resolves with the organisation
   * as the server then has it. When it is the recording that fails, the
   * passkey stays, the state becomes `pending`, and `link` finishes the job.
   */
  create(label: string): Promise<Organisation>;
  /** Record the account of a `pending` passkey in the organisation's profile. */
  link(): Promise<Organisation>;
  /**
   * For an account that is `elsewhere`: have the treasurer pick its passkey,
   * and learn its public key again from the signature. One passkey prompt.
   * Rejects with `wrong_account` when the passkey picked is another account's.
   */
  recover(): Promise<StoredPasskey>;
}

const TEMPO_LOADING = { status: 'loading', address: null, passkey: null } as const;

export function createTempoAccountStore(options: { api?: Api; createFn?: CreatePasskeyOptions['createFn']; getFn?: RootOptions['getFn'] } = {}): TempoAccountStore {
  const state = cell<TempoAccountState>(TEMPO_LOADING);
  const flow = options.api === undefined ? {} : { api: options.api };
  let shown: TempoOrganisation | null = null;
  // The account this store recorded itself, until the organisation it is shown names it too.
  let recorded: { id: string; tempoAccount: string } | null = null;

  const look = (): void => {
    if (shown === null) {
      state.set(TEMPO_LOADING);
      return;
    }
    const mine = recorded !== null && recorded.id === shown.id ? recorded.tempoAccount : null;
    state.set(tempoAccountState({ id: shown.id, tempoAccount: shown.tempoAccount ?? mine }));
  };

  /** Do what records the account, then look again, whichever way it went. */
  const recording = async (record: (orgId: string) => Promise<Organisation>): Promise<Organisation> => {
    if (shown === null) throw new ClientError('invalid_argument', 'the organisation is not read yet');
    const { id } = shown;
    try {
      const updated = await record(id);
      if (updated.tempoAccount !== null) recorded = { id, tempoAccount: updated.tempoAccount };
      return updated;
    } finally {
      look();
    }
  };

  return {
    initial: state.initial,
    get: state.get,
    subscribe: state.subscribe,
    show(org) {
      shown = org === null ? null : { id: org.id, tempoAccount: org.tempoAccount };
      look();
    },
    create: (label) => recording(async (orgId) => (await createTempoAccount(orgId, { label, ...flow, ...(options.createFn === undefined ? {} : { createFn: options.createFn }) })).org),
    link: () =>
      recording(async (orgId) => {
        const current = state.get();
        if (current.status !== 'pending') throw new ClientError('invalid_argument', 'there is no passkey waiting to be recorded');
        return linkTempoAccount(orgId, current.address, flow);
      }),
    async recover() {
      const current = state.get();
      if (current.status !== 'elsewhere') throw new ClientError('invalid_argument', 'there is no account here whose passkey has to be found again');
      try {
        return await recoverPasskey(current.address, options.getFn === undefined ? {} : { getFn: options.getFn });
      } finally {
        look();
      }
    },
  };
}
