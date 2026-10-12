import { DEFAULT_POLICY } from '@holdfast/core';
import { describe, expect, it } from 'vitest';
import { type ChecklistInput, advisoryShown, checklistCount, checklistOf } from '../../src/app/_sections/entry/checklist';
import { failureShown } from '../../src/app/_sections/entry/failure';
import { SECRET_REFUSAL, isBirthdayRefusal, isKeyRefusal, keyShape, readRegistration, suggestedBirthday } from '../../src/app/_sections/entry/register';

const KEY = `uview1${'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(4)}`;
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('what is pasted where a viewing key belongs', () => {
  it('takes one unbroken word as possibly a viewing key, whatever network it claims', () => {
    expect(keyShape(KEY)).toBe('plausible');
    expect(keyShape(`  ${KEY}\n`)).toBe('plausible');
    expect(keyShape('uviewtest1qqqq')).toBe('plausible');
  });

  it('knows a seed phrase and a spending key by their shape', () => {
    expect(keyShape(PHRASE)).toBe('secret');
    expect(keyShape('secret-extended-key-main1qqqq')).toBe('secret');
    expect(keyShape('USKPRIVATE1qqqq')).toBe('secret');
    expect(keyShape('zxviewsecret1qqqq')).toBe('secret');
    expect(keyShape('zxviewssecret1qqqq')).toBe('secret');
    expect(keyShape('uview1 qqqq')).toBe('secret');
  });

  it('knows nothing from something', () => {
    expect(keyShape('   ')).toBe('empty');
  });
});

describe('the registration form', () => {
  const text = { name: ' Acme Labs ', birthday: '3512987', monthlyBurn: '' };

  it('reads into what the server takes', () => {
    expect(readRegistration(text, ` ${KEY} `)).toEqual({ ok: true, body: { name: 'Acme Labs', ufvk: KEY, birthday: 3_512_987, monthlyBurnUsd: null } });
    expect(readRegistration({ ...text, birthday: '3,512,987', monthlyBurn: '$42,500.50' }, KEY)).toMatchObject({ ok: true, body: { birthday: 3_512_987, monthlyBurnUsd: 42_500.5 } });
  });

  it('refuses a secret and says that the page must drop it', () => {
    const read = readRegistration(text, PHRASE);
    expect(read).toEqual({ ok: false, secret: true, errors: { ufvk: SECRET_REFUSAL } });
    // The refusal never repeats what was pasted.
    expect(JSON.stringify(read)).not.toContain('abandon');
  });

  it('refuses each field that cannot be read, at that field', () => {
    const read = readRegistration({ name: '  ', birthday: 'block nine', monthlyBurn: 'lots' }, '');
    expect(read).toMatchObject({ ok: false, secret: false, errors: { name: expect.any(String), ufvk: 'Paste the unified full viewing key of the treasury.', birthday: expect.stringContaining('whole number'), monthlyBurn: expect.any(String) } });
    expect(readRegistration({ ...text, birthday: '' }, KEY)).toMatchObject({ ok: false, errors: { birthday: expect.stringContaining('is needed') } });
    expect(readRegistration({ ...text, birthday: '0' }, KEY)).toMatchObject({ ok: false, errors: { birthday: 'That is not a block height.' } });
    expect(readRegistration({ ...text, name: 'x'.repeat(121) }, KEY)).toMatchObject({ ok: false, errors: { name: 'At most 120 characters.' } });
  });

  it('suggests a birthday a margin under the chain’s height, and never under one', () => {
    expect(suggestedBirthday(3_515_516)).toBe(3_515_416);
    expect(suggestedBirthday(40)).toBe(1);
  });

  it('tells the server’s refusal of the key and of the birthday from its other refusals', () => {
    expect(isKeyRefusal({ code: 'invalid_input', message: 'the viewing key was not accepted: this is a testnet viewing key' })).toBe(true);
    expect(isKeyRefusal({ code: 'unavailable', message: 'the viewing key was not accepted' })).toBe(false);
    expect(isBirthdayRefusal({ code: 'invalid_input', message: 'the birthday height is before block 419200, where shielded funds first became possible' })).toBe(true);
    expect(isBirthdayRefusal({ code: 'invalid_input', message: 'name: too long' })).toBe(false);
  });
});

describe('the setup checklist', () => {
  const read = <T>(value: T) => ({ status: 'ok' as const, readAt: 1_000, value });
  const unread = (reason: string, source = 'tempo') => ({ status: 'unavailable' as const, source, readAt: 2_000, reason });
  const base: ChecklistInput = {
    base: '/app',
    org: { birthday: 3_512_987, scannedTo: 3_515_476, tempoAccount: '0x43E69cd36fbf1Bbe73E03Dd5d06c8ff9f81Be4c8', solanaOwner: 'B1zTmCPofZo7TZET5k7jL43FzVG5TFcbQPijYi7mFV97' },
    agent: read({ approved: true }),
    tempo: read({ authorized: true, live: true, revoked: false, expiresAt: 9_000 }),
    solana: read({ remaining: '750000' }),
    attester: read({ registered: true }),
    now: 5_000,
  };
  const states = (input: ChecklistInput) => Object.fromEntries(checklistOf(input).map((item) => [item.key, item.state]));

  it('lists the five steps in order, each with where it is done', () => {
    const items = checklistOf(base);
    expect(items.map((item) => item.key)).toEqual(['viewing', 'agent', 'tempo', 'solana', 'attester']);
    expect(items.map((item) => item.href)).toEqual(['/app/treasury', '/app/lock#agent', '/app/payouts', '/app/payouts', '/app/safety']);
    expect(states(base)).toEqual({ viewing: 'done', agent: 'done', tempo: 'done', solana: 'done', attester: 'done' });
    expect(checklistCount(items)).toEqual({ done: 5, total: 5, unknown: 0 });
  });

  it('counts the viewing key as imported from the start and says how far the scan has got', () => {
    expect(checklistOf(base)[0]?.detail).toContain('Scanned from block 3,512,987 to block 3,515,476');
    expect(checklistOf({ ...base, org: { ...base.org, scannedTo: null } })[0]).toMatchObject({ state: 'done', detail: expect.stringContaining('no tick has scanned yet'), readAt: null });
  });

  it('shows each step the chain does not show done as still to do', () => {
    const fresh: ChecklistInput = { ...base, agent: read({ approved: false }), tempo: read({ authorized: false, live: false, revoked: false, expiresAt: null }), solana: read({ remaining: 0n }), attester: read({ registered: false }) };
    expect(states(fresh)).toEqual({ viewing: 'done', agent: 'open', tempo: 'open', solana: 'open', attester: 'open' });
    expect(checklistCount(checklistOf(fresh))).toEqual({ done: 1, total: 5, unknown: 0 });
  });

  it('says why a Tempo key that is known cannot pay: revoked, expired, or broader than the rail takes', () => {
    const detail = (tempo: ChecklistInput['tempo']) => checklistOf({ ...base, tempo }).find((item) => item.key === 'tempo')?.detail ?? '';
    expect(detail(read({ authorized: false, live: false, revoked: true, expiresAt: 9_000 }))).toContain('revoked');
    expect(detail(read({ authorized: false, live: false, revoked: false, expiresAt: 4_000 }))).toContain('expired');
    expect(detail(read({ authorized: false, live: true, revoked: false, expiresAt: 9_000 }))).toContain('not bounded the way the rail requires');
    expect(detail(read({ authorized: false, live: false, revoked: false, expiresAt: null }))).toContain('does not know the key');
  });

  it('asks for the account first where a rail has none, whatever the chain could not say', () => {
    const none: ChecklistInput = { ...base, org: { ...base.org, tempoAccount: null, solanaOwner: null }, tempo: unread('the organisation has no Tempo account yet; set one in its profile first'), solana: unread('the organisation has no Solana wallet yet; set one in its profile first', 'solana') };
    const items = checklistOf(none);
    expect(items[2]).toMatchObject({ state: 'open', detail: expect.stringContaining('no Tempo account yet'), readAt: null, source: null });
    expect(items[3]).toMatchObject({ state: 'open', detail: expect.stringContaining('no Solana wallet yet'), readAt: null, source: null });
  });

  it('keeps a state that could not be read apart from one that is not done', () => {
    const down: ChecklistInput = { ...base, agent: unread('Hyperliquid answered HTTP 502 to extraAgents', 'hyperliquid'), attester: unread('this deployment records no attestations', 'hyperevm') };
    const items = checklistOf(down);
    expect(items[1]).toMatchObject({ state: 'unknown', detail: 'This could not be read: Hyperliquid answered HTTP 502 to extraAgents.', source: 'hyperliquid', readAt: 2_000 });
    expect(items[4]).toMatchObject({ state: 'unknown', source: 'hyperevm' });
    expect(checklistCount(items)).toEqual({ done: 3, total: 5, unknown: 2 });
  });
});

describe('an advisory as the page states it', () => {
  it('asks for margin and says that only the treasurer can add it', () => {
    const shown = advisoryShown({ kind: 'TOP_UP_MARGIN', usd: 1_250.5, severity: 'warn' }, DEFAULT_POLICY, '/app');
    expect(shown).toMatchObject({ state: 'limit', word: 'Top-up', title: 'Add $1,250.50 of margin', href: '/app/treasury#funding' });
    expect(shown.text).toContain('target of 80.0%');
    expect(shown.text).toContain('The service cannot add margin');
  });

  it('marks a top-up under the buy-back floor as urgent', () => {
    const shown = advisoryShown({ kind: 'TOP_UP_MARGIN', usd: 10, severity: 'critical' }, DEFAULT_POLICY, '/app');
    expect(shown).toMatchObject({ state: 'refused', word: 'Urgent' });
    expect(shown.text).toContain('under the buy-back floor of 20.0%');
  });

  it('offers excess margin back and says that taking it is the treasurer’s to do', () => {
    const shown = advisoryShown({ kind: 'SWEEP_EXCESS_MARGIN', usd: 80 }, DEFAULT_POLICY, '/app');
    expect(shown.title).toBe('$80.00 of margin can be taken back');
    expect(shown.text).toContain('over 160.0%');
    expect(shown.text).toContain('the service’s key cannot withdraw');
  });

  it('counts the lots the margin does not carry', () => {
    expect(advisoryShown({ kind: 'RELOCK', lots: 1 }, DEFAULT_POLICY, '/app').title).toBe('1 lot is not hedged');
    expect(advisoryShown({ kind: 'RELOCK', lots: 12 }, DEFAULT_POLICY, '/app').title).toBe('12 lots are not hedged');
  });
});

describe('a failed step as the page states it', () => {
  const doing = { title: 'The approval', nothing: 'Nothing was approved.' };

  it('tells a refusal in the wallet from a refusal by the server and from a source that failed', () => {
    expect(failureShown({ code: 'wallet_rejected', message: 'signing was declined in the wallet', status: null }, doing)).toMatchObject({ kind: 'refusal', word: 'Declined', title: 'The approval was declined in the wallet', reason: 'Signing was declined in the wallet.' });
    expect(failureShown({ code: 'refused', message: 'Hyperliquid refused the approval: Must deposit before performing actions. User: 0xec91', status: 409 }, doing)).toMatchObject({ kind: 'refusal', title: 'The approval was refused', reason: 'Hyperliquid refused the approval: Must deposit before performing actions. User: 0xec91.' });
    expect(failureShown({ code: 'unavailable', message: '1Click is unavailable: 1Click is unreachable', status: 503 }, doing)).toMatchObject({ kind: 'warning', word: 'Unavailable' });
  });

  it('says that the wallet was not opened when the page is served from another host', () => {
    const shown = failureShown({ code: 'wrong_site', message: 'this page is served from evil.example, and the service signs in for app.holdfast.test', status: null }, { title: 'Signing in', nothing: 'You are not signed in.' });
    expect(shown).toMatchObject({ kind: 'refusal', title: 'This page is served from another host' });
    expect(shown.next).toContain('The wallet was not opened');
  });

  it('gives the server’s reason for a sign-in it refused, and says that asking again is safe', () => {
    const shown = failureShown({ code: 'sign_in_failed', message: 'sign-in failed: the nonce is unknown, has expired or was used before', status: 401 }, { title: 'Signing in', nothing: 'You are not signed in.' });
    expect(shown).toMatchObject({ kind: 'refusal', title: 'The server refused the sign-in', reason: 'Sign-in failed: the nonce is unknown, has expired or was used before.' });
    expect(shown.next).toContain('fresh challenge');
  });

  it('does not claim to know what happened when the server could not be reached', () => {
    expect(failureShown({ code: 'network', message: 'the server could not be reached', status: null }, doing).next).toContain('Whether the request arrived is not known');
  });

  it('names the status of an answer it has no words for', () => {
    expect(failureShown({ code: 'teapot', message: 'short and stout', status: 418 }, doing)).toMatchObject({ kind: 'warning', title: 'The approval failed', next: 'The server answered HTTP 418. Nothing was approved.' });
  });
});
