import type { PgliteConnection } from '@holdfast/db';
import { checkUfvk } from '@holdfast/zcash';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { safetyFacts } from '../../src/server/pages/safety';
import { treasuryAddress } from '../../src/server/pages/settings';
import { ATTESTOR_CONTRACT, SOLANA_OWNER } from '../support/fakes';
import { ROOT, STARTUP_TIMEOUT_MS, UFVK, type World, migratedPglite, newAccount, organisation, world } from '../support/world';

let connection: PgliteConnection;
let w: World;

beforeAll(async () => {
  connection = await migratedPglite();
}, STARTUP_TIMEOUT_MS);

afterAll(() => connection.close());

beforeEach(() => {
  w = world(connection);
});

const addressOf = (ufvk: string): string => {
  const checked = checkUfvk(ufvk, 'mainnet');
  if (!checked.ok) throw new Error('the test viewing key did not pass its check');
  return checked.address;
};

describe('what the Safety page reads beside the scopes', () => {
  it('names the accounts the keys act on, the tokens they are limited in and the contract the attester records on', async () => {
    const owner = newAccount();
    const org = await organisation(w, owner.address);
    const facts = await safetyFacts(w.deps, org);

    expect(facts).toEqual({
      network: 'mainnet',
      treasury: { status: 'ok', source: 'viewing key', readAt: w.clock.ms, value: { address: addressOf(UFVK) } },
      hyperliquidAccount: owner.address.toLowerCase(),
      tempo: { network: 'moderato', account: ROOT, token: { address: w.deps.tempo.token, symbol: 'AlphaUSD', decimals: 6 } },
      solana: { cluster: 'devnet', owner: SOLANA_OWNER, token: { address: w.solana.mint, symbol: 'USDC', decimals: 6 } },
      attestor: { contract: ATTESTOR_CONTRACT, chainId: w.attestor.chainId, everyMinutes: Math.round(w.attestor.everyMs / 60_000) },
    });
  });

  it('says so where an account is not named yet and where the deployment records no attestations', async () => {
    const org = await organisation(w, newAccount().address, { tempoAccount: null, solanaOwner: null });
    w.deps.attestor = null;
    const facts = await safetyFacts(w.deps, org);
    expect(facts.tempo.account).toBeNull();
    expect(facts.solana.owner).toBeNull();
    expect(facts.attestor).toBeNull();
  });

  it('gives the treasury’s address and never any part of the key it is derived from', async () => {
    const org = await organisation(w, newAccount().address);
    const facts = await safetyFacts(w.deps, org);
    const text = JSON.stringify(facts);
    expect(text).not.toContain(UFVK);
    expect(text).not.toContain(UFVK.slice(0, 24));
    expect(text).not.toMatch(/uview1/);
  });
});

describe('the treasury address', () => {
  it('is the unified address the stored viewing key receives on', async () => {
    const org = await organisation(w, newAccount().address);
    expect(await treasuryAddress(w.deps, org)).toEqual({ status: 'ok', source: 'viewing key', readAt: w.clock.ms, value: { address: addressOf(UFVK) } });
  });

  it('is unavailable, with a reason that names no key, when the stored key no longer passes its check', async () => {
    const org = await organisation(w, newAccount().address);
    const deps = { ...w.deps, zcash: { ...w.deps.zcash, check: () => ({ ok: false as const, error: `not a viewing key: ${UFVK}` }) } };
    const read = await treasuryAddress(deps, org);
    expect(read).toEqual({ status: 'unavailable', source: 'viewing key', readAt: w.clock.ms, reason: 'the stored viewing key no longer passes its check, so the treasury address cannot be derived' });
    expect(JSON.stringify(read)).not.toContain(UFVK);
  });

  it('is unavailable for an organisation the database does not hold', async () => {
    const read = await treasuryAddress(w.deps, { id: 'no-such-organisation' });
    expect(read).toMatchObject({ status: 'unavailable', source: 'viewing key' });
  });
});
