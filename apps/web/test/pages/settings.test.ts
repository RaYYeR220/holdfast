import type { PgliteConnection } from '@holdfast/db';
import { checkUfvk } from '@holdfast/zcash';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { burnText, checkProfile, keyKind, profileChanges } from '../../src/app/_sections/settings/model';
import { settingsFacts } from '../../src/server/pages/settings';
import { SOLANA_OWNER } from '../support/fakes';
import { ROOT, STARTUP_TIMEOUT_MS, UFVK, type World, keyAddress, migratedPglite, newAccount, organisation, world } from '../support/world';

let connection: PgliteConnection;
let w: World;

beforeAll(async () => {
  connection = await migratedPglite();
}, STARTUP_TIMEOUT_MS);

afterAll(() => connection.close());

beforeEach(() => {
  w = world(connection);
});

describe('what the Settings page reads', () => {
  it('is the profile, the accounts the organisation is tied to and the keys made for it, with no secret among them', async () => {
    const owner = newAccount();
    const org = await organisation(w, owner.address, { name: 'Acme Labs' });
    const facts = await settingsFacts(w.deps, org);
    const treasury = checkUfvk(UFVK, 'mainnet');

    expect(facts).toMatchObject({
      id: org.id,
      name: 'Acme Labs',
      createdAt: org.createdAt,
      monthlyBurnUsd: 42_500,
      publicDemo: false,
      network: 'mainnet',
      rails: { tempo: 'moderato', solana: 'devnet' },
      owner: owner.address.toLowerCase(),
      treasury: { status: 'ok', value: { address: treasury.ok ? treasury.address : '' } },
      birthday: 3_512_000,
      scannedTo: null,
      tempoAccount: ROOT,
      solanaOwner: SOLANA_OWNER,
    });
    expect(facts.keys.map((key) => key.kind).sort()).toEqual(['hl_agent', 'hl_attester', 'solana_delegate', 'tempo_access']);
    for (const key of facts.keys) {
      expect(key).toEqual({ kind: key.kind, address: await keyAddress(w, org.id, key.kind as 'hl_agent'), status: 'active', createdAt: w.clock.ms, revokedAt: null });
    }

    const text = JSON.stringify(facts);
    expect(text).not.toMatch(/uview1/);
    for (const kind of ['hl_agent', 'tempo_access', 'solana_delegate', 'hl_attester'] as const) {
      const secret = (await w.store.activeKey(org.id, kind))?.secret ?? '';
      expect(secret.length).toBeGreaterThan(8);
      expect(text).not.toContain(secret);
    }
  });

  it('leaves a rail unnamed when its settings cannot be used, and still answers', async () => {
    const org = await organisation(w, newAccount().address, { tempoAccount: null, solanaOwner: null });
    const deps = {
      ...w.deps,
      get tempo(): never {
        throw new Error('TEMPO_TOKEN is not an address');
      },
    };
    const facts = await settingsFacts(deps, org);
    expect(facts.rails).toEqual({ tempo: null, solana: 'devnet' });
    expect(facts).toMatchObject({ tempoAccount: null, solanaOwner: null });
  });
});

describe('the profile form', () => {
  it('takes a name and a burn the server will take', () => {
    expect(checkProfile({ name: '  Acme Labs ', burn: '' })).toEqual({ ok: true, profile: { name: 'Acme Labs', monthlyBurnUsd: null } });
    expect(checkProfile({ name: 'Acme Labs', burn: '42500' })).toEqual({ ok: true, profile: { name: 'Acme Labs', monthlyBurnUsd: 42_500 } });
    expect(checkProfile({ name: 'Acme Labs', burn: ' $42,500.50 ' })).toEqual({ ok: true, profile: { name: 'Acme Labs', monthlyBurnUsd: 42_500.5 } });
    expect(checkProfile({ name: 'Acme Labs', burn: '0' })).toEqual({ ok: true, profile: { name: 'Acme Labs', monthlyBurnUsd: 0 } });
    expect(checkProfile({ name: 'x'.repeat(120), burn: '1000000000000' })).toMatchObject({ ok: true });
  });

  it('refuses what the server would refuse, and anything it would have to guess at', () => {
    const errorsOf = (fields: { name: string; burn: string }) => {
      const checked = checkProfile(fields);
      return checked.ok ? [] : Object.keys(checked.errors);
    };
    expect(errorsOf({ name: '   ', burn: '' })).toEqual(['name']);
    expect(errorsOf({ name: 'x'.repeat(121), burn: '' })).toEqual(['name']);
    for (const burn of ['-5', '1e6', 'abc', '12.345', '1.2.3', '42 500 a month', '1000000000001']) expect(errorsOf({ name: 'Acme', burn })).toEqual(['burn']);
    expect(errorsOf({ name: '', burn: 'lots' })).toEqual(['name', 'burn']);
  });

  it('sends only what differs from what the server holds', () => {
    const held = { name: 'Acme Labs', monthlyBurnUsd: 42_500 };
    expect(profileChanges({ name: 'Acme Labs', monthlyBurnUsd: 42_500 }, held)).toBeNull();
    expect(profileChanges({ name: 'Acme', monthlyBurnUsd: 42_500 }, held)).toEqual({ name: 'Acme' });
    expect(profileChanges({ name: 'Acme Labs', monthlyBurnUsd: null }, held)).toEqual({ monthlyBurnUsd: null });
    expect(profileChanges({ name: 'Acme', monthlyBurnUsd: 50_000 }, held)).toEqual({ name: 'Acme', monthlyBurnUsd: 50_000 });
  });

  it('writes a burn back into the form as it was typed', () => {
    expect(burnText(null)).toBe('');
    expect(burnText(42_500)).toBe('42500');
    expect(burnText(42_500.5)).toBe('42500.50');
    expect(checkProfile({ name: 'Acme', burn: burnText(42_500.5) })).toMatchObject({ ok: true, profile: { monthlyBurnUsd: 42_500.5 } });
  });

  it('names each kind of key, and shows one it does not know under its own name', () => {
    expect(keyKind('hl_agent')).toMatchObject({ name: 'Agent key', chain: 'Hyperliquid' });
    expect(keyKind('hl_attester')).toMatchObject({ name: 'Attester key', chain: 'HyperEVM' });
    expect(keyKind('some_new_key')).toEqual({ name: 'some new key', chain: '', does: '' });
  });
});
