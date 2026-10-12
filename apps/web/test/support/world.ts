import type { Bar } from '@holdfast/core';
import { type OrgRecord, PgStore, type PgliteConnection } from '@holdfast/db';
import { type JournalEntry, tick } from '@holdfast/engine';
import { createOneClick } from '@holdfast/intents';
import { TOKENS } from '@holdfast/tempo';
import { checkUfvk } from '@holdfast/zcash';
import { testDeriveKeys } from '@ledgerhq/zcash-utils';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from 'viem/accounts';
import market from '../../../../packages/core/data/zec-1h.json';
import { Chain, Clock } from '../../../../packages/db/test/support/fakes';
import { MASTER_KEY } from '../../../../packages/db/test/support/stores';
import { type Body, fakeHyperliquid } from '../../../../packages/hyperliquid/test/support';
import { FakeChain, ROOT } from '../../../../packages/tempo/test/fake-chain';
import { hyperliquidPort } from '../../src/server/adapters/hyperliquid';
import { tempoPort } from '../../src/server/adapters/tempo';
import { SESSION_COOKIE, issueSession } from '../../src/server/auth/session';
import type { Deps } from '../../src/server/deps';
import type { Endpoint } from '../../src/server/http/endpoint';
import { createOrganisation } from '../../src/server/orgs/service';
import { createRedactor } from '../../src/server/redact';
import { FakeOneClick, FakeReference, FakeSolana, FakeVenue, SOLANA_OWNER } from './fakes';

export { STARTUP_TIMEOUT_MS, migratedPglite } from '../../../../packages/db/test/support/stores';
export { BIRTHDAY, note } from '../../../../packages/db/test/support/fakes';
export { PAYEES, ROOT, ROOT_ACCOUNT, START, policyFor, signAuthorization } from '../../../../packages/tempo/test/fake-chain';

export const HOST = 'app.holdfast.test';
export const ORIGIN = `https://${HOST}`;

/** The standard all-"abandon" test mnemonic; nothing is ever sent to it. Its viewing key is a real one. */
const WORDS = `${'abandon '.repeat(23)}art`;
export const UFVK = testDeriveKeys(WORDS, 0, 'mainnet').ufvk;

export const SESSION_SECRET = new TextEncoder().encode('a-session-secret-used-only-by-the-tests');
export const TICK_SECRET = 'a-tick-secret-used-only-by-the-tests-0123';
export const SPONSOR_KEY: Hex = `0x${'5b'.repeat(32)}`;
/** A URL with a key in it, the way a paid RPC endpoint has one. */
export const RPC_URL = 'https://rpc.example.test/v2/rpc-key-that-must-not-leak';

/** The treasurer: an ordinary account whose key the tests hold. */
export const OWNER = privateKeyToAccount(`0x${'a1'.repeat(32)}`);
export const STRANGER = privateKeyToAccount(`0x${'b2'.repeat(32)}`);

export const BARS = (market as { bars: Bar[] }).bars;

export interface World {
  deps: Deps;
  clock: Clock;
  store: PgStore;
  /** The Zcash chain the scanner reads. */
  chain: Chain;
  venue: FakeVenue;
  /** Hyperliquid's exchange endpoint: what it is sent, and what it answers. */
  exchange: { calls: Body[]; answer: (body: Body) => unknown };
  reference: FakeReference;
  oneClick: FakeOneClick;
  /** The Tempo chain as each access key sees it, made on first use. */
  tempoChain(accessKey: string): FakeChain;
  solana: FakeSolana;
  /** What was written to the error log. */
  reported: string[];
}

/** Every dependency of the application, faked, around a database of the test's. */
export function world(connection: PgliteConnection): World {
  const clock = new Clock();
  const store = new PgStore(connection.db, { masterKey: MASTER_KEY, clockForTests: clock.now });
  const chain = new Chain();
  const venue = new FakeVenue(clock.now);
  const reference = new FakeReference(clock.now);
  const oneClick = new FakeOneClick();
  const solana = new FakeSolana();
  const reported: string[] = [];

  const exchange: World['exchange'] = { calls: [], answer: () => ({ status: 'ok', response: { type: 'default' } }) };
  const hyperliquid = fakeHyperliquid({
    exchange: (body) => {
      exchange.calls.push(body);
      return exchange.answer(body);
    },
  });

  const tempoChains = new Map<string, FakeChain>();
  const sponsor = privateKeyToAddress(SPONSOR_KEY);
  const tempoChain = (accessKey: string): FakeChain => {
    const key = accessKey.toLowerCase();
    let made = tempoChains.get(key);
    if (made === undefined) {
      made = new FakeChain(accessKey as Hex, sponsor);
      tempoChains.set(key, made);
    }
    return made;
  };
  let railClock = 0;

  const secrets = [RPC_URL, TICK_SECRET, SPONSOR_KEY, new TextDecoder().decode(SESSION_SECRET)];
  const deps: Deps = {
    now: clock.now,
    redact: createRedactor(() => secrets),
    knownSecrets: () => secrets,
    report: (message) => void reported.push(message),
    network: 'mainnet',
    secrets: { session: SESSION_SECRET, tick: TICK_SECRET },
    publicHost: null,
    store,
    zcash: { network: 'mainnet', check: (ufvk) => checkUfvk(ufvk, 'mainnet'), scanner: () => chain },
    hyperliquid: { ...hyperliquidPort('mainnet', { fetch: hyperliquid.fetch, now: clock.now }), venue: () => venue },
    reference,
    oneClick: createOneClick({ fetch: oneClick.fetch, now: clock.now }),
    tempo: tempoPort({ network: 'moderato', rpcUrl: undefined, token: TOKENS.moderato.AlphaUSD, tokenSymbol: 'AlphaUSD' }, () => SPONSOR_KEY, (accessKey) => ({
      chain: tempoChain(accessKey),
      sleep: async () => undefined,
      clock: () => (railClock += 1_000),
    })),
    solana,
    bars: async () => BARS,
  };

  return { deps, clock, store, chain, venue, exchange, reference, oneClick, tempoChain, solana, reported };
}

/** An organisation the way the application creates one, owned by `owner`, with both payout accounts set. */
export async function organisation(w: World, owner: string = OWNER.address, over: { name?: string; tempoAccount?: string | null; solanaOwner?: string | null } = {}): Promise<OrgRecord> {
  const created = await createOrganisation(w.deps, owner, {
    name: over.name ?? 'Acme Labs',
    ufvk: UFVK,
    birthday: 3_512_000,
    monthlyBurnUsd: 42_500,
    tempoAccount: over.tempoAccount === undefined ? ROOT : over.tempoAccount,
    solanaOwner: over.solanaOwner === undefined ? SOLANA_OWNER : over.solanaOwner,
  });
  const org = await w.store.findOrg(created.id);
  if (org === null) throw new Error('the organisation was not stored');
  return org;
}

/** One tick of one organisation, a minute after whatever happened last. */
export async function tickOnce(w: World, orgId: string): Promise<JournalEntry> {
  w.clock.advance(60_000);
  const outcome = await tick(orgId, { store: w.store, scanner: w.chain, venue: w.venue, reference: w.reference, now: w.clock.now });
  if (!outcome.ran) throw new Error('the tick did not run');
  return outcome.entry;
}

/** The address of one of an organisation's service keys. */
export async function keyAddress(w: World, orgId: string, kind: 'hl_agent' | 'tempo_access' | 'solana_delegate'): Promise<string> {
  const key = await w.store.activeKey(orgId, kind);
  if (key === null) throw new Error(`the organisation has no ${kind} key`);
  return key.address;
}

/** The Cookie header of a session for `address`, as signing in would have set it. */
export async function sessionOf(w: World, address: string = OWNER.address): Promise<string> {
  const { token } = await issueSession(SESSION_SECRET, address, w.clock.now());
  return `${SESSION_COOKIE}=${token}`;
}

export interface CallOptions {
  /** Path parameters, as the router would hand them over. */
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  /** A Cookie header; see `sessionOf`. */
  cookie?: string;
  /** The Origin header; the application's own unless set. Null sends none. */
  origin?: string | null;
  headers?: Record<string, string>;
  /** Sent as the body exactly as written, in place of `body`. */
  rawBody?: string;
}

export interface Answer {
  status: number;
  /** The parsed JSON body. Loosely typed so that tests can reach into it. */
  body: any;
  text: string;
  headers: Headers;
}

/** Call an endpoint the way a browser on the application's own pages would. */
export async function call(w: World, endpoint: Endpoint, method: string, options: CallOptions = {}): Promise<Answer> {
  const url = new URL(`${ORIGIN}/api/under-test`);
  for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, value);
  const headers = new Headers(options.headers);
  const changesState = method !== 'GET' && method !== 'HEAD';
  if (changesState) {
    if (options.origin !== null) headers.set('origin', options.origin ?? ORIGIN);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  }
  if (options.cookie !== undefined) headers.set('cookie', options.cookie);
  const body = changesState ? (options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body))) : undefined;
  const response = await endpoint(new Request(url, { method, headers, ...(body === undefined ? {} : { body }) }), options.params ?? {}, w.deps);
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed, text, headers: response.headers };
}

/** A fresh private key and its address, for accounts a test needs more of. */
export function newAccount() {
  return privateKeyToAccount(generatePrivateKey());
}
