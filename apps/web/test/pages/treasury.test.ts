import type { OrgRecord, PgliteConnection } from '@holdfast/db';
import { ASSETS } from '@holdfast/intents';
import { checkUfvk } from '@holdfast/zcash';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { treasuryPage } from '../../src/server/pages/treasury';
import { PX, depositAddress } from '../support/fakes';
import { BIRTHDAY, STARTUP_TIMEOUT_MS, UFVK, type World, migratedPglite, newAccount, note, organisation, tickOnce, world } from '../support/world';

let connection: PgliteConnection;
let w: World;

beforeAll(async () => {
  connection = await migratedPglite();
}, STARTUP_TIMEOUT_MS);

afterAll(() => connection.close());

beforeEach(() => {
  w = world(connection);
});

const text = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));

async function fresh(org: OrgRecord): Promise<OrgRecord> {
  const found = await w.store.findOrg(org.id);
  if (found === null) throw new Error('the organisation is gone');
  return found;
}

/**
 * A treasury that received 0.01975 ZEC with a memo, then paid 0.0093 ZEC to a
 * transparent address for a fee of 0.00015 ZEC and got 0.0103 ZEC back as
 * change: what the demo treasury did on mainnet.
 */
async function spent(): Promise<OrgRecord> {
  const org = await organisation(w, newAccount().address);
  const received = note(BIRTHDAY + 10, 1_975_000n, { memo: 'ZCG grant, milestone 2 of 4' });
  w.chain.notes = [received, note(BIRTHDAY + 20, 1_030_000n, { kind: 'change' })];
  w.chain.spends = [{ height: BIRTHDAY + 20, nullifier: received.nullifier ?? '' }];
  const scan = w.chain.scan.bind(w.chain);
  w.chain.scan = async (range) => ({
    ...(await scan(range)),
    outgoing: [{ id: `tx${BIRTHDAY + 20}:out:0`, txid: `tx${BIRTHDAY + 20}`, height: BIRTHDAY + 20, time: 1_799_000_000_000, zat: 930_000n, memo: '', pool: 'transparent' as const }].filter((out) => out.height >= range.fromHeight && out.height <= range.toHeight),
    fees: [{ txid: `tx${BIRTHDAY + 20}`, zat: 15_000n }],
  });
  await tickOnce(w, org.id);
  return fresh(org);
}

describe('the treasury as the page reads it', () => {
  it('shows the address the viewing key receives on, and never the key', async () => {
    const org = await spent();
    const page = await treasuryPage(w.deps, org);
    const derived = checkUfvk(UFVK, 'mainnet');
    if (!derived.ok) throw new Error('the test key does not derive an address');
    expect(page.address).toMatchObject({ status: 'ok', source: 'viewing key', value: derived.address });
    expect(page.network).toBe('mainnet');
    expect(text(page)).not.toContain(UFVK);
    expect(text(page)).not.toContain(UFVK.slice(0, 24));
  });

  it('is all unavailable but the address before any tick, each figure with the reason', async () => {
    const org = await organisation(w, newAccount().address);
    const page = await treasuryPage(w.deps, org);
    expect(page.address.status).toBe('ok');
    expect(page.scan).toBeNull();
    expect(page.scannedTo).toBeNull();
    expect(page.birthday).toBe(org.birthday);
    for (const reading of [page.balance, page.valueUsd, page.activity]) {
      expect(reading).toMatchObject({ status: 'unavailable', source: 'zcash', reason: 'no tick has run for this organisation yet' });
    }
    expect(page.swaps).toMatchObject({ status: 'ok', value: [] });
  });

  it('shows the balance of the latest tick with how far its scan reached', async () => {
    const org = await spent();
    const page = await treasuryPage(w.deps, org);
    expect(page.balance).toMatchObject({ status: 'ok', source: 'zcash', value: { zat: 1_030_000n, zec: '0.0103', seq: 1 } });
    expect(page.scan).toMatchObject({ seq: 1, to: w.chain.height, tip: w.chain.height, caughtUp: true });
    expect(page.scannedTo).toBe(w.chain.height);
  });

  it('values the balance at the reference price and says when that price was quoted', async () => {
    const org = await spent();
    w.clock.advance(20_000);
    const page = await treasuryPage(w.deps, org);
    if (page.valueUsd.status !== 'ok') throw new Error('no value');
    expect(page.valueUsd.value.usd).toBeCloseTo(0.0103 * PX, 6);
    expect(page.valueUsd.value.px).toBe(PX);
    expect(page.valueUsd.value.priceAsOf).toBe(w.clock.ms);
    // As old as the older of its two readings: the balance of the tick.
    expect(page.valueUsd.readAt).toBe(page.balance.readAt);
  });

  it('shows the value as unavailable, with the reason, when the reference price cannot be read', async () => {
    const org = await spent();
    w.reference.down = 'two of three sources did not answer';
    const page = await treasuryPage(w.deps, org);
    expect(page.price).toMatchObject({ status: 'unavailable', source: 'reference', reason: 'two of three sources did not answer' });
    expect(page.valueUsd).toMatchObject({ status: 'unavailable', source: 'reference' });
    expect(page.balance.status).toBe('ok');
  });

  it('lists what came in with its memo, what went out, the fees and the change, and totals them', async () => {
    const org = await spent();
    const page = await treasuryPage(w.deps, org);
    if (page.activity.status !== 'ok') throw new Error('no activity');
    const { received, sent, fees, change, totals, truncated } = page.activity.value;
    expect(received).toEqual([expect.objectContaining({ txid: `tx${BIRTHDAY + 10}`, height: BIRTHDAY + 10, zat: 1_975_000n, zec: '0.01975', memo: 'ZCG grant, milestone 2 of 4', pool: 'ironwood', spent: true })]);
    expect(sent).toEqual([expect.objectContaining({ txid: `tx${BIRTHDAY + 20}`, zat: 930_000n, zec: '0.0093', pool: 'transparent' })]);
    expect(fees).toEqual([{ txid: `tx${BIRTHDAY + 20}`, height: BIRTHDAY + 20, zat: 15_000n, zec: '0.00015' }]);
    expect(change).toEqual({ count: 1, zat: 1_030_000n, zec: '0.0103' });
    expect(totals).toEqual({ receivedZat: 1_975_000n, sentZat: 930_000n, feesZat: 15_000n });
    expect(truncated).toBe(false);
    // The rows are those of the tick that read the balance.
    expect(page.activity.readAt).toBe(page.balance.readAt);
  });

  it('shows no payments once the latest reading is older than the policy allows, and says why', async () => {
    const org = await spent();
    w.clock.advance(org.policy.maxDataAgeMs + 60_000);
    const page = await treasuryPage(w.deps, org);
    expect(page.balance.status).toBe('unavailable');
    expect(page.activity).toMatchObject({ status: 'unavailable', source: 'zcash', reason: expect.stringContaining('the latest treasury reading is') });
  });

  it('lists the swaps on record, newest first, with their transactions', async () => {
    const org = await spent();
    const first = await w.store.recordSwap(org.id, {
      purpose: 'margin',
      originAsset: ASSETS.ZEC,
      destinationAsset: ASSETS.USDC_HYPERCORE,
      amountIn: 930_000n,
      minAmountOut: 1_090_000_000n,
      depositAddress: depositAddress(900),
      recipient: org.hlUser,
      quote: { signature: 'ed25519:kept-as-evidence' },
      state: 'PENDING_DEPOSIT',
    });
    await w.store.updateSwap(org.id, first.id, { state: 'SUCCESS', originTxs: ['2b3865fb'], destinationTxs: ['0xa5294456'], amountOut: 1_102_097_700n });
    w.clock.advance(1_000);
    await w.store.recordSwap(org.id, { purpose: 'margin', originAsset: ASSETS.ZEC, destinationAsset: ASSETS.USDC_HYPERCORE, amountIn: 500_000n, minAmountOut: 1n, depositAddress: depositAddress(901), recipient: org.hlUser, quote: {}, state: 'PENDING_DEPOSIT' });

    const page = await treasuryPage(w.deps, org);
    if (page.swaps.status !== 'ok') throw new Error('no swaps');
    expect(page.swaps.value).toHaveLength(2);
    const settled = page.swaps.value.find((swap) => swap.id === first.id);
    expect(settled).toMatchObject({ purpose: 'margin', amountIn: 930_000n, amountInZec: '0.0093', amountOut: 1_102_097_700n, state: 'SUCCESS', final: true, originTxs: ['2b3865fb'], destinationTxs: ['0xa5294456'], recipient: org.hlUser, depositAddress: depositAddress(900) });
    expect(page.swaps.value.find((swap) => swap.id !== first.id)).toMatchObject({ state: 'PENDING_DEPOSIT', final: false, amountOut: null });
    // The quote kept as evidence is not part of what the page is given.
    expect(text(page)).not.toContain('kept-as-evidence');
  });
});
