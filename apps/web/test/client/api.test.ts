import { DEFAULT_POLICY } from '@holdfast/core';
import type { OrgRecord } from '@holdfast/db';
import { describe, expect, it } from 'vitest';
import { type Api, ClientError, createApi, downloads, isClientError, isNotFound, isUnauthenticated } from '../../src/client/api';
import { SESSION_COOKIE, issueSession } from '../../src/server/auth/session';
import type { Deps } from '../../src/server/deps';
import { OWNER, SESSION_SECRET, TICK_SECRET, type World } from '../support/world';
import { type Method, app, appRoutes, matchRoute } from './support/app';

const ORG = '7b0e7a52-8b65-4f0e-9d3a-2f1c4c1f9a10';
const RUN = 'HF-2026-10-0001';
const SWAP = '3f2b8a4e-5d6c-4b7a-8e9f-0a1b2c3d4e5f';
const LINK = 'ab'.repeat(32);
/** Shaped like a link or receipt token: 32 bytes in base64url. */
const TOKEN = 'holdfast-test_token-'.padEnd(43, 'x');
const PAYEE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const SIGNATURE = `0x${'ab'.repeat(65)}`;
const NOW = 1_791_640_000_000;
const TERMS = { limit: 10_000_000n, periodSeconds: 3_600, expiry: 1_791_726_400, recipients: [PAYEE] };
const WIRE_TERMS = { ...TERMS, limit: '10000000' };

interface Operation {
  name: keyof Api;
  call: (api: Api) => Promise<unknown>;
  method: Method;
  /** The path and query the request is made to. */
  url: string;
  /** The JSON body a state-changing request carries. */
  body?: unknown;
}

const org = (rest = '') => `/api/orgs/${ORG}${rest}`;

/** One call of every function of the client, with the request it has to make. */
const OPERATIONS: Operation[] = [
  { name: 'nonce', call: (api) => api.nonce(), method: 'GET', url: '/api/auth/nonce' },
  { name: 'verify', call: (api) => api.verify({ message: 'a message', signature: SIGNATURE }), method: 'POST', url: '/api/auth/verify', body: { message: 'a message', signature: SIGNATURE } },
  { name: 'logout', call: (api) => api.logout(), method: 'POST', url: '/api/auth/logout', body: {} },
  { name: 'me', call: (api) => api.me(), method: 'GET', url: '/api/auth/me' },

  { name: 'listOrgs', call: (api) => api.listOrgs(), method: 'GET', url: '/api/orgs' },
  {
    name: 'createOrg',
    call: (api) => api.createOrg({ name: 'Acme Labs', ufvk: 'uview1test', birthday: 3_512_000, monthlyBurnUsd: 42_500, tempoAccount: PAYEE, solanaOwner: null }),
    method: 'POST',
    url: '/api/orgs',
    body: { name: 'Acme Labs', ufvk: 'uview1test', birthday: 3_512_000, monthlyBurnUsd: 42_500, tempoAccount: PAYEE, solanaOwner: null },
  },
  { name: 'getOrg', call: (api) => api.getOrg(ORG), method: 'GET', url: org() },
  { name: 'updateOrg', call: (api) => api.updateOrg(ORG, { name: 'Acme', tempoAccount: null }), method: 'PATCH', url: org(), body: { name: 'Acme', tempoAccount: null } },

  { name: 'getPolicy', call: (api) => api.getPolicy(ORG), method: 'GET', url: org('/policy') },
  { name: 'putPolicy', call: (api) => api.putPolicy(ORG, DEFAULT_POLICY), method: 'PUT', url: org('/policy'), body: DEFAULT_POLICY },
  { name: 'setLock', call: (api) => api.setLock(ORG, true), method: 'PUT', url: org('/lock'), body: { enabled: true } },
  { name: 'lockPreview', call: (api) => api.lockPreview(ORG, { swapCostBps: 25 }), method: 'GET', url: org('/lock/preview?swapCostBps=25') },
  { name: 'advisories', call: (api) => api.advisories(ORG), method: 'GET', url: org('/advisories') },

  { name: 'hyperliquidApproval', call: (api) => api.hyperliquidApproval(ORG, { chainId: 1, validUntil: NOW + 86_400_000 }), method: 'GET', url: org(`/hyperliquid/approval?chainId=1&validUntil=${NOW + 86_400_000}`) },
  {
    name: 'submitHyperliquidApproval',
    call: (api) => api.submitHyperliquidApproval(ORG, { nonce: NOW, signature: SIGNATURE, signatureChainId: 1, validUntil: NOW + 86_400_000 }),
    method: 'POST',
    url: org('/hyperliquid/approval'),
    body: { nonce: NOW, signature: SIGNATURE, signatureChainId: 1, validUntil: NOW + 86_400_000 },
  },
  { name: 'hyperliquidState', call: (api) => api.hyperliquidState(ORG), method: 'GET', url: org('/hyperliquid/state') },

  { name: 'tempoRail', call: (api) => api.tempoRail(ORG), method: 'GET', url: org('/rails/tempo') },
  { name: 'tempoAuthorization', call: (api) => api.tempoAuthorization(ORG, TERMS), method: 'POST', url: org('/rails/tempo/authorization'), body: WIRE_TERMS },
  {
    name: 'submitTempoAuthorization',
    call: (api) => api.submitTempoAuthorization(ORG, { terms: TERMS, signedWire: '0xabcd' }),
    method: 'POST',
    url: org('/rails/tempo/authorization/submit'),
    body: { terms: WIRE_TERMS, signedWire: '0xabcd' },
  },
  { name: 'solanaRail', call: (api) => api.solanaRail(ORG), method: 'GET', url: org('/rails/solana') },
  { name: 'solanaApproval', call: (api) => api.solanaApproval(ORG, 5_000_000n), method: 'POST', url: org('/rails/solana/approval'), body: { amount: '5000000' } },
  { name: 'solanaRevoke', call: (api) => api.solanaRevoke(ORG), method: 'POST', url: org('/rails/solana/revoke'), body: {} },

  {
    name: 'quoteFunding',
    call: (api) => api.quoteFunding(ORG, { purpose: 'margin', amountZat: 250_000_000n, refundTo: 't1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs', slippageBps: 50, dry: true }),
    method: 'POST',
    url: org('/funding/quotes'),
    body: { purpose: 'margin', amountZat: '250000000', refundTo: 't1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs', slippageBps: 50, dry: true },
  },
  { name: 'listSwaps', call: (api) => api.listSwaps(ORG), method: 'GET', url: org('/funding/swaps') },
  { name: 'getSwap', call: (api) => api.getSwap(ORG, SWAP), method: 'GET', url: org(`/funding/swaps/${SWAP}`) },

  { name: 'listPayouts', call: (api) => api.listPayouts(ORG), method: 'GET', url: org('/payouts') },
  {
    name: 'createPayout',
    call: (api) => api.createPayout(ORG, { chain: 'tempo', lines: [{ payee: { name: 'Ada', address: PAYEE }, amount: 1_500_000n, reference: 'INV-7' }, { payee: { name: 'Lin', address: PAYEE }, amount: 2n }] }),
    method: 'POST',
    url: org('/payouts'),
    body: { chain: 'tempo', lines: [{ payee: { name: 'Ada', address: PAYEE }, amount: '1500000', reference: 'INV-7' }, { payee: { name: 'Lin', address: PAYEE }, amount: '2' }] },
  },
  { name: 'getPayout', call: (api) => api.getPayout(ORG, RUN), method: 'GET', url: org(`/payouts/${RUN}`) },
  { name: 'previewPayout', call: (api) => api.previewPayout(ORG, RUN), method: 'GET', url: org(`/payouts/${RUN}/preview`) },
  { name: 'executePayout', call: (api) => api.executePayout(ORG, RUN), method: 'POST', url: org(`/payouts/${RUN}/execute`), body: {} },

  { name: 'statement', call: (api) => api.statement(ORG, { from: 1_000, to: NOW }), method: 'GET', url: org(`/books/statement?from=1000&to=${NOW}`) },
  { name: 'statementCsv', call: (api) => api.statementCsv(ORG, { to: NOW }), method: 'GET', url: org(`/books/statement?to=${NOW}&format=csv`) },
  { name: 'reconciliation', call: (api) => api.reconciliation(ORG), method: 'GET', url: org('/books/reconciliation') },
  { name: 'exportStatement', call: (api) => api.exportStatement(ORG), method: 'GET', url: org('/books/export') },
  { name: 'exportLedgerCsv', call: (api) => api.exportLedgerCsv(ORG), method: 'GET', url: org('/books/export?format=csv') },
  { name: 'auditLinks', call: (api) => api.auditLinks(ORG), method: 'GET', url: org('/audit-links') },
  {
    name: 'createAuditLink',
    call: (api) => api.createAuditLink(ORG, { label: 'Auditor', scope: { from: null, to: NOW, modules: ['treasury', 'payouts'] }, expiresAt: NOW + 86_400_000 }),
    method: 'POST',
    url: org('/audit-links'),
    body: { label: 'Auditor', scope: { from: null, to: NOW, modules: ['treasury', 'payouts'] }, expiresAt: NOW + 86_400_000 },
  },
  { name: 'revokeAuditLink', call: (api) => api.revokeAuditLink(ORG, LINK), method: 'DELETE', url: org(`/audit-links/${LINK}`), body: {} },
  { name: 'audit', call: (api) => api.audit(TOKEN), method: 'GET', url: `/api/audit/${TOKEN}` },
  { name: 'auditCsv', call: (api) => api.auditCsv(TOKEN), method: 'GET', url: `/api/audit/${TOKEN}?format=csv` },

  { name: 'safety', call: (api) => api.safety(ORG), method: 'GET', url: org('/safety') },
  { name: 'refusals', call: (api) => api.refusals(ORG), method: 'GET', url: org('/safety/refusals') },
  { name: 'runProbe', call: (api) => api.runProbe(ORG, 'tempo_over_limit'), method: 'POST', url: org('/safety/probes'), body: { kind: 'tempo_over_limit' } },

  { name: 'attestor', call: (api) => api.attestor(ORG), method: 'GET', url: org('/attestor') },
  { name: 'attestations', call: (api) => api.attestations(ORG), method: 'GET', url: org('/attestations') },
  { name: 'openAttestation', call: (api) => api.openAttestation(ORG, { series: 2n, number: '17' }), method: 'POST', url: org('/attestations/2/17/open'), body: {} },

  { name: 'demoAttestations', call: (api) => api.demoAttestations(ORG), method: 'GET', url: `/api/demo/${ORG}/attestations` },
  { name: 'demoEntryProof', call: (api) => api.demoEntryProof(ORG, { series: '0', number: 3n, seq: 12 }), method: 'GET', url: `/api/demo/${ORG}/attestations/0/3/proof?seq=12` },
  { name: 'demoList', call: (api) => api.demoList(), method: 'GET', url: '/api/demo' },
  { name: 'demoOverview', call: (api) => api.demoOverview(ORG), method: 'GET', url: `/api/demo/${ORG}/overview` },
  { name: 'demoJournal', call: (api) => api.demoJournal(ORG, { limit: 20, beforeSeq: 7 }), method: 'GET', url: `/api/demo/${ORG}/journal?limit=20&beforeSeq=7` },
  { name: 'demoReceipts', call: (api) => api.demoReceipts(ORG), method: 'GET', url: `/api/demo/${ORG}/receipts` },
  { name: 'demoPayouts', call: (api) => api.demoPayouts(ORG), method: 'GET', url: `/api/demo/${ORG}/payouts` },
  { name: 'demoSafety', call: (api) => api.demoSafety(ORG), method: 'GET', url: `/api/demo/${ORG}/safety` },
  { name: 'demoBooks', call: (api) => api.demoBooks(ORG), method: 'GET', url: `/api/demo/${ORG}/books` },
  { name: 'scorecard', call: (api) => api.scorecard(), method: 'GET', url: '/api/backtest/scorecard' },
  { name: 'series', call: (api) => api.series('covid crash'), method: 'GET', url: '/api/backtest/series?scenario=covid%20crash' },
  { name: 'receipt', call: (api) => api.receipt(TOKEN), method: 'GET', url: `/api/receipts/${TOKEN}` },

  { name: 'tick', call: (api) => api.tick(TICK_SECRET), method: 'POST', url: '/api/tick', body: {} },
];

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
  credentials: RequestCredentials | undefined;
  cache: RequestCache | undefined;
}

/** A `fetch` that keeps what it was asked and answers with whatever `answer` makes. */
function recorder(answer: (seen: Seen) => Response | Promise<Response> = () => Response.json({ ok: true })) {
  const calls: Seen[] = [];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const seen: Seen = { url: String(input), method: init.method ?? 'GET', headers: new Headers(init.headers), body: typeof init.body === 'string' ? init.body : undefined, credentials: init.credentials, cache: init.cache };
    calls.push(seen);
    return answer(seen);
  };
  return { fetch, calls };
}

const refusal = (status: number, body: unknown) => () => Response.json(body, { status });

async function failure(promise: Promise<unknown>): Promise<ClientError> {
  try {
    await promise;
  } catch (error) {
    if (isClientError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to be refused');
}

describe('the API client', () => {
  it('has one function for each operation, and a case here for each function', () => {
    const functions = Object.keys(createApi()).sort();
    expect([...new Set(OPERATIONS.map((operation) => operation.name))].sort()).toEqual(functions);
  });

  it('sends each operation to its path, with its method and its body', async () => {
    for (const operation of OPERATIONS) {
      const { fetch, calls } = recorder();
      await operation.call(createApi({ fetch }));
      expect(calls, operation.name).toHaveLength(1);
      const [seen] = calls;
      if (seen === undefined) throw new Error('unreachable');
      expect({ method: seen.method, url: seen.url }, operation.name).toEqual({ method: operation.method, url: operation.url });
      expect(seen.cache, operation.name).toBe('no-store');
      expect(seen.headers.get('accept'), operation.name).toBe('application/json');

      if (operation.method === 'GET') {
        expect(seen.body, operation.name).toBeUndefined();
        expect(seen.headers.has('content-type'), operation.name).toBe(false);
      } else {
        // The server reads the body of every state-changing request, and only as JSON.
        expect(seen.headers.get('content-type'), operation.name).toBe('application/json');
        expect(JSON.parse(seen.body ?? 'null'), operation.name).toEqual(operation.body);
      }
      // The session cookie goes to the page's own origin; the scheduler's call carries a bearer token and no cookie.
      expect(seen.credentials, operation.name).toBe(operation.name === 'tick' ? 'omit' : 'same-origin');
      expect(seen.headers.get('authorization'), operation.name).toBe(operation.name === 'tick' ? `Bearer ${TICK_SECRET}` : null);
    }
  });

  it('writes amounts in base units as decimal strings, however large', async () => {
    const { fetch, calls } = recorder();
    await createApi({ fetch }).solanaApproval(ORG, 18_446_744_073_709_551_615n);
    expect(calls[0]?.body).toBe('{"amount":"18446744073709551615"}');
  });

  it('leaves out of the query what was not given, and escapes what goes in a path', async () => {
    const { fetch, calls } = recorder();
    const api = createApi({ fetch, baseUrl: 'https://app.holdfast.test' });
    await api.hyperliquidApproval(ORG);
    await api.statement(ORG);
    await api.demoJournal(ORG, { limit: 5 });
    await api.getOrg('a/b?c');
    expect(calls.map((seen) => seen.url)).toEqual([
      `https://app.holdfast.test${org('/hyperliquid/approval')}`,
      `https://app.holdfast.test${org('/books/statement')}`,
      `https://app.holdfast.test/api/demo/${ORG}/journal?limit=5`,
      'https://app.holdfast.test/api/orgs/a%2Fb%3Fc',
    ]);
  });

  it('answers with the parsed JSON, and with the text of an answer that is a file', async () => {
    const json = createApi({ fetch: recorder(() => Response.json({ address: '0xabc', expiresAt: 5, orgs: [] })).fetch });
    expect(await json.me()).toEqual({ address: '0xabc', expiresAt: 5, orgs: [] });

    const csv = 'ts,kind,amount\n1,receipt,100\n';
    const file = createApi({ fetch: recorder(() => new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="holdfast-ledger.csv"' } })).fetch });
    expect(await file.statementCsv(ORG)).toBe(csv);
    expect(await file.exportLedgerCsv(ORG)).toBe(csv);
    expect(await file.auditCsv(TOKEN)).toBe(csv);
    // The published statement is kept as the text the server wrote: it is what gets saved and verified.
    const published = '{"statement":{"asOf":1},\n "sha256":"00"}';
    expect(await createApi({ fetch: recorder(() => new Response(published, { headers: { 'content-type': 'application/json; charset=utf-8' } })).fetch }).exportStatement(ORG)).toBe(published);
  });

  it('gives the links from which the files can be saved', () => {
    expect(downloads.statementCsv(ORG, { from: 5 })).toBe(org('/books/statement?from=5&format=csv'));
    expect(downloads.statementCsv(ORG)).toBe(org('/books/statement?format=csv'));
    expect(downloads.publishedStatement(ORG)).toBe(org('/books/export'));
    expect(downloads.ledgerCsv(ORG)).toBe(org('/books/export?format=csv'));
    expect(downloads.auditCsv(TOKEN)).toBe(`/api/audit/${TOKEN}?format=csv`);
    const routes = appRoutes();
    for (const link of [downloads.statementCsv(ORG), downloads.publishedStatement(ORG), downloads.ledgerCsv(ORG), downloads.auditCsv(TOKEN)]) {
      expect(matchRoute(routes, 'GET', new URL(link, 'https://app.holdfast.test').pathname), link).not.toBeNull();
    }
  });
});

describe('errors of the API client', () => {
  it('turns a refusal of any operation into one error with the server’s code and message', async () => {
    for (const operation of OPERATIONS) {
      const unauthenticated = await failure(operation.call(createApi({ fetch: recorder(refusal(401, { error: 'unauthenticated', message: 'sign in first' })).fetch })));
      expect(unauthenticated, operation.name).toBeInstanceOf(ClientError);
      expect({ status: unauthenticated.status, code: unauthenticated.code, message: unauthenticated.message, details: unauthenticated.details }, operation.name).toEqual({ status: 401, code: 'unauthenticated', message: 'sign in first', details: {} });
      expect([isUnauthenticated(unauthenticated), isNotFound(unauthenticated)], operation.name).toEqual([true, false]);

      const missing = await failure(operation.call(createApi({ fetch: recorder(refusal(404, { error: 'not_found', message: 'not found' })).fetch })));
      expect({ status: missing.status, code: missing.code, message: missing.message }, operation.name).toEqual({ status: 404, code: 'not_found', message: 'not found' });
      expect([isUnauthenticated(missing), isNotFound(missing)], operation.name).toEqual([false, true]);
    }
  });

  it('keeps what else the server said: the problems of an input, the source that is unavailable, the transaction of a refusal', async () => {
    const invalid = await failure(createApi({ fetch: recorder(refusal(400, { error: 'invalid_input', message: 'the body is not valid', problems: ['body.amount: Invalid input'] })).fetch }).solanaApproval(ORG, 1n));
    expect({ status: invalid.status, code: invalid.code, details: invalid.details }).toEqual({ status: 400, code: 'invalid_input', details: { problems: ['body.amount: Invalid input'] } });

    const down = await failure(createApi({ fetch: recorder(refusal(503, { error: 'unavailable', message: 'Hyperliquid is unavailable: fetch failed', source: 'Hyperliquid' })).fetch }).hyperliquidState(ORG));
    expect({ status: down.status, code: down.code, message: down.message, details: down.details }).toEqual({ status: 503, code: 'unavailable', message: 'Hyperliquid is unavailable: fetch failed', details: { source: 'Hyperliquid' } });

    const refused = await failure(createApi({ fetch: recorder(refusal(409, { error: 'refused', message: 'the authorization was not accepted', tx: '0x01', txUrl: 'https://explore.tempo.xyz/tx/0x01' })).fetch }).submitTempoAuthorization(ORG, { terms: TERMS, signedWire: '0xab' }));
    expect({ status: refused.status, code: refused.code, details: refused.details }).toEqual({ status: 409, code: 'refused', details: { tx: '0x01', txUrl: 'https://explore.tempo.xyz/tx/0x01' } });

    const failedSignIn = await failure(createApi({ fetch: recorder(refusal(401, { error: 'sign_in_failed', message: 'sign-in failed: the nonce is unknown, has expired or was used before' })).fetch }).verify({ message: 'm', signature: SIGNATURE }));
    expect({ status: failedSignIn.status, code: failedSignIn.code }).toEqual({ status: 401, code: 'sign_in_failed' });

    const foreign = await failure(createApi({ fetch: recorder(refusal(403, { error: 'bad_origin', message: 'this request did not come from the application itself' })).fetch }).logout());
    expect({ status: foreign.status, code: foreign.code }).toEqual({ status: 403, code: 'bad_origin' });
  });

  it('says so when the answer is not the API’s, in either direction', async () => {
    const page = () => new Response('<!DOCTYPE html><title>502 Bad Gateway</title>', { status: 502, headers: { 'content-type': 'text/html' } });
    const gateway = await failure(createApi({ fetch: recorder(page).fetch }).me());
    expect({ status: gateway.status, code: gateway.code, message: gateway.message }).toEqual({ status: 502, code: 'bad_response', message: 'the server answered HTTP 502 without saying why' });

    const shapeless = await failure(createApi({ fetch: recorder(refusal(500, ['not', 'an', 'error'])).fetch }).me());
    expect({ status: shapeless.status, code: shapeless.code }).toEqual({ status: 500, code: 'bad_response' });

    const html = await failure(createApi({ fetch: recorder(() => new Response('<html></html>', { headers: { 'content-type': 'text/html' } })).fetch }).me());
    expect({ status: html.status, code: html.code }).toEqual({ status: 200, code: 'bad_response' });

    const broken = await failure(createApi({ fetch: recorder(() => new Response('{"address":', { headers: { 'content-type': 'application/json' } })).fetch }).me());
    expect({ status: broken.status, code: broken.code }).toEqual({ status: 200, code: 'bad_response' });
  });

  it('reports a request that got no answer as that, and one that was given up as given up', async () => {
    const offline = await failure(
      createApi({
        fetch: async () => {
          throw new TypeError('Failed to fetch');
        },
      }).me(),
    );
    expect({ status: offline.status, code: offline.code, message: offline.message }).toEqual({ status: null, code: 'network', message: 'the server could not be reached' });
    expect([isUnauthenticated(offline), isNotFound(offline)]).toEqual([false, false]);

    const controller = new AbortController();
    const abortable: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      });
    const pending = failure(createApi({ fetch: abortable }).getOrg(ORG, { signal: controller.signal }));
    controller.abort();
    expect((await pending).code).toBe('aborted');
  });

  it('makes each request once, whatever comes of it', async () => {
    for (const operation of OPERATIONS) {
      const lost = recorder(() => {
        throw new TypeError('Failed to fetch');
      });
      await failure(operation.call(createApi({ fetch: lost.fetch })));
      expect(lost.calls, `${operation.name}: no answer`).toHaveLength(1);

      for (const status of [500, 502, 503, 429]) {
        const failing = recorder(refusal(status, { error: 'unavailable', message: 'try later' }));
        await failure(operation.call(createApi({ fetch: failing.fetch })));
        expect(failing.calls, `${operation.name}: HTTP ${status}`).toHaveLength(1);
      }
    }
  });
});

describe('the API client against the routes of the application', () => {
  /**
   * Enough of the dependencies for a request to be let in and its input
   * read: a session, and an organisation its address owns. Whatever an
   * endpoint goes on to do fails for want of the rest, after the client's
   * part is settled.
   */
  const record: OrgRecord = {
    id: ORG,
    name: 'Acme Labs',
    createdAt: NOW,
    hlUser: OWNER.address.toLowerCase(),
    birthday: 3_512_000,
    scannedTo: null,
    policy: DEFAULT_POLICY,
    lockEnabled: false,
    nextSeq: 1,
    lastDigest: `0x${'00'.repeat(32)}`,
    monthlyBurnUsd: null,
    publicDemo: true,
    tempoAccount: null,
    solanaOwner: null,
  };
  const reported: string[] = [];
  const deps = {
    now: () => NOW,
    redact: (text: string) => text,
    knownSecrets: () => [],
    report: (message: string) => void reported.push(message),
    network: 'mainnet',
    publicHost: null,
    secrets: { session: SESSION_SECRET, tick: TICK_SECRET },
    store: { findOrg: async (id: string) => (id === ORG ? record : null) },
  } as unknown as Deps;

  /** Refusals that mean the request itself was wrong: no such route, not let in, or input the endpoint's schema turned down. */
  function misdirected(error: ClientError): boolean {
    if (error.status === 404 || error.status === 403 || error.status === 415 || error.status === 413) return true;
    if (error.status === 401 && error.code === 'unauthenticated') return true;
    return error.status === 400 && /^the (query|body|request body) is not valid/.test(error.message);
  }

  it('reaches a route with every function, and has a function for every method of every route', async () => {
    const served = app({ deps } as World);
    const { token } = await issueSession(SESSION_SECRET, OWNER.address, NOW);
    const api = createApi({ fetch: served.fetch });

    for (const operation of OPERATIONS) {
      // Signed in afresh each time: logging out is one of the operations, and it does drop the cookie.
      served.cookies.set(SESSION_COOKIE, token);
      const before = served.calls.length;
      const outcome = await operation.call(api).then(
        () => null,
        (error: unknown) => error,
      );
      const call = served.calls[before];
      expect(call?.pattern, `${operation.name}: ${operation.method} ${operation.url} is no route of the application`).not.toBeNull();
      if (outcome !== null) {
        if (!isClientError(outcome)) throw outcome;
        expect(misdirected(outcome), `${operation.name}: refused with ${outcome.status} ${outcome.code}: ${outcome.message} ${JSON.stringify(outcome.details)}`).toBe(false);
      }
    }

    // Every method of every route file was reached by some function above.
    const reached = new Set(served.calls.map((call) => `${call.method} ${call.pattern}`));
    const all = served.routes.map((route) => `${route.method} ${route.pattern}`);
    expect(all.length).toBeGreaterThan(0);
    expect(all.filter((route) => !reached.has(route)), 'routes with no function in src/client/api.ts').toEqual([]);
  });

  it('is turned away by the real endpoints when it should be', async () => {
    const served = app({ deps } as World);
    const api = createApi({ fetch: served.fetch });
    // Nobody is signed in.
    expect(await failure(api.getOrg(ORG))).toMatchObject({ status: 401, code: 'unauthenticated', message: 'sign in first' });
    expect(isUnauthenticated(await failure(api.me()))).toBe(true);
    expect(await failure(api.tick('not-the-secret'))).toMatchObject({ status: 401, code: 'unauthenticated' });

    served.cookies.set(SESSION_COOKIE, (await issueSession(SESSION_SECRET, OWNER.address, NOW)).token);
    // An organisation that does not exist, a run id that could not be one, and a path that is no route.
    expect(isNotFound(await failure(api.getOrg('no-such-organisation')))).toBe(true);
    expect(await failure(api.getPayout(ORG, 'run-1'))).toMatchObject({ status: 404, code: 'not_found', message: 'not found' });
    expect(await failure(createApi({ fetch: served.fetch, baseUrl: '/nowhere' }).me())).toMatchObject({ status: 404, code: 'bad_response' });
    // Input the endpoint's own schema refuses, with where it is wrong.
    const invalid = await failure(api.setLock(ORG, 'yes' as unknown as boolean));
    expect(invalid).toMatchObject({ status: 400, code: 'invalid_input', message: 'the body is not valid' });
    expect(invalid.details.problems).toEqual([expect.stringContaining('body.enabled')]);
    expect(await failure(api.lockPreview(ORG, { swapCostBps: 5_000 }))).toMatchObject({ status: 400, code: 'invalid_input', message: 'the query is not valid' });
  });
});
