import { DEFAULT_POLICY } from '@holdfast/core';
import type { OrgRecord, PgliteConnection } from '@holdfast/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { attestOrganisation } from '../../src/server/attestations/service';
import { JOURNAL_PAGE, agentApprovalOf, journalPage, lockPage, proofOf, snapshotsOf } from '../../src/server/pages/lock';
import { registered, tickAfter } from '../support/attesting';
import { PX } from '../support/fakes';
import { BIRTHDAY, STARTUP_TIMEOUT_MS, type World, keyAddress, migratedPglite, newAccount, note, organisation, tickOnce, world } from '../support/world';

let connection: PgliteConnection;
let w: World;

beforeAll(async () => {
  connection = await migratedPglite();
}, STARTUP_TIMEOUT_MS);

afterAll(() => connection.close());

beforeEach(() => {
  w = world(connection);
});

interface Venue {
  /** What `clearinghouseState` lists for the account. */
  positions?: unknown[];
  /** What `extraAgents` lists for the account. */
  agents?: unknown[];
  /** When set, every request fails with this status. */
  status?: number;
}

/** Hyperliquid's info endpoint as far as the page asks it. */
function venue(answers: Venue = {}, asked: string[] = []): { fetch: typeof fetch } {
  return {
    fetch: async (_input, init) => {
      const { type } = JSON.parse(String(init?.body)) as { type: string };
      asked.push(type);
      if (answers.status !== undefined) return new Response('down', { status: answers.status });
      const body = type === 'extraAgents' ? (answers.agents ?? []) : { assetPositions: answers.positions ?? [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  };
}

async function fresh(org: OrgRecord): Promise<OrgRecord> {
  const found = await w.store.findOrg(org.id);
  if (found === null) throw new Error('the organisation is gone');
  return found;
}

/** An organisation with 2.5 ZEC in its treasury and one tick behind it. */
async function ticked(): Promise<OrgRecord> {
  const org = await organisation(w, newAccount().address);
  w.chain.notes = [note(BIRTHDAY + 10, 250_000_000n)];
  await tickOnce(w, org.id);
  return fresh(org);
}

describe('the lock as the page reads it', () => {
  it('gives the policy, says whether it is the default one, and names the account and the funding window', async () => {
    const org = await organisation(w, newAccount().address);
    const page = await lockPage(w.deps, org, venue());
    expect(page.policy).toEqual(DEFAULT_POLICY);
    expect(page.policyIsDefault).toBe(true);
    expect(page.account).toBe(org.hlUser);
    expect(page.lockEnabled).toBe(false);
    expect(page.fundingWindowHours).toBe(72);

    await w.store.updateOrg(org.id, { policy: { ...DEFAULT_POLICY, marginTargetBps: 8_500 } });
    expect((await lockPage(w.deps, await fresh(org), venue())).policyIsDefault).toBe(false);
  });

  it('shows the position the venue states, and no position as none', async () => {
    const org = await organisation(w, newAccount().address);
    const position = { coin: 'ZEC', szi: '-1.25', entryPx: '1226.4', positionValue: '1529.0', unrealizedPnl: '-3.5', liquidationPx: '2217.78' };
    const withShort = await lockPage(w.deps, org, venue({ positions: [{ position }] }));
    expect(withShort.position).toMatchObject({ status: 'ok', source: 'hyperliquid', value: { szi: '-1.25', entryPx: 1226.4, unrealizedPnlUsd: -3.5, liquidationPx: 2217.78 } });

    const without = await lockPage(w.deps, org, venue());
    expect(without.position).toMatchObject({ status: 'ok', value: null });
  });

  it('shows the position as unavailable, with the venue’s status, when the venue does not answer', async () => {
    const org = await organisation(w, newAccount().address);
    const page = await lockPage(w.deps, org, venue({ status: 502 }));
    expect(page.position).toMatchObject({ status: 'unavailable', source: 'hyperliquid', reason: 'Hyperliquid answered HTTP 502 to clearinghouseState' });
    expect(page.agent.approval).toMatchObject({ status: 'unavailable', reason: 'Hyperliquid answered HTTP 502 to extraAgents' });
  });

  describe('the preview', () => {
    it('is unavailable, with the reason, before any tick has read the treasury', async () => {
      const org = await organisation(w, newAccount().address);
      const { preview } = await lockPage(w.deps, org, venue());
      expect(preview).toMatchObject({ status: 'unavailable', source: 'the treasury balance', reason: 'the treasury balance is unavailable: no tick has run for this organisation yet' });
    });

    it('plans the sale for margin and the short for what is kept, at the price the venue shows', async () => {
      const org = await ticked();
      const { preview } = await lockPage(w.deps, org, venue());
      if (preview.status !== 'ok') throw new Error(`no preview: ${JSON.stringify(preview)}`);
      const { inputs, plan, assumed } = preview.value;
      expect(inputs.treasury.zat).toBe(250_000_000n);
      expect(inputs.price.px).toBe(PX);
      expect(assumed.swapCostBps).toBe(50);
      expect(plan.sellZat + BigInt(plan.hedgeLots) * 1_000_000n).toBeLessThanOrEqual(250_000_000n);
      expect(plan.hedgeLots).toBeGreaterThan(0);
      expect(plan.marginRatioBps).toBeGreaterThanOrEqual(7_900);
    });

    it('is a refusal, in the service’s words, when the treasury does not cover one lot after margin', async () => {
      const org = await organisation(w, newAccount().address);
      w.chain.notes = [note(BIRTHDAY + 10, 1_030_000n)];
      await tickOnce(w, org.id);
      const { preview } = await lockPage(w.deps, await fresh(org), venue());
      expect(preview.status).toBe('refused');
      expect(preview).toMatchObject({ reason: expect.stringContaining('there is nothing to lock') });
    });

    it('is unavailable when the venue cannot be read', async () => {
      const org = await ticked();
      w.venue.down = 'connect ETIMEDOUT';
      const { preview } = await lockPage(w.deps, org, venue());
      expect(preview).toMatchObject({ status: 'unavailable', source: 'Hyperliquid', reason: 'Hyperliquid is unavailable: connect ETIMEDOUT' });
    });
  });

  describe('the agent', () => {
    it('is shown by its address, and approved when the venue lists that address', async () => {
      const org = await organisation(w, newAccount().address);
      const agent = await keyAddress(w, org.id, 'hl_agent');
      const page = await lockPage(w.deps, org, venue({ agents: [{ name: 'holdfast', address: agent.toUpperCase().replace('0X', '0x'), validUntil: 1_900_000_000_000 }] }));
      expect(page.agent.address).toBe(agent);
      expect(page.agent.name).toBe('holdfast');
      expect(page.agent.approval).toMatchObject({ status: 'ok', value: { approved: true, validUntil: 1_900_000_000_000, nameHeldBy: null } });
    });

    it('is not approved on an account that lists no agent, which is what an account the venue never saw answers', async () => {
      const org = await organisation(w, newAccount().address);
      const approval = await agentApprovalOf(w.deps, org, venue());
      expect(approval).toMatchObject({ status: 'ok', value: { approved: false, validUntil: null, nameHeldBy: null } });
    });

    it('names the other agent that holds the service’s name, since approving replaces it', async () => {
      const org = await organisation(w, newAccount().address);
      const other = '0x00000000000000000000000000000000000000aa';
      const approval = await agentApprovalOf(w.deps, org, venue({ agents: [{ name: 'holdfast', address: other }, { name: 'another', address: '0x00000000000000000000000000000000000000bb' }] }));
      expect(approval).toMatchObject({ status: 'ok', value: { approved: false, nameHeldBy: other } });
    });

    it('never carries the key itself', async () => {
      const org = await organisation(w, newAccount().address);
      const stored = await w.store.activeKey(org.id, 'hl_agent');
      const page = await lockPage(w.deps, org, venue());
      expect(JSON.stringify(page, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value))).not.toContain(stored?.secret.slice(2, 20));
    });
  });
});

describe('the journal a page at a time', () => {
  it('is empty, and says so by having no entries, before the first tick', async () => {
    const org = await organisation(w, newAccount().address);
    const journal = await journalPage(w.deps, org);
    expect(journal).toMatchObject({ status: 'ok', value: { entries: [], chain: null, nextBeforeSeq: null } });
  });

  it('pages newest first, a page at a time, with the chain check of each page', async () => {
    const org = await organisation(w, newAccount().address);
    for (let i = 0; i < JOURNAL_PAGE + 3; i += 1) await tickOnce(w, org.id);
    const first = await journalPage(w.deps, await fresh(org));
    if (first.status !== 'ok') throw new Error('the journal could not be read');
    expect(first.value.entries.map((entry) => entry.seq)).toEqual(Array.from({ length: JOURNAL_PAGE }, (_unused, i) => JOURNAL_PAGE + 3 - i));
    expect(first.value.chain).toEqual({ ok: true, fromSeq: 4, toSeq: JOURNAL_PAGE + 3 });
    expect(first.value.isHead).toBe(true);
    expect(first.value.nextBeforeSeq).toBe(4);

    const older = await journalPage(w.deps, await fresh(org), { beforeSeq: 4 });
    if (older.status !== 'ok') throw new Error('the journal could not be read');
    expect(older.value.entries.map((entry) => entry.seq)).toEqual([3, 2, 1]);
    expect(older.value.nextBeforeSeq).toBeNull();
    expect(older.value.isHead).toBeNull();
  });
});

describe('snapshots and proofs', () => {
  async function attested(): Promise<OrgRecord> {
    const made = await registered(w);
    await tickOnce(w, made.org.id);
    await tickAfter(w, made.org, 60_000);
    const outcome = await attestOrganisation(w.deps, made.org.id);
    if (outcome.status !== 'attested') throw new Error('no snapshot was recorded');
    return fresh(made.org);
  }

  it('lists the snapshots the chain holds, newest first', async () => {
    const org = await attested();
    const snapshots = await snapshotsOf(w.deps, org);
    if (snapshots.status !== 'ok' || snapshots.value.snapshots.status !== 'ok') throw new Error('the snapshots could not be read');
    expect(snapshots.value.account).toBe(org.hlUser);
    expect(snapshots.value.snapshots.value.items).toHaveLength(1);
    expect(snapshots.value.snapshots.value.items[0]?.journalCount).toBe(2n);
  });

  it('reports the chain as unavailable where the deployment records no attestations', async () => {
    const org = await organisation(w, newAccount().address);
    w.deps.attestor = null;
    const snapshots = await snapshotsOf(w.deps, org);
    if (snapshots.status !== 'ok') throw new Error('the list itself failed');
    expect(snapshots.value.contract).toBeNull();
    expect(snapshots.value.snapshots).toMatchObject({ status: 'unavailable', reason: 'this deployment records no attestations' });
  });

  it('proves an entry the snapshot covers, with the contract’s own verdict', async () => {
    const org = await attested();
    const proof = await proofOf(w.deps, org, { series: 0n, number: 0n, seq: 2 });
    if (proof.status !== 'ok') throw new Error(`no proof: ${JSON.stringify(proof)}`);
    expect(proof.value.seq).toBe(2);
    expect(proof.value.journalCount).toBe(2n);
    expect(proof.value.verified).toMatchObject({ status: 'ok', value: true });
    expect(proof.value.account).toBe(org.hlUser);
  });

  it('refuses, with the reason, an entry the snapshot does not cover', async () => {
    const org = await attested();
    await tickAfter(w, org, 60_000);
    const proof = await proofOf(w.deps, await fresh(org), { series: 0n, number: 0n, seq: 3 });
    expect(proof).toMatchObject({ status: 'refused', reason: 'entry 3 is not among the 2 entries this snapshot commits to' });
  });

  it('refuses a snapshot that does not exist, naming what was asked for', async () => {
    const org = await attested();
    const proof = await proofOf(w.deps, org, { series: 0n, number: 7n, seq: 1 });
    expect(proof).toMatchObject({ status: 'refused', reason: 'the contract holds no snapshot 7 in series 0 for this account, or the journal has no entry 1' });
  });

  it('is unavailable when the chain cannot be read', async () => {
    const org = await attested();
    w.attestor.down = 'the node is down';
    const proof = await proofOf(w.deps, org, { series: 0n, number: 0n, seq: 1 });
    expect(proof).toMatchObject({ status: 'unavailable', source: 'hyperevm' });
  });
});
