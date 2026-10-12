'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Me, Organisation } from './api';
import type { EvmConnection, EvmWallet } from './evm';
import type { SolanaConnection, SolanaWallet } from './solana';
import {
  type AsyncState,
  type EvmWalletState,
  type SessionState,
  type SolanaWalletState,
  type Store,
  type TempoAccountState,
  createAsyncAction,
  createEvmWalletStore,
  createSessionStore,
  createSolanaWalletStore,
  createTempoAccountStore,
} from './stores';
import { type StoredPasskey, type TempoRoot, tempoRoot } from './tempo';

/**
 * React hooks over the client. They return plain values and functions and
 * render nothing. The session and the two wallets are each one state for the
 * whole page: every component that uses the hook sees the same one.
 */

const session = createSessionStore();
const evmWallet = createEvmWalletStore();
const solanaWallet = createSolanaWalletStore();

/** The value of a store. On the server, and while the browser takes over what the server rendered, it is the store's starting value. */
function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, () => store.initial);
}

export type UseAsyncAction<A extends unknown[], R> = AsyncState<R> & {
  /** Runs the action once; a call while one is pending starts nothing. Resolves with the result, or undefined when it failed. Never rejects. */
  run: (...args: A) => Promise<R | undefined>;
  /** Back to idle. */
  reset: () => void;
};

/**
 * One asynchronous action and where it stands: `idle`, `pending`, `done`
 * with its result, or `failed` with the error as a `ClientError`. The action
 * may be a new function on every render; the one of the latest render runs.
 */
export function useAsyncAction<A extends unknown[], R>(action: (...args: A) => Promise<R>): UseAsyncAction<A, R> {
  const latest = useRef(action);
  useEffect(() => {
    latest.current = action;
  });
  const [store] = useState(() => createAsyncAction<A, R>((...args) => latest.current(...args)));
  const state = useStore(store);
  return useMemo(() => ({ ...state, run: store.run, reset: store.reset }), [state, store]);
}

export type UseSession = SessionState & {
  /** Sign in with the account of a connected wallet. Rejects with a `ClientError` when it fails. */
  signIn: (connection: EvmConnection) => Promise<Me>;
  signOut: () => Promise<void>;
  /** Ask the server again, for instance after the organisations changed. */
  refresh: () => Promise<void>;
};

/** Who is signed in. The server is asked once, when the first component wants to know. */
export function useSession(): UseSession {
  const state = useStore(session);
  useEffect(() => session.load(), []);
  return useMemo(() => ({ ...state, signIn: session.signIn, signOut: session.signOut, refresh: session.refresh }), [state]);
}

export type UseEvmWallet = EvmWalletState & {
  /** Connect to one of `wallets`, which opens it. Rejects with a `ClientError`; the reason is also in `error`. */
  connect: (wallet: EvmWallet) => Promise<EvmConnection>;
  disconnect: () => Promise<void>;
  /** The connection to hand to `signIn` and `approveHyperliquidAgent`; null while not connected. */
  connection: EvmConnection | null;
};

/**
 * The treasurer's EVM wallet: the wallets found in the browser, and the
 * account and chain of the connected one, kept current as the wallet changes
 * them. A wallet connected on an earlier visit is connected again without a
 * prompt.
 */
export function useEvmWallet(): UseEvmWallet {
  const state = useStore(evmWallet);
  useEffect(() => evmWallet.watch(), []);
  return useMemo(() => ({ ...state, connect: evmWallet.connect, disconnect: evmWallet.disconnect, connection: state.status === 'connected' ? evmWallet.connection() : null }), [state]);
}

export type UseSolanaWallet = SolanaWalletState & {
  /** Connect to one of `wallets`, which opens it. `address` is the account wanted when the wallet shares several. */
  connect: (wallet: SolanaWallet, address?: string) => Promise<SolanaConnection>;
  disconnect: () => Promise<void>;
  /** The connection to hand to `approveSolanaDelegate` and `revokeSolanaDelegate`; null while not connected. */
  connection: SolanaConnection | null;
};

/** The treasurer's Solana wallet, in the same shape as `useEvmWallet`. */
export function useSolanaWallet(): UseSolanaWallet {
  const state = useStore(solanaWallet);
  useEffect(() => solanaWallet.watch(), []);
  return useMemo(() => ({ ...state, connect: solanaWallet.connect, disconnect: solanaWallet.disconnect, connection: state.status === 'connected' ? solanaWallet.connection() : null }), [state]);
}

export type UseTempoAccount = TempoAccountState & {
  /** The account's root, to hand to `authorizeTempoAccessKey`; null unless the status is `ready`. Each signature is one passkey prompt. */
  root: TempoRoot | null;
  /**
   * Create the account: a new passkey, kept in this browser, and its address
   * recorded in the organisation's profile. Resolves with the organisation
   * as the server then has it. Rejects with a `ClientError`; when it was the
   * recording that failed, the status becomes `pending` and `link` finishes it.
   */
  create: (label: string) => Promise<Organisation>;
  /** Record the account of a `pending` passkey in the organisation's profile. */
  link: () => Promise<Organisation>;
  /**
   * For an account that is `elsewhere`: have the treasurer pick its passkey
   * and learn its public key again, after which the status is `ready`. One
   * passkey prompt. Rejects with `wrong_account` for another account's passkey.
   */
  recover: () => Promise<StoredPasskey>;
};

/**
 * The organisation's Tempo account as this browser can use it. `org` is the
 * organisation as last read from the server; null while it is not read yet.
 * `localStorage` is looked at after the first render, so the status starts
 * as `loading` on the server and in the browser alike.
 */
export function useTempoAccount(org: { id: string; tempoAccount: string | null } | null): UseTempoAccount {
  const [store] = useState(() => createTempoAccountStore());
  const id = org?.id ?? null;
  const tempoAccount = org?.tempoAccount ?? null;
  useEffect(() => store.show(id === null ? null : { id, tempoAccount }), [store, id, tempoAccount]);
  const state = useStore(store);

  const ready = state.status === 'ready';
  const credentialId = state.passkey?.credentialId ?? null;
  const publicKey = state.passkey?.publicKey ?? null;
  const root = useMemo(() => (ready && credentialId !== null && publicKey !== null ? tempoRoot({ credentialId, publicKey }) : null), [ready, credentialId, publicKey]);

  return useMemo(() => ({ ...state, root, create: store.create, link: store.link, recover: store.recover }), [state, root, store]);
}

export type { AsyncState, EvmWalletState, SessionState, SolanaWalletState, TempoAccountState };
