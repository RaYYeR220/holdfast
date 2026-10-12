import type { PgliteConnection } from '@holdfast/db';
import { ScannerUnavailableError } from '@holdfast/zcash';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getZcashTip } from '../src/server/api/zcash';
import { SESSION_COOKIE } from '../src/server/auth/session';
import { BIRTHDAY, RPC_URL, STARTUP_TIMEOUT_MS, UFVK, type World, call, migratedPglite, newAccount, sessionOf, world } from './support/world';

let connection: PgliteConnection;
let w: World;

beforeAll(async () => {
  connection = await migratedPglite();
}, STARTUP_TIMEOUT_MS);

afterAll(() => connection.close());

beforeEach(() => {
  w = world(connection);
});

/** Have every read of the chain's height fail with `error`, and count the reads that were made. */
function failTip(error: unknown): { reads: number } {
  const seen = { reads: 0 };
  w.chain.tip = async () => {
    seen.reads += 1;
    throw error;
  };
  return seen;
}

describe('the height of the Zcash chain', () => {
  it('is read now, for whoever is signed in, whether or not they own an organisation', async () => {
    // Somebody who signed in and has registered nothing yet: the height is what a birthday is chosen from.
    const cookie = await sessionOf(w, newAccount().address);
    const first = await call(w, getZcashTip, 'GET', { cookie });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ height: BIRTHDAY + 100, readAt: w.clock.ms });
    expect(first.headers.get('cache-control')).toBe('no-store');

    // Nothing is remembered between two requests: each is a read of its own.
    w.chain.height += 7;
    w.clock.advance(75_000);
    expect((await call(w, getZcashTip, 'GET', { cookie })).body).toEqual({ height: BIRTHDAY + 107, readAt: w.clock.ms });
  });

  it('is not given to anyone who is not signed in, and the chain is not asked for them', async () => {
    let reads = 0;
    const tip = w.chain.tip.bind(w.chain);
    w.chain.tip = async () => {
      reads += 1;
      return tip();
    };
    for (const cookie of [undefined, `${SESSION_COOKIE}=not-a-token`]) {
      const answer = await call(w, getZcashTip, 'GET', cookie === undefined ? {} : { cookie });
      expect(answer.status).toBe(401);
      expect(answer.body).toEqual({ error: 'unauthenticated', message: 'sign in first' });
    }
    expect(reads).toBe(0);
    // It takes no input: a query is refused, not ignored.
    expect((await call(w, getZcashTip, 'GET', { cookie: await sessionOf(w), query: { network: 'testnet' } })).status).toBe(400);
    expect(reads).toBe(0);
  });

  it('is unavailable when no endpoint answers, and no earlier height stands in for it', async () => {
    const cookie = await sessionOf(w);
    expect((await call(w, getZcashTip, 'GET', { cookie })).body.height).toBe(BIRTHDAY + 100);

    const seen = failTip(new ScannerUnavailableError([{ endpoint: 'https://zec.example.test:443', error: 'deadline exceeded' }, { endpoint: 'https://eu.zec.example.test:443', error: 'connection refused' }]));
    const down = await call(w, getZcashTip, 'GET', { cookie });
    expect(down.status).toBe(503);
    expect(down.body).toEqual({
      error: 'unavailable',
      message: 'Zcash is unavailable: no Zcash endpoint answered: https://zec.example.test:443 (deadline exceeded); https://eu.zec.example.test:443 (connection refused)',
      source: 'Zcash',
    });
    expect(seen.reads).toBe(1);
    expect(down.text).not.toContain(String(BIRTHDAY + 100));
  });

  it('says nothing secret about why it is unavailable', async () => {
    const cookie = await sessionOf(w);
    failTip(new Error(`request to ${RPC_URL} failed while reading for ${UFVK}`));
    const down = await call(w, getZcashTip, 'GET', { cookie });
    expect(down.body).toEqual({ error: 'unavailable', message: 'Zcash is unavailable: request to [redacted] failed while reading for [viewing key]', source: 'Zcash' });
    expect(down.text).not.toContain(RPC_URL);
    expect(down.text).not.toContain(UFVK);
  });

  it('is unavailable when what was read is not a block height', async () => {
    const cookie = await sessionOf(w);
    for (const height of [0, -1, 3_512_100.5, Number.NaN, Number.POSITIVE_INFINITY, '3512100' as unknown as number, undefined as unknown as number]) {
      w.chain.tip = async () => height;
      const answer = await call(w, getZcashTip, 'GET', { cookie });
      expect(answer.status, String(height)).toBe(503);
      expect(answer.body, String(height)).toEqual({ error: 'unavailable', message: 'Zcash is unavailable: the endpoints answered with something that is not a block height', source: 'Zcash' });
    }
  });
});
