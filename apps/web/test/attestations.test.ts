import { attestationFor, commitTreasury } from '@holdfast/attest';
import type { OrgRecord, PgliteConnection } from '@holdfast/db';
import { getAddress } from 'viem';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { occupy, pending } from '../../../packages/db/test/support/fakes';
import { postTick } from '../src/server/api/tick';
import { PENDING_GIVE_UP_MS, attestOrganisation } from '../src/server/attestations/service';
import { ConfigError } from '../src/server/errors';
import { runTick } from '../src/server/tick/service';
import { HOUR, TREASURY_ZAT, journalOf, registered, tickAfter } from './support/attesting';
import { BIRTHDAY, STARTUP_TIMEOUT_MS, TICK_SECRET, UFVK, type World, call, keyAddress, migratedPglite, newAccount, organisation, tickOnce, world } from './support/world';

describe('the attestation step', () => {
  let connection: PgliteConnection;
  let w: World;

  beforeAll(async () => {
    connection = await migratedPglite();
  }, STARTUP_TIMEOUT_MS);

  afterAll(() => connection.close());

  beforeEach(() => {
    w = world(connection);
  });

  const step = (org: OrgRecord) => attestOrganisation(w.deps, org.id);
  const skipped = (org: OrgRecord, reason: string) => ({ orgId: org.id, status: 'skipped', reason });
  const unread = (org: OrgRecord, reason: string) => ({ orgId: org.id, status: 'unavailable', reason });

  /** The same organisation one tick later, which is when the step runs. */
  async function ticked(name?: string) {
    const made = await registered(w, name === undefined ? {} : { name });
    await tickOnce(w, made.org.id);
    return made;
  }

  it('records the first snapshot: the root and length of the whole journal, and a commitment to the treasury of the latest tick', async () => {
    const { org, attester, account } = await ticked();
    const journal = attestationFor(await journalOf(w, org));

    const outcome = await step(org);
    const [sent] = w.attestor.sent;
    expect(outcome).toEqual({ orgId: org.id, status: 'attested', series: 0n, number: 0n, tx: sent?.hash, journalCount: 1n });
    expect(w.attestor.sent).toHaveLength(1);
    expect(sent?.from.toLowerCase()).toBe(attester);
    expect(sent?.call).toMatchObject({ user: account, journalCount: 1n, journalRoot: journal.journalRoot });

    const [snapshot] = w.attestor.snapshots(org.hlUser);
    expect(snapshot).toMatchObject({ journalCount: 1n, journalRoot: journal.journalRoot, timestamp: BigInt(w.clock.ms / 1000) });

    // What the service keeps is the transaction, where the chain put the snapshot, and what opens its commitment.
    expect(await w.store.listAttestations(org.id)).toEqual([
      { id: expect.any(String), orgId: org.id, series: 0n, number: 0n, tx: sent?.hash, journalCount: 1n, journalRoot: journal.journalRoot, commitment: snapshot?.treasuryCommitment, sentAt: w.clock.ms, status: 'confirmed', detail: null },
    ]);
    const opening = await w.store.openAttestation(org.id, 0n, 0n);
    expect(opening?.zat).toBe(TREASURY_ZAT);
    expect(opening?.salt).toMatch(/^0x[0-9a-f]{64}$/);
    expect(commitTreasury(TREASURY_ZAT, opening?.salt ?? '0x')).toBe(snapshot?.treasuryCommitment);
    expect(w.reported).toEqual([]);
  });

  it('waits out the interval, and then commits to the journal as it has grown, under a fresh salt', async () => {
    const { org } = await ticked();
    await step(org);

    await tickAfter(w, org, HOUR - 60_000);
    expect(await step(org)).toEqual(skipped(org, 'not due: snapshot 0 was recorded 59 minutes ago, and the next follows after 60'));
    expect(w.attestor.sent).toHaveLength(1);

    await tickAfter(w, org, 60_000);
    const journal = attestationFor(await journalOf(w, org));
    expect(await step(org)).toMatchObject({ status: 'attested', series: 0n, number: 1n, journalCount: 3n });
    expect(w.attestor.snapshots(org.hlUser)[1]).toMatchObject({ journalCount: 3n, journalRoot: journal.journalRoot });

    const [first, second] = [await w.store.openAttestation(org.id, 0n, 0n), await w.store.openAttestation(org.id, 0n, 1n)];
    expect(second?.salt).not.toBe(first?.salt);
    expect(second?.commitment).not.toBe(first?.commitment);
  });

  it('takes the time of the latest snapshot from the chain, whatever the database remembers', async () => {
    const { org } = await ticked();
    await step(org);
    // The record says the snapshot is years old; the chain says a minute.
    await connection.client.query("update holdfast.attestations set sent_at = '2020-01-01T00:00:00Z' where org_id = $1", [org.id]);
    await tickOnce(w, org.id);
    expect(await step(org)).toEqual(skipped(org, 'not due: snapshot 0 was recorded 1 minutes ago, and the next follows after 60'));

    // And a snapshot the service has no record of at all counts just the same.
    const other = await ticked('Attested Elsewhere');
    w.attestor.put(other.org.hlUser, {});
    expect(await step(other.org)).toEqual(skipped(other.org, 'not due: snapshot 0 was recorded 0 minutes ago, and the next follows after 60'));
    expect(await w.store.listAttestations(other.org.id)).toEqual([]);
    expect(w.attestor.sent).toHaveLength(1);
  });

  it('decides that nothing is due without reading the journal, which by then may be long', async () => {
    const { org } = await ticked();
    await step(org);
    await tickOnce(w, org.id);
    const journalRange = w.store.journalRange.bind(w.store);
    let reads = 0;
    w.store.journalRange = async (...range) => {
      reads++;
      return journalRange(...range);
    };
    expect(await step(org)).toMatchObject({ status: 'skipped', reason: expect.stringContaining('not due') });
    expect(reads).toBe(0);
  });

  it('sends nothing while the journal has not grown, however long ago the latest snapshot was', async () => {
    const { org } = await ticked();
    await step(org);
    w.clock.advance(3 * HOUR);
    expect(await step(org)).toEqual(skipped(org, 'the journal has not grown since snapshot 0 of series 0'));
    expect(w.attestor.sent).toHaveLength(1);
  });

  it('sends nothing for an account that has not named the attester, or has named another', async () => {
    const { org, account } = await ticked();
    const attester = getAddress(await keyAddress(w, org.id, 'hl_attester'));
    const reason = `the chain does not show ${attester} as the attester of the organisation's account`;

    w.attestor.name(org.hlUser, newAccount().address);
    expect(await step(org)).toEqual(skipped(org, reason));

    const unnamed = await organisation(w, newAccount().address);
    await tickOnce(w, unnamed.id);
    expect(await step(unnamed)).toMatchObject({ status: 'skipped', reason: expect.stringContaining('as the attester of the organisation') });

    expect(w.attestor.sent).toEqual([]);
    expect(w.attestor.asked).toEqual([]);
    expect(await w.store.listAttestations(org.id)).toEqual([]);

    // Once the account names the key, the next step attests.
    w.attestor.name(org.hlUser, attester);
    expect(await step(org)).toMatchObject({ status: 'attested', number: 0n });
    expect(w.attestor.sent[0]?.call.user).toBe(account);
  });

  it('leaves alone an organisation that has no attester key', async () => {
    const owner = newAccount();
    await w.store.createOrg({ id: `keyless-${owner.address}`, name: 'Before Attesters', ufvk: UFVK, birthday: BIRTHDAY, hlUser: owner.address.toLowerCase(), policy: (await registered(w)).org.policy, lockEnabled: false });
    await tickOnce(w, `keyless-${owner.address}`);
    expect(await attestOrganisation(w.deps, `keyless-${owner.address}`)).toEqual({ orgId: `keyless-${owner.address}`, status: 'skipped', reason: 'the organisation has no attester key' });
    expect(w.attestor.sent).toEqual([]);
  });

  it('does nothing where no attestations are recorded', async () => {
    const { org } = await ticked();
    w.deps.attestor = null;
    expect(await step(org)).toEqual(skipped(org, 'this deployment records no attestations'));
    expect(w.attestor.sent).toEqual([]);
    expect(await w.store.listAttestations(org.id)).toEqual([]);
  });

  describe('when something it rests on is unavailable or stale', () => {
    it('sends nothing if the latest tick did not read the treasury, and says why without the viewing key', async () => {
      const { org } = await registered(w);
      w.chain.scan = async () => {
        throw new Error(`lightwalletd refused ${UFVK}`);
      };
      await tickOnce(w, org.id);
      expect(await step(org)).toEqual(unread(org, 'the treasury balance of the latest tick is unavailable: lightwalletd refused [viewing key]'));
      expect(w.attestor.sent).toEqual([]);
    });

    it('sends nothing if the treasury reading of the latest tick has grown too old', async () => {
      const { org } = await ticked();
      w.clock.advance(org.policy.maxDataAgeMs + 1_000);
      expect(await step(org)).toEqual(unread(org, 'the treasury balance of the latest tick is unavailable: the latest treasury reading is 181 s old, over the 180 s allowed'));
      expect(w.attestor.sent).toEqual([]);
    });

    it('sends nothing if the chain cannot be read, and reports it', async () => {
      const { org } = await ticked();
      w.attestor.down = 'attesterOf failed: HTTP request failed. fetch failed';
      expect(await step(org)).toEqual(unread(org, 'attesterOf failed: HTTP request failed. fetch failed'));
      expect(w.reported).toEqual([`attestation of ${org.id}: attesterOf failed: HTTP request failed. fetch failed`]);
      w.attestor.down = null;
      expect(w.attestor.sent).toEqual([]);
    });

    it('sends nothing if the journal cannot be read from its first entry', async () => {
      const { org } = await ticked();
      await tickOnce(w, org.id);
      await connection.client.query('delete from holdfast.orders where org_id = $1', [org.id]);
      await connection.client.query('delete from holdfast.journal where org_id = $1 and seq = 1', [org.id]);
      expect(await step(org)).toEqual(unread(org, 'the journal could not be read completely: 1 of its first 2 entries were found'));
      expect(w.attestor.sent).toEqual([]);
    });

    it('sends nothing if an entry of the journal is not what its digest says', async () => {
      const { org } = await ticked();
      await connection.client.query("update holdfast.journal set entry = jsonb_set(entry, '{decision,mode}', '\"HOLD\"') where org_id = $1 and seq = 1", [org.id]);
      expect(await step(org)).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('journal entry does not match its digest') });
      expect(w.attestor.sent).toEqual([]);
    });

    it('sends nothing the contract would not record, having asked the node first', async () => {
      const { org } = await ticked();
      w.attestor.refuseWith = { error: 'PrecompileReadFailed', text: 'PrecompileReadFailed(0x0000000000000000000000000000000000000813)' };
      expect(await step(org)).toEqual(unread(org, 'the contract would not record the snapshot: PrecompileReadFailed(0x0000000000000000000000000000000000000813)'));
      expect(w.attestor.asked).toHaveLength(1);
      expect(w.attestor.sent).toEqual([]);
      // Not a refusal of the journal: nothing is on record, and the next step tries again.
      expect(await w.store.listAttestations(org.id)).toEqual([]);
      w.attestor.refuseWith = null;
      expect(await step(org)).toMatchObject({ status: 'attested' });
    });

    it('sends nothing once its time has run out', async () => {
      const { org } = await ticked();
      expect(await attestOrganisation(w.deps, org.id, { budgetMs: 0 })).toEqual(unread(org, 'the time allowed for the attestation ran out before it could be sent'));
      expect(w.attestor.sent).toEqual([]);
    });

    it('stands back while a tick holds the organisation', async () => {
      const { org } = await ticked();
      const holder = await occupy(w.store, org.id);
      expect(await step(org)).toEqual(skipped(org, 'a tick holds the organisation'));
      await holder.leave();
      expect(w.attestor.sent).toEqual([]);
    });
  });

  describe('around the moment of sending', () => {
    it('writes the transaction down, with what opens its commitment, before it leaves', async () => {
      const { org } = await ticked();
      const broadcast = w.attestor.broadcast.bind(w.attestor);
      let onRecordWhenSent: unknown;
      w.attestor.broadcast = async (raw) => {
        onRecordWhenSent = await w.store.listAttestations(org.id);
        return broadcast(raw);
      };
      await step(org);
      expect(onRecordWhenSent).toMatchObject([{ status: 'pending', tx: w.attestor.sent[0]?.hash, number: null, commitment: w.attestor.sent[0]?.call.treasuryCommitment }]);
    });

    it('sends nothing it could not write down first, and does not repeat the balance the failed write carried', async () => {
      const { org } = await ticked();
      const recordAttestation = w.store.recordAttestation.bind(w.store);
      // The driver's error for a failed statement quotes the statement and every parameter of it.
      w.store.recordAttestation = async (_orgId, attestation) => {
        const params = [org.id, attestation.tx, attestation.journalRoot, attestation.treasury?.zat, attestation.treasury?.salt];
        throw Object.assign(new Error(`Failed query: insert into "holdfast"."attestations" values ($1, $2, $3, $4, $5)\nparams: ${params.join(',')}`), {
          name: 'DrizzleQueryError',
          cause: new Error('connect ECONNREFUSED 10.0.0.1:6543'),
        });
      };
      expect(await step(org)).toEqual(unread(org, 'the database could not be used: connect ECONNREFUSED 10.0.0.1:6543'));
      expect(w.reported).toEqual([`attestation of ${org.id}: the database could not be used: connect ECONNREFUSED 10.0.0.1:6543`]);
      expect(w.reported.join('\n')).not.toContain(String(TREASURY_ZAT));
      expect(w.attestor.sent).toEqual([]);
      w.store.recordAttestation = recordAttestation;
      w.reported.length = 0;

      // Nor one it could not sign, for want of a nonce or a gas price.
      const sign = w.attestor.sign.bind(w.attestor);
      w.attestor.sign = async () => {
        throw new Error('preparing the attestation failed: HTTP request failed.');
      };
      expect(await step(org)).toEqual(unread(org, 'preparing the attestation failed: HTTP request failed.'));
      expect(w.attestor.sent).toEqual([]);
      expect(await w.store.listAttestations(org.id)).toEqual([]);
      w.attestor.sign = sign;

      expect(await step(org)).toMatchObject({ status: 'attested', number: 0n });
    });

    it('keeps as pending a transaction the node did not confirm taking, and sends another only once that one is given up', async () => {
      const { org } = await ticked();
      w.attestor.rejectSend = 'RPC Request failed. insufficient funds for gas * price + value';
      const reason = 'the node did not confirm taking it: sending the attestation failed: RPC Request failed. insufficient funds for gas * price + value';
      const outcome = await step(org);
      expect(outcome).toMatchObject({ orgId: org.id, status: 'pending', reason });
      const tx = outcome.status === 'pending' ? outcome.tx : '';
      expect(w.reported).toEqual([`attestation ${tx} of ${org.id}: ${reason}`]);
      expect(await w.store.listAttestations(org.id)).toMatchObject([{ status: 'pending', tx, number: null }]);

      w.attestor.rejectSend = null;
      w.clock.advance(60_000);
      expect(await step(org)).toEqual({ orgId: org.id, status: 'pending', tx, reason: 'the chain does not show the transaction yet' });
      expect(w.attestor.sent).toEqual([]);

      w.clock.advance(PENDING_GIVE_UP_MS);
      expect(await step(org)).toMatchObject({ status: 'failed', tx });
      await tickOnce(w, org.id);
      expect(await step(org)).toMatchObject({ status: 'attested', number: 0n, journalCount: 2n });
      expect(w.attestor.sent).toHaveLength(1);
    });

    it('sends nothing beside another step that wrote its transaction down first', async () => {
      const { org } = await ticked();
      w.attestor.inclusion = 'held';
      await step(org);
      expect(w.attestor.sent).toHaveLength(1);

      // A step that looked for a pending attestation before the other had written its own: it goes all
      // the way to signing, and the database then holds it to one at a time.
      w.store.pendingAttestation = async () => null;
      expect(await step(org)).toEqual(skipped(org, 'another attestation of the organisation is pending; nothing was sent'));
      expect(w.attestor.sent).toHaveLength(1);
      expect(await w.store.listAttestations(org.id)).toHaveLength(1);
    });
  });

  describe('a transaction that is not confirmed in time', () => {
    it('is recorded as pending, keeps anything else from being sent, and is confirmed by its hash on a later step', async () => {
      const { org } = await ticked();
      w.attestor.inclusion = 'held';
      const first = await step(org);
      const tx = w.attestor.sent[0]?.hash;
      expect(first).toEqual({ orgId: org.id, status: 'pending', tx, reason: 'the chain does not show the transaction yet' });
      expect(await w.store.listAttestations(org.id)).toMatchObject([{ status: 'pending', tx, series: 0n, number: null, journalCount: 1n }]);

      // The journal grows and time passes; while the first is pending no second one goes out.
      w.clock.advance(5 * 60_000);
      await tickOnce(w, org.id);
      expect(await step(org)).toMatchObject({ status: 'pending', tx });
      expect(w.attestor.sent).toHaveLength(1);
      expect(w.attestor.asked).toHaveLength(1);

      w.attestor.mine();
      expect(await step(org)).toEqual({ orgId: org.id, status: 'attested', series: 0n, number: 0n, tx, journalCount: 1n });
      expect(await w.store.listAttestations(org.id)).toMatchObject([{ status: 'confirmed', tx, series: 0n, number: 0n }]);
      expect(await w.store.pendingAttestation(org.id)).toBeNull();
      expect(await w.store.openAttestation(org.id, 0n, 0n)).toMatchObject({ zat: TREASURY_ZAT });
    });

    it('stays pending while its receipt cannot be read', async () => {
      const { org } = await ticked();
      w.attestor.inclusion = 'held';
      await step(org);
      w.attestor.down = 'reading the receipt failed: HTTP request failed.';
      expect(await step(org)).toMatchObject({ status: 'pending', reason: 'its receipt could not be read: reading the receipt failed: HTTP request failed.' });
      expect(await w.store.pendingAttestation(org.id)).toMatchObject({ status: 'pending' });
    });

    it('is given up for lost when the chain never shows it, and only then is another sent', async () => {
      const { org } = await ticked();
      w.attestor.inclusion = 'never';
      await step(org);
      const tx = w.attestor.sent[0]?.hash;

      w.clock.advance(PENDING_GIVE_UP_MS - 1);
      expect(await step(org)).toMatchObject({ status: 'pending', tx });
      w.clock.advance(1);
      expect(await step(org)).toEqual({ orgId: org.id, status: 'failed', tx, reason: 'no receipt 15 minutes after it was sent' });
      expect(await w.store.listAttestations(org.id)).toMatchObject([{ status: 'lost', tx, number: null, detail: 'no receipt 15 minutes after it was sent' }]);
      expect(w.reported).toEqual([`attestation ${tx} of ${org.id} was given up for lost: no receipt 15 minutes after it was sent`]);
      expect(w.attestor.sent).toHaveLength(1);

      w.attestor.inclusion = 'now';
      await tickOnce(w, org.id);
      expect(await step(org)).toMatchObject({ status: 'attested', series: 0n, number: 0n, journalCount: 2n });
      expect(w.attestor.sent).toHaveLength(2);
      expect((await w.store.listAttestations(org.id)).map((row) => row.status).sort()).toEqual(['confirmed', 'lost']);
    });

    it('is recorded as reverted when the chain included it and it recorded nothing; the series goes on, but not before an interval has passed', async () => {
      const { org, attester } = await ticked();
      w.attestor.inclusion = 'held';
      await step(org);
      const tx = w.attestor.sent[0]?.hash;
      // The account names another attester before the transaction is included.
      const replacement = newAccount().address;
      w.attestor.name(org.hlUser, replacement);
      w.attestor.mine();

      const outcome = await step(org);
      expect(outcome).toMatchObject({ status: 'failed', tx, reason: expect.stringContaining('the chain included the transaction and it recorded no snapshot; the contract now answers NotAttester(') });
      expect(await w.store.listAttestations(org.id)).toMatchObject([{ status: 'reverted', tx, number: null }]);
      expect(w.attestor.snapshots(org.hlUser)).toEqual([]);
      expect(w.reported).toHaveLength(1);

      // Whatever undid one transaction may undo the next: no gas is spent on finding out every minute.
      w.attestor.inclusion = 'now';
      w.attestor.name(org.hlUser, attester);
      await tickAfter(w, org, HOUR - 60_000);
      expect(await step(org)).toEqual(skipped(org, 'the last transaction recorded nothing; nothing is sent within 60 minutes of it'));
      expect(w.attestor.sent).toHaveLength(1);

      await tickAfter(w, org, 60_000);
      expect(await step(org)).toMatchObject({ status: 'attested', number: 0n, journalCount: 3n });
    });
  });

  describe('when the contract refuses to continue the series', () => {
    const STOPPED = (detail: string) => `attesting stopped in series 0 when the contract answered ${detail}; it resumes once the owner starts a new series`;

    it('records the refusal of a journal shorter than the series holds, and sends nothing until a new series is started', async () => {
      const { org } = await ticked();
      // A snapshot that claims more entries than the journal has: from a fault, or from a key in the wrong hands.
      w.attestor.put(org.hlUser, { journalCount: 40n, journalRoot: `0x${'ee'.repeat(32)}` });
      const journal = attestationFor(await journalOf(w, org));

      expect(await step(org)).toEqual({ orgId: org.id, status: 'refused', series: 0n, reason: 'JournalShrank(40, 1)' });
      expect(await w.store.listAttestations(org.id)).toEqual([
        { id: expect.any(String), orgId: org.id, series: 0n, number: null, tx: null, journalCount: 1n, journalRoot: journal.journalRoot, commitment: null, sentAt: w.clock.ms, status: 'refused', detail: 'JournalShrank(40, 1)' },
      ]);
      expect(w.reported).toEqual([`attestations of ${org.id} stopped in series 0: the contract answered JournalShrank(40, 1)`]);

      // From here on the contract is not even asked: later ticks, a longer journal and any amount of time change nothing.
      for (let i = 0; i < 3; i++) {
        await tickAfter(w, org, 2 * HOUR);
        expect(await step(org)).toEqual(skipped(org, STOPPED('JournalShrank(40, 1)')));
      }
      expect(w.attestor.asked).toHaveLength(1);
      expect(w.attestor.sent).toEqual([]);
      expect(await w.store.listAttestations(org.id)).toHaveLength(1);

      // Only the owner can start a new series; the first snapshot of it is due at once.
      w.attestor.startSeries(org.hlUser);
      expect(await step(org)).toMatchObject({ status: 'attested', series: 1n, number: 0n, journalCount: 4n });
      expect(w.attestor.sent).toHaveLength(1);
    });

    it('records the refusal of a journal as long as the one the series holds and not the same', async () => {
      const { org } = await ticked();
      const journal = attestationFor(await journalOf(w, org));
      const other = `0x${'ab'.repeat(32)}`;
      w.attestor.put(org.hlUser, { journalCount: 1n, journalRoot: other as `0x${string}` });

      expect(await step(org)).toEqual({ orgId: org.id, status: 'refused', series: 0n, reason: `JournalRewritten(${other}, ${journal.journalRoot})` });
      await tickOnce(w, org.id);
      w.clock.advance(2 * HOUR);
      expect(await step(org)).toEqual(skipped(org, STOPPED(`JournalRewritten(${other}, ${journal.journalRoot})`)));
      expect(w.attestor.sent).toEqual([]);
    });

    it('stops as well when a transaction it had sent comes back reverted for that reason', async () => {
      const { org } = await ticked();
      w.attestor.inclusion = 'held';
      await step(org);
      const tx = w.attestor.sent[0]?.hash;
      // Before it is included, someone else's snapshot claims a longer journal.
      w.attestor.put(org.hlUser, { journalCount: 40n, journalRoot: `0x${'ee'.repeat(32)}` });
      w.attestor.mine();

      expect(await step(org)).toEqual({ orgId: org.id, status: 'refused', series: 0n, reason: 'JournalShrank(40, 1)' });
      expect(await w.store.listAttestations(org.id)).toMatchObject([{ status: 'refused', tx, number: null, detail: 'JournalShrank(40, 1)' }]);
      w.attestor.inclusion = 'now';
      await tickOnce(w, org.id);
      w.clock.advance(2 * HOUR);
      expect(await step(org)).toEqual(skipped(org, STOPPED('JournalShrank(40, 1)')));
      expect(w.attestor.sent).toHaveLength(1);
    });
  });
});

describe('the tick, where attestations are recorded', () => {
  // The tick takes every organisation in the database, so each test has a database of its own.
  let connection: PgliteConnection;
  let w: World;

  beforeEach(async () => {
    connection = await migratedPglite();
    w = world(connection);
  }, STARTUP_TIMEOUT_MS);

  afterEach(() => connection.close());

  const byOrg = <T extends { orgId: string }>(items: readonly T[]) => new Map(items.map((item) => [item.orgId, item]));

  it('attests for an organisation once its tick has run, and reports what it did for each', async () => {
    const { org } = await registered(w);
    const unnamed = await organisation(w, newAccount().address, { name: 'Not Registered' });

    const report = await runTick(w.deps);
    expect(report.orgs.map((o) => o.status)).toEqual(['ran', 'ran']);
    const attestations = byOrg(report.attestations);
    expect(attestations.get(org.id)).toEqual({ orgId: org.id, status: 'attested', series: 0n, number: 0n, tx: w.attestor.sent[0]?.hash, journalCount: 1n });
    expect(attestations.get(unnamed.id)).toMatchObject({ status: 'skipped' });
    expect(w.attestor.snapshots(org.hlUser)).toHaveLength(1);

    // The next tick, a minute later, has nothing due.
    w.clock.advance(60_000);
    const answer = await call(w, postTick, 'POST', { headers: { authorization: `Bearer ${TICK_SECRET}` }, origin: null });
    expect(answer.status).toBe(200);
    expect(byOrg<{ orgId: string }>(answer.body.attestations).get(org.id)).toEqual({ orgId: org.id, status: 'skipped', reason: 'not due: snapshot 0 was recorded 1 minutes ago, and the next follows after 60' });
    expect(w.attestor.sent).toHaveLength(1);
  });

  it('writes the numbers of an attestation as decimal strings, and no key or salt, in its answer', async () => {
    const { org } = await registered(w);
    const answer = await call(w, postTick, 'POST', { headers: { authorization: `Bearer ${TICK_SECRET}` }, origin: null });
    expect(answer.body.attestations).toEqual([{ orgId: org.id, status: 'attested', series: '0', number: '0', tx: w.attestor.sent[0]?.hash, journalCount: '1' }]);
    const secrets = [(await w.store.activeKey(org.id, 'hl_attester'))?.secret, (await w.store.openAttestation(org.id, 0n, 0n))?.salt];
    for (const secret of secrets) {
      expect(secret).toBeTruthy();
      expect(answer.text).not.toContain(secret);
    }
  });

  it('does nothing about attestations, and nothing else differently, where none are recorded', async () => {
    const { org } = await registered(w);
    w.deps.attestor = null;
    const report = await runTick(w.deps);
    expect(report.orgs).toMatchObject([{ orgId: org.id, status: 'ran', seq: 1, mode: 'REBALANCE' }]);
    expect(report.attestations).toEqual([]);
    expect(report.swaps).toEqual([]);
    expect(w.attestor.sent).toEqual([]);
    expect(await w.store.listAttestations(org.id)).toEqual([]);
    expect(w.reported).toEqual([]);
  });

  it('starts no attestation for an organisation whose tick did not run', async () => {
    const { org } = await registered(w);
    const holder = await occupy(w.store, org.id);
    const report = await runTick(w.deps);
    expect(report.orgs).toEqual([{ orgId: org.id, status: 'busy' }]);
    expect(report.attestations).toEqual([]);
    await holder.leave();
  });

  it('reports every tick as it ran when the attestations fail, each in its own way', async () => {
    const down = await registered(w, { name: 'Chain Down' });
    const broken = await registered(w, { name: 'Store Broken' });
    w.attestor.down = `POST https://rpc.example.test/v2/rpc-key-that-must-not-leak failed`;
    const pendingAttestation = w.store.pendingAttestation.bind(w.store);
    w.store.pendingAttestation = async (orgId) => {
      if (orgId === broken.org.id) throw new Error('connect ECONNREFUSED 10.0.0.1:6543');
      return pendingAttestation(orgId);
    };

    const report = await runTick(w.deps);
    expect(report.orgs.map((o) => o.status)).toEqual(['ran', 'ran']);
    expect((await w.store.listJournal(down.org.id)).length + (await w.store.listJournal(broken.org.id)).length).toBe(2);
    const attestations = byOrg(report.attestations);
    expect(attestations.get(down.org.id)).toEqual({ orgId: down.org.id, status: 'unavailable', reason: 'POST [redacted] failed' });
    expect(attestations.get(broken.org.id)).toEqual({ orgId: broken.org.id, status: 'unavailable', reason: 'connect ECONNREFUSED 10.0.0.1:6543' });
    expect(w.reported.sort()).toEqual([`attestation of ${down.org.id}: POST [redacted] failed`, `attestation of ${broken.org.id}: connect ECONNREFUSED 10.0.0.1:6543`].sort());
    expect(w.attestor.sent).toEqual([]);
  });

  it('reports the tick as it ran even when the step cannot so much as report its own failure', async () => {
    const { org } = await registered(w);
    w.attestor.down = 'attesterOf failed: HTTP request failed.';
    w.deps.report = () => {
      throw new Error('the log is unreachable');
    };
    const report = await runTick(w.deps);
    expect(report.orgs).toMatchObject([{ orgId: org.id, status: 'ran', seq: 1 }]);
    expect(report.attestations).toEqual([{ orgId: org.id, status: 'unavailable', reason: 'the attestation step failed' }]);
  });

  it('answers in time when an attestation does not come back', async () => {
    const { org } = await registered(w);
    w.attestor.attesterOf = () => new Promise(() => undefined);
    const started = Date.now();
    const report = await runTick(w.deps, { attestBudgetMs: 40 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(report.orgs).toMatchObject([{ orgId: org.id, status: 'ran', seq: 1 }]);
    expect(report.attestations).toEqual([{ orgId: org.id, status: 'unavailable', reason: 'the time allowed for this invocation ran out before the attestation finished' }]);
  });

  it('does not keep the next organisation waiting for a chain', async () => {
    const first = await registered(w, { name: 'First' });
    const second = await registered(w, { name: 'Second' });
    const chain = pending();
    const attesterOf = w.attestor.attesterOf.bind(w.attestor);
    w.attestor.attesterOf = async (user) => {
      await chain.done;
      return attesterOf(user);
    };

    // One organisation at a time: were an attestation waited for in the queue, the second tick could not start.
    const running = runTick(w.deps, { concurrency: 1 });
    await vi.waitFor(async () => expect((await w.store.listJournal(first.org.id)).length + (await w.store.listJournal(second.org.id)).length).toBe(2), { timeout: 10_000 });
    expect(w.attestor.sent).toEqual([]);

    chain.finish();
    const report = await running;
    expect(report.attestations.map((a) => a.status)).toEqual(['attested', 'attested']);
  });

  it('runs every tick, and says why attestations are off, when their settings cannot be used', async () => {
    const { org } = await registered(w);
    Object.defineProperty(w.deps, 'attestor', {
      get() {
        throw new ConfigError('HEDGE_ATTESTOR_ADDRESS', 'is not a contract address');
      },
    });
    const report = await runTick(w.deps);
    expect(report.orgs).toMatchObject([{ orgId: org.id, status: 'ran' }]);
    expect(report.attestations).toEqual([]);
    expect(w.reported).toEqual(['attestations are off: HEDGE_ATTESTOR_ADDRESS is not a contract address']);
  });
});
