import { attestationFor, commitTreasury, hedgeAttestorAbi, journalLeaf, proofFor, verifyProof } from '@holdfast/attest';
import { type Hex, digest } from '@holdfast/core';
import type { OrgRecord, PgliteConnection } from '@holdfast/db';
import type { JournalEntry } from '@holdfast/engine';
import { decodeFunctionData, getAddress } from 'viem';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAttestations, getAttestor, postOpenAttestation } from '../src/server/api/attestations';
import { getDemoAttestations, getDemoEntryProof, getDemoJournal, getDemoOverview, getDemoSafety } from '../src/server/api/public';
import { attestOrganisation } from '../src/server/attestations/service';
import { ConfigError } from '../src/server/errors';
import type { Endpoint } from '../src/server/http/endpoint';
import { expectOwnerOnly } from './support/access';
import { type Attesting, HOUR, journalOf, registered, tickAfter } from './support/attesting';
import { ATTESTOR_CONTRACT } from './support/fakes';
import { STARTUP_TIMEOUT_MS, UFVK, type World, call, keyAddress, migratedPglite, newAccount, organisation, sessionOf, tickOnce, world } from './support/world';

let connection: PgliteConnection;
let w: World;

beforeAll(async () => {
  connection = await migratedPglite();
}, STARTUP_TIMEOUT_MS);

afterAll(() => connection.close());

beforeEach(() => {
  w = world(connection);
});

const NOT_RECORDED = 'this deployment records no attestations';

/** A public demo with one snapshot on chain, sent by the service after its first tick. */
async function attested(over: { publicDemo?: boolean } = {}): Promise<Attesting & { params: { orgId: string } }> {
  const made = await registered(w, { name: 'Holdfast Demo', publicDemo: over.publicDemo ?? true });
  await tickOnce(w, made.org.id);
  await attest(made.org);
  return { ...made, params: { orgId: made.org.id } };
}

async function attest(org: OrgRecord): Promise<void> {
  const outcome = await attestOrganisation(w.deps, org.id);
  if (outcome.status !== 'attested') throw new Error(`no snapshot was recorded: ${JSON.stringify(outcome, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value))}`);
}

/** An hour on: one more journal entry and one more snapshot. */
async function again(org: OrgRecord): Promise<void> {
  await tickAfter(w, org, HOUR);
  await attest(org);
}

const get = (endpoint: Endpoint, params: Record<string, string>, query: Record<string, string> = {}) => call(w, endpoint, 'GET', { params, query });
const proofOf = (orgId: string, series: string, number: string, seq: string) => get(getDemoEntryProof, { orgId, series, number }, { seq });

/** The same entry with something in it changed and its digest brought up to date, as a forger would leave it. */
function forged(entry: JournalEntry): JournalEntry {
  const { prev, digest: _stale, ...body } = { ...entry, at: entry.at + 1 };
  return { ...body, prev, digest: digest({ prev, body }) };
}

describe('the public attestations of a demo', () => {
  it('answer for an organisation that is not a demo exactly as for one that does not exist', async () => {
    const hidden = await attested({ publicDemo: false });
    for (const [name, endpoint, more, query] of [
      ['attestations', getDemoAttestations, {}, {}],
      ['proof', getDemoEntryProof, { series: '0', number: '0' }, { seq: '1' }],
    ] as const) {
      const real = await get(endpoint, { orgId: hidden.org.id, ...more }, query);
      const absent = await get(endpoint, { orgId: 'no-such-organisation', ...more }, query);
      expect(real.status, name).toBe(404);
      expect(real.text, name).toBe(absent.text);
      expect(real.body, name).toEqual({ error: 'not_found', message: 'not found' });
    }
  });

  it('list the latest snapshots as the chain holds them now, with the hedge in ZEC and dollars and the transaction where the service sent it', async () => {
    const { org, attester, params } = await attested();
    const firstAt = w.clock.ms;
    await again(org);
    const [first, second] = w.attestor.snapshots(org.hlUser);
    const [firstTx, secondTx] = w.attestor.sent.map((tx) => tx.hash);
    w.clock.advance(30_000);

    const answer = await get(getDemoAttestations, params);
    expect(answer.status).toBe(200);
    expect(answer.headers.get('set-cookie')).toBeNull();
    expect(answer.body).toEqual({
      contract: ATTESTOR_CONTRACT,
      chainId: 999,
      account: org.hlUser,
      attester,
      snapshots: {
        status: 'ok',
        source: 'hyperevm',
        // As of the moment the chain was read, not of the snapshot.
        readAt: w.clock.ms,
        value: {
          series: '0',
          snapshotCount: '2',
          items: [
            { series: '0', number: '1', szi: '-5', shortZec: 0.05, oraclePx: 1223.3, markPx: 1223.15, l1Block: String(second?.l1BlockNumber), at: firstAt + HOUR, journalCount: '2', journalRoot: second?.journalRoot, treasuryCommitment: second?.treasuryCommitment, tx: secondTx },
            { series: '0', number: '0', szi: '-5', shortZec: 0.05, oraclePx: 1223.3, markPx: 1223.15, l1Block: String(first?.l1BlockNumber), at: firstAt, journalCount: '1', journalRoot: first?.journalRoot, treasuryCommitment: first?.treasuryCommitment, tx: firstTx },
          ],
        },
      },
    });
    expect(second?.journalRoot).toBe(attestationFor(await journalOf(w, org)).journalRoot);
  });

  it('show a flat position as zero and a long one as a negative short', async () => {
    const { org, params } = await attested();
    w.attestor.szi = 0n;
    await again(org);
    w.attestor.szi = 250n;
    await again(org);
    const { body } = await get(getDemoAttestations, params);
    expect(body.snapshots.value.items.map((item: { szi: string; shortZec: number }) => [item.szi, item.shortZec])).toEqual([
      ['250', -2.5],
      ['0', 0],
      ['-5', 0.05],
    ]);
  });

  it('show at most ten, the newest first, and no transaction for a snapshot the service did not send', async () => {
    const { org, params } = await attested();
    for (let count = 2n; count <= 13n; count++) w.attestor.put(org.hlUser, { journalCount: count, journalRoot: `0x${count.toString(16).padStart(64, '0')}` });
    const { body } = await get(getDemoAttestations, params);
    expect(body.snapshots.value.snapshotCount).toBe('13');
    const items: { number: string; tx: string | null }[] = body.snapshots.value.items;
    expect(items.map((item) => item.number)).toEqual(['12', '11', '10', '9', '8', '7', '6', '5', '4', '3']);
    expect(items.every((item) => item.tx === null)).toBe(true);
  });

  it('list the snapshots of the series that is current, and say so when it holds none', async () => {
    const { org, params } = await attested();
    w.attestor.startSeries(org.hlUser);
    const empty = await get(getDemoAttestations, params);
    expect(empty.body.snapshots.value).toEqual({ series: '1', snapshotCount: '0', items: [] });

    await tickOnce(w, org.id);
    await attest(org);
    const { body } = await get(getDemoAttestations, params);
    expect(body.snapshots.value).toMatchObject({ series: '1', snapshotCount: '1', items: [{ series: '1', number: '0', journalCount: '2', tx: w.attestor.sent[1]?.hash }] });
  });

  it('are unavailable when the chain cannot be read, and give nothing remembered in their place', async () => {
    const { org, attester, params } = await attested();
    w.attestor.down = 'reading the series failed: HTTP request failed. fetch failed';
    const answer = await get(getDemoAttestations, params);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      contract: ATTESTOR_CONTRACT,
      chainId: 999,
      account: org.hlUser,
      attester,
      snapshots: { status: 'unavailable', source: 'hyperevm', readAt: w.clock.ms, reason: 'reading the series failed: HTTP request failed. fetch failed' },
    });
    expect(answer.text).not.toContain(w.attestor.sent[0]?.hash);
  });

  it('say so where no attestations are recorded', async () => {
    const { org, attester, params } = await attested();
    w.deps.attestor = null;
    expect((await get(getDemoAttestations, params)).body).toEqual({
      contract: null,
      chainId: null,
      account: org.hlUser,
      attester,
      snapshots: { status: 'unavailable', source: 'hyperevm', readAt: w.clock.ms, reason: NOT_RECORDED },
    });
    const proof = await proofOf(org.id, '0', '0', '1');
    expect(proof.status).toBe(503);
    expect(proof.body).toEqual({ error: 'unavailable', message: `hyperevm is unavailable: ${NOT_RECORDED}`, source: 'hyperevm' });
  });

  it('never show the attester key, or the balance and salt behind a commitment', async () => {
    const { org, params } = await attested();
    const opening = await w.store.openAttestation(org.id, 0n, 0n);
    const key = await w.store.activeKey(org.id, 'hl_attester');
    for (const answer of [await get(getDemoAttestations, params), await proofOf(org.id, '0', '0', '1'), await get(getDemoSafety, params)]) {
      expect(answer.status).toBe(200);
      for (const secret of [opening?.salt, key?.secret, UFVK]) {
        expect(secret).toBeTruthy();
        expect(answer.text).not.toContain(secret);
      }
    }
  });

  describe('in the overview and the safety answer', () => {
    it('appear as a line about the latest snapshot, read from the chain now', async () => {
      const { org, params } = await attested();
      const at = w.clock.ms;
      const [snapshot] = w.attestor.snapshots(org.hlUser);
      w.clock.advance(20_000);
      const summary = {
        status: 'ok',
        source: 'hyperevm',
        readAt: w.clock.ms,
        value: { contract: ATTESTOR_CONTRACT, chainId: 999, series: '0', number: '0', at, shortZec: 0.05, oraclePx: 1223.3, journalCount: '1', journalRoot: snapshot?.journalRoot, tx: w.attestor.sent[0]?.hash },
      };
      const overview = await get(getDemoOverview, params);
      expect(overview.body.attestation).toEqual(summary);
      expect(overview.body.hedge.status).toBe('ok');
      expect((await get(getDemoSafety, params)).body.attestation).toEqual(summary);
    });

    it('are a null value while the series holds no snapshot, and unavailable when the chain cannot be read, with the rest of the page unharmed', async () => {
      const { org } = await registered(w, { publicDemo: true });
      await tickOnce(w, org.id);
      const params = { orgId: org.id };
      expect((await get(getDemoOverview, params)).body.attestation).toEqual({ status: 'ok', source: 'hyperevm', readAt: w.clock.ms, value: null });

      w.attestor.down = 'reading the series failed: HTTP request failed.';
      const overview = await get(getDemoOverview, params);
      expect(overview.status).toBe(200);
      expect(overview.body.attestation).toEqual({ status: 'unavailable', source: 'hyperevm', readAt: w.clock.ms, reason: 'reading the series failed: HTTP request failed.' });
      expect(overview.body.treasury.status).toBe('ok');
      expect(overview.body.hedge.status).toBe('ok');
      const safety = await get(getDemoSafety, params);
      expect(safety.body.attestation.status).toBe('unavailable');
      expect(safety.body.keys).toHaveLength(5);

      w.deps.attestor = null;
      expect((await get(getDemoOverview, params)).body.attestation).toEqual({ status: 'unavailable', source: 'hyperevm', readAt: w.clock.ms, reason: NOT_RECORDED });
    });

    it('leave the page standing when the settings of the attestations cannot be used, and say which one', async () => {
      const { params } = await attested();
      Object.defineProperty(w.deps, 'attestor', {
        get() {
          throw new ConfigError('HEDGE_ATTESTOR_ADDRESS', 'is not a contract address');
        },
      });
      const overview = await get(getDemoOverview, params);
      expect(overview.status).toBe(200);
      expect(overview.body.attestation).toEqual({ status: 'unavailable', source: 'hyperevm', readAt: w.clock.ms, reason: 'HEDGE_ATTESTOR_ADDRESS is not a contract address' });
      expect(overview.body.hedge.status).toBe('ok');
      expect((await get(getDemoSafety, params)).body.keys[4].scope).toMatchObject({ status: 'unavailable', reason: 'HEDGE_ATTESTOR_ADDRESS is not a contract address' });

      // The routes that are about nothing else answer as every route does for a setting it needs.
      const list = await get(getDemoAttestations, params);
      expect(list.status).toBe(500);
      expect(list.body).toEqual({ error: 'misconfigured', message: 'HEDGE_ATTESTOR_ADDRESS is not a contract address' });
    });
  });

  describe('the proof of one journal entry under a snapshot', () => {
    /** Three journal entries; snapshot 0 commits to the first, snapshot 1 to all three. */
    async function withTwoSnapshots() {
      const made = await attested();
      await tickAfter(w, made.org, HOUR - 60_000);
      await again({ ...made.org });
      return { ...made, journal: await journalOf(w, made.org), snapshots: w.attestor.snapshots(made.org.hlUser) };
    }

    it('verifies against the root the snapshot committed to, here and on the contract, for every entry it covers', async () => {
      const { org, journal, snapshots } = await withTwoSnapshots();
      expect(journal).toHaveLength(3);
      expect(snapshots.map((snapshot) => snapshot.journalCount)).toEqual([1n, 3n]);

      for (const entry of journal) {
        const answer = await proofOf(org.id, '0', '1', String(entry.seq));
        expect(answer.status).toBe(200);
        expect(answer.body).toEqual({
          contract: ATTESTOR_CONTRACT,
          chainId: 999,
          account: org.hlUser,
          series: '0',
          number: '1',
          seq: entry.seq,
          leaf: entry.digest,
          proof: proofFor(journal, entry.seq - 1),
          journalCount: '3',
          journalRoot: snapshots[1]?.journalRoot,
          verified: { status: 'ok', source: 'hyperevm', readAt: w.clock.ms, value: true },
        });
        const committed = { journalRoot: answer.body.journalRoot as Hex, journalCount: BigInt(answer.body.journalCount) };
        // Whoever checks computes the leaf from the entry itself.
        expect(verifyProof(committed, journalLeaf(entry), answer.body.proof)).toBe(true);
        expect(await w.attestor.verifyEntry(getAddress(org.hlUser), 0n, 1n, journalLeaf(entry), answer.body.proof)).toBe(true);
      }
    });

    it('fails for an entry that was tampered with, and for a proof that belongs to another entry', async () => {
      const { org, journal } = await withTwoSnapshots();
      const target = journal[1] as JournalEntry;
      const { body } = await proofOf(org.id, '0', '1', '2');
      const committed = { journalRoot: body.journalRoot as Hex, journalCount: BigInt(body.journalCount) };

      const tampered = journalLeaf(forged(target));
      expect(tampered).not.toBe(body.leaf);
      expect(verifyProof(committed, tampered, body.proof)).toBe(false);
      expect(await w.attestor.verifyEntry(getAddress(org.hlUser), 0n, 1n, tampered, body.proof)).toBe(false);
      // An entry whose content no longer matches its digest has no leaf at all.
      expect(() => journalLeaf({ ...target, at: target.at + 1 })).toThrow('journal entry does not match its digest');

      const other = (await proofOf(org.id, '0', '1', '3')).body;
      expect(verifyProof(committed, body.leaf, other.proof)).toBe(false);
    });

    it('can be checked from what the public journal serves, without anything the server computed', async () => {
      const { org } = await withTwoSnapshots();
      const served = (await get(getDemoJournal, { orgId: org.id })).body.entries as JournalEntry[];
      const entry = served.find((candidate) => candidate.seq === 2) as JournalEntry;
      const { body } = await proofOf(org.id, '0', '1', '2');
      expect(journalLeaf(entry)).toBe(body.leaf);
      expect(verifyProof({ journalRoot: body.journalRoot, journalCount: BigInt(body.journalCount) }, journalLeaf(entry), body.proof)).toBe(true);
    });

    it('is built from the journal as it was at that snapshot', async () => {
      const { org, journal } = await withTwoSnapshots();
      const early = await proofOf(org.id, '0', '0', '1');
      expect(early.body).toMatchObject({ number: '0', seq: 1, journalCount: '1', leaf: journal[0]?.digest, proof: [], verified: { status: 'ok', value: true } });
      const late = await proofOf(org.id, '0', '1', '1');
      expect(late.body.proof).toEqual(proofFor(journal, 0));
      expect(late.body.proof).not.toEqual(early.body.proof);

      // An entry written after the snapshot is not under it.
      const beyond = await proofOf(org.id, '0', '0', '2');
      expect(beyond.status).toBe(409);
      expect(beyond.body).toEqual({ error: 'refused', message: 'entry 2 is not among the 1 entries this snapshot commits to' });
    });

    it('does not exist for a snapshot or a series the chain does not hold, or for something that is no number', async () => {
      const { org } = await withTwoSnapshots();
      const absent = await proofOf('no-such-organisation', '0', '0', '1');
      for (const [series, number] of [['0', '2'], ['1', '0'], ['7', '0'], ['x', '0'], ['0', '-1'], ['0', '1.5'], ['0', '999999999999999999999']] as const) {
        const answer = await proofOf(org.id, series, number, '1');
        expect(answer.status, `${series}/${number}`).toBe(404);
        expect(answer.text).toBe(absent.text);
      }
      for (const query of [{}, { seq: '0' }, { seq: 'first' }, { seq: '1', extra: '1' }]) {
        const answer = await get(getDemoEntryProof, { orgId: org.id, series: '0', number: '0' }, query);
        expect(answer.status).toBe(400);
        expect(answer.body.error).toBe('invalid_input');
      }
    });

    it('still proves entries under the snapshots of a series that was closed', async () => {
      const { org, journal } = await withTwoSnapshots();
      w.attestor.startSeries(org.hlUser);
      const answer = await proofOf(org.id, '0', '1', '3');
      expect(answer.body).toMatchObject({ series: '0', number: '1', leaf: journal[2]?.digest, verified: { status: 'ok', value: true } });
    });

    it('is refused for a snapshot the journal cannot account for', async () => {
      const { org } = await withTwoSnapshots();
      w.attestor.put(org.hlUser, { journalCount: 40n, journalRoot: `0x${'ee'.repeat(32)}` });
      const inflated = await proofOf(org.id, '0', '2', '1');
      expect(inflated.status).toBe(409);
      expect(inflated.body.message).toBe('this snapshot commits to 40 entries and the journal holds 3, so no proof under it can be built');

      w.attestor.put(org.hlUser, { journalCount: 2n, journalRoot: `0x${'ab'.repeat(32)}` });
      const foreign = await proofOf(org.id, '0', '3', '1');
      expect(foreign.status).toBe(409);
      expect(foreign.body.message).toBe('the journal as it stands does not give the root this snapshot committed to, so no proof under it can be built');
    });

    it('is unavailable when the chain cannot be read, and comes without a verdict when only the verdict cannot be had', async () => {
      const { org, journal } = await withTwoSnapshots();
      w.attestor.verifyEntry = async () => {
        throw new Error('verifyEntry failed: HTTP request failed.');
      };
      const unverified = await proofOf(org.id, '0', '1', '2');
      expect(unverified.status).toBe(200);
      expect(unverified.body).toMatchObject({ leaf: journal[1]?.digest, proof: proofFor(journal, 1), verified: { status: 'unavailable', source: 'hyperevm', reason: 'verifyEntry failed: HTTP request failed.' } });

      w.attestor.down = 'reading the series failed: HTTP request failed.';
      const down = await proofOf(org.id, '0', '1', '2');
      expect(down.status).toBe(503);
      expect(down.body).toEqual({ error: 'unavailable', message: 'hyperevm is unavailable: reading the series failed: HTTP request failed.', source: 'hyperevm' });
    });
  });
});

describe('attestations, for the owner', () => {
  it('are for the owner alone', async () => {
    const { org } = await attested();
    const before = await w.store.listAttestations(org.id);
    await expectOwnerOnly(
      w,
      org.id,
      [
        { name: 'the attester and its calls', endpoint: getAttestor, method: 'GET' },
        { name: 'the attestations on record', endpoint: getAttestations, method: 'GET' },
        { name: 'opening a commitment', endpoint: postOpenAttestation, method: 'POST', params: { series: '0', number: '0' } },
      ],
      async () => expect(await w.store.listAttestations(org.id)).toEqual(before),
    );
  });

  describe('the attester', () => {
    it('comes with the two calls only the organisation’s account can make, ready for its wallet', async () => {
      const created = await organisation(w, newAccount().address);
      const cookie = await sessionOf(w, created.hlUser);
      const attester = await keyAddress(w, created.id, 'hl_attester');
      const answer = await call(w, getAttestor, 'GET', { cookie, params: { orgId: created.id } });
      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({
        contract: ATTESTOR_CONTRACT,
        chainId: 999,
        account: created.hlUser,
        attester,
        registered: { status: 'ok', source: 'hyperevm', readAt: w.clock.ms, value: { attester: null, registered: false } },
        setAttester: { to: ATTESTOR_CONTRACT, data: expect.stringMatching(/^0x[0-9a-f]+$/), chainId: 999 },
        startSeries: { to: ATTESTOR_CONTRACT, data: expect.stringMatching(/^0x[0-9a-f]+$/), chainId: 999 },
      });

      // The calldata is the contract's own two functions and nothing else.
      expect(decodeFunctionData({ abi: hedgeAttestorAbi, data: answer.body.setAttester.data })).toEqual({ functionName: 'setAttester', args: [getAddress(attester)] });
      expect(decodeFunctionData({ abi: hedgeAttestorAbi, data: answer.body.startSeries.data })).toMatchObject({ functionName: 'startSeries' });
      expect(answer.text).not.toContain((await w.store.activeKey(created.id, 'hl_attester'))?.secret);
    });

    it('is shown as registered only when the chain names this very key for the account', async () => {
      const { org, cookie, attester, params } = await attested();
      const view = async () => (await call(w, getAttestor, 'GET', { cookie, params })).body.registered;
      expect(await view()).toMatchObject({ status: 'ok', value: { attester, registered: true } });

      const other = newAccount().address;
      w.attestor.name(org.hlUser, other);
      expect(await view()).toMatchObject({ status: 'ok', value: { attester: other, registered: false } });

      w.attestor.down = 'attesterOf failed: HTTP request failed.';
      const down = await call(w, getAttestor, 'GET', { cookie, params });
      expect(down.status).toBe(200);
      expect(down.body.registered).toEqual({ status: 'unavailable', source: 'hyperevm', readAt: w.clock.ms, reason: 'attesterOf failed: HTTP request failed.' });
      // The calls do not depend on the chain being readable.
      expect(down.body.setAttester).toMatchObject({ to: ATTESTOR_CONTRACT, chainId: 999 });
    });

    it('has no calls to offer where no attestations are recorded, and none to name a key the organisation does not have', async () => {
      const { cookie, attester, params, org } = await attested();
      w.deps.attestor = null;
      expect((await call(w, getAttestor, 'GET', { cookie, params })).body).toEqual({
        contract: null,
        chainId: null,
        account: org.hlUser,
        attester,
        registered: { status: 'unavailable', source: 'hyperevm', readAt: w.clock.ms, reason: NOT_RECORDED },
        setAttester: null,
        startSeries: null,
      });

      w = world(connection);
      const owner = newAccount();
      await w.store.createOrg({ id: `keyless-${owner.address}`, name: 'Before Attesters', ufvk: UFVK, birthday: 3_512_000, hlUser: owner.address.toLowerCase(), policy: org.policy, lockEnabled: false });
      const keyless = await call(w, getAttestor, 'GET', { cookie: await sessionOf(w, owner.address), params: { orgId: `keyless-${owner.address}` } });
      expect(keyless.body).toMatchObject({ attester: null, setAttester: null, startSeries: { to: ATTESTOR_CONTRACT }, registered: { status: 'ok', value: { attester: null, registered: false } } });
    });
  });

  describe('the list', () => {
    it('holds what the chain shows and, beside it, what the service sent and how each attempt stands', async () => {
      const { org, cookie, params } = await attested();
      const confirmedAt = w.clock.ms;
      w.attestor.inclusion = 'held';
      await tickAfter(w, org, HOUR);
      expect(await attestOrganisation(w.deps, org.id)).toMatchObject({ status: 'pending' });
      const [confirmedTx, pendingTx] = w.attestor.sent.map((tx) => tx.hash);
      const [snapshot] = w.attestor.snapshots(org.hlUser);

      const answer = await call(w, getAttestations, 'GET', { cookie, params });
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ contract: ATTESTOR_CONTRACT, chainId: 999, account: org.hlUser, snapshots: { status: 'ok', value: { series: '0', snapshotCount: '1', items: [{ number: '0', tx: confirmedTx }] } } });
      expect(answer.body.recorded).toEqual([
        { id: expect.any(String), orgId: org.id, series: '0', number: null, tx: pendingTx, journalCount: '2', journalRoot: attestationFor(await journalOf(w, org)).journalRoot, commitment: expect.stringMatching(/^0x[0-9a-f]{64}$/), sentAt: w.clock.ms, status: 'pending', detail: null },
        { id: expect.any(String), orgId: org.id, series: '0', number: '0', tx: confirmedTx, journalCount: '1', journalRoot: snapshot?.journalRoot, commitment: snapshot?.treasuryCommitment, sentAt: confirmedAt, status: 'confirmed', detail: null },
      ]);
      expect(answer.body.stopped).toEqual({ status: 'ok', source: 'hyperevm', readAt: w.clock.ms, value: null });

      // What a commitment hides is not in the list; it is asked for snapshot by snapshot.
      const opening = await w.store.openAttestation(org.id, 0n, 0n);
      expect(opening?.salt).toBeTruthy();
      expect(answer.text).not.toContain(opening?.salt);
    });

    it('says when attesting has stopped, why, and stops saying so once a new series is started', async () => {
      const { org, cookie } = await registered(w);
      const params = { orgId: org.id };
      await tickOnce(w, org.id);
      w.attestor.put(org.hlUser, { journalCount: 40n, journalRoot: `0x${'ee'.repeat(32)}` });
      expect(await attestOrganisation(w.deps, org.id)).toMatchObject({ status: 'refused' });
      const stoppedAt = w.clock.ms;
      w.clock.advance(90_000);

      const { body } = await call(w, getAttestations, 'GET', { cookie, params });
      expect(body.stopped).toEqual({ status: 'ok', source: 'hyperevm', readAt: w.clock.ms, value: { series: '0', at: stoppedAt, reason: 'JournalShrank(40, 1)' } });
      expect(body.recorded).toMatchObject([{ status: 'refused', series: '0', number: null, tx: null, commitment: null, detail: 'JournalShrank(40, 1)' }]);

      w.attestor.down = 'reading the series failed: HTTP request failed.';
      const blind = (await call(w, getAttestations, 'GET', { cookie, params })).body;
      expect(blind.stopped).toMatchObject({ status: 'unavailable', source: 'hyperevm' });
      expect(blind.recorded).toHaveLength(1);
      w.attestor.down = null;

      w.attestor.startSeries(org.hlUser);
      const resumed = (await call(w, getAttestations, 'GET', { cookie, params })).body;
      expect(resumed.stopped).toMatchObject({ status: 'ok', value: null });
      expect(resumed.snapshots.value).toMatchObject({ series: '1', snapshotCount: '0' });
    });
  });

  describe('opening a commitment', () => {
    const open = (cookie: string, orgId: string, series: string, number: string, body?: unknown) => call(w, postOpenAttestation, 'POST', { cookie, params: { orgId, series, number }, body });

    it('gives the balance and the salt that produce the commitment the chain holds', async () => {
      const { org, cookie } = await attested();
      const [snapshot] = w.attestor.snapshots(org.hlUser);
      const answer = await open(cookie, org.id, '0', '0');
      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({ series: '0', number: '0', treasuryZat: '5000000', treasuryZec: '0.05', salt: expect.stringMatching(/^0x[0-9a-f]{64}$/), commitment: snapshot?.treasuryCommitment });
      expect(commitTreasury(BigInt(answer.body.treasuryZat), answer.body.salt)).toBe(snapshot?.treasuryCommitment);
    });

    it('has nothing to open for a snapshot the service did not record, for a transaction still pending, or for something that is no snapshot', async () => {
      const { org, cookie } = await attested();
      w.attestor.put(org.hlUser, { journalCount: 1n, journalRoot: w.attestor.snapshots(org.hlUser)[0]?.journalRoot as Hex });
      w.attestor.inclusion = 'held';
      await tickAfter(w, org, HOUR);
      await attestOrganisation(w.deps, org.id);

      const absent = await open(cookie, 'no-such-organisation', '0', '0');
      for (const [series, number] of [['0', '1'], ['0', '2'], ['1', '0'], ['zero', '0'], ['0', '-1']] as const) {
        const answer = await open(cookie, org.id, series, number);
        expect(answer.status, `${series}/${number}`).toBe(404);
        expect(answer.text).toBe(absent.text);
      }
      expect((await open(cookie, org.id, '0', '0', { also: 'this' })).status).toBe(400);
    });

    it('works from the record alone, so a chain that cannot be read does not keep the owner from disclosing', async () => {
      const { org, cookie } = await attested();
      w.attestor.down = 'HTTP request failed.';
      expect((await open(cookie, org.id, '0', '0')).body).toMatchObject({ treasuryZat: '5000000' });
      w.deps.attestor = null;
      expect((await open(cookie, org.id, '0', '0')).status).toBe(200);
    });
  });
});
