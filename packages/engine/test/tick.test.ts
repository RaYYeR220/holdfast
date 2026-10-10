import {
  DEFAULT_POLICY,
  type HedgeVenue,
  type OrderRequest,
  type OwnedNote,
  type ReferencePrice,
  type ScanResult,
  type TreasuryScanner,
  type VenueState,
  ZERO_ROOT,
} from '@holdfast/core';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/memory-store';
import { MAX_BLOCKS_PER_TICK, REORG_DEPTH, cloidFor, tick, verifyChain } from '../src/tick';
import type { TickDeps } from '../src/types';

const PX = 1_223.3;
const BIRTHDAY = 3_512_000;
let clock = 1_800_000_000_000;
const now = () => clock;

const note = (height: number, zat: bigint, over: Partial<OwnedNote> = {}): OwnedNote => ({
  id: `tx${height}:ironwood:${zat}`,
  txid: `tx${height}`,
  height,
  time: 0,
  zat,
  memo: '',
  pool: 'ironwood',
  kind: 'incoming',
  nullifier: `nf${height}-${zat}`,
  spent: false,
  ...over,
});

class Chain implements TreasuryScanner {
  height = BIRTHDAY + 100;
  notes: OwnedNote[] = [];
  spends: { height: number; nullifier: string }[] = [];
  down = false;
  scans: { from: number; to: number; known: string[] }[] = [];

  async tip() {
    if (this.down) throw new Error('lightwalletd unreachable');
    return this.height;
  }

  async scan(i: { fromHeight: number; toHeight: number; knownNullifiers: string[] }): Promise<ScanResult> {
    if (this.down) throw new Error('lightwalletd unreachable');
    this.scans.push({ from: i.fromHeight, to: i.toHeight, known: i.knownNullifiers });
    const inRange = (h: number) => h >= i.fromHeight && h <= i.toHeight;
    const spentHere = this.spends.filter((s) => inRange(s.height)).map((s) => s.nullifier);
    return {
      notes: this.notes.filter((n) => inRange(n.height)).map((n) => ({ ...n, spent: spentHere.includes(n.nullifier ?? '') })),
      outgoing: [],
      fees: [],
      spentNullifiers: spentHere.filter((nf) => i.knownNullifiers.includes(nf)),
    };
  }
}

class Venue implements HedgeVenue {
  shortLots = 0;
  equity = 100;
  down = false;
  rejectWith: string | null = null;
  orders: OrderRequest[] = [];
  private readonly seen = new Set<string>();

  async state(): Promise<VenueState> {
    if (this.down) throw new Error('venue timeout');
    return { asOf: now(), markPx: PX, oraclePx: PX, shortLots: this.shortLots, accountValueUsd: this.equity };
  }

  async fundingAprBps() {
    return 1_190;
  }

  async place(o: OrderRequest) {
    this.orders.push(o);
    if (this.rejectWith !== null) return { ok: false, filledLots: 0, avgPx: null, oid: null, error: this.rejectWith };
    if (this.seen.has(o.cloid)) return { ok: false, filledLots: 0, avgPx: null, oid: null, error: 'duplicate client order id' };
    this.seen.add(o.cloid);
    this.shortLots += o.side === 'sell' ? o.lots : -o.lots;
    return { ok: true, filledLots: o.lots, avgPx: o.limitPx, oid: `oid-${this.orders.length}`, error: null };
  }
}

function setup(over: { lockEnabled?: boolean } = {}) {
  clock = 1_800_000_000_000;
  const store = new MemoryStore();
  store.addOrg({
    id: 'org',
    ufvk: 'uview1test',
    birthday: BIRTHDAY,
    hlUser: '0xabc',
    policy: DEFAULT_POLICY,
    lockEnabled: over.lockEnabled ?? true,
  });
  const chain = new Chain();
  const venue = new Venue();
  const ref = { down: false };
  const reference: ReferencePrice = {
    async zecUsd() {
      if (ref.down) throw new Error('only 1 of 3 price sources answered');
      return { px: PX, asOf: now() };
    },
  };
  const deps: TickDeps = { store, scanner: chain, venue, reference, now };
  const run = async () => {
    clock += 60_000;
    const outcome = await tick('org', deps);
    if (!outcome.ran) throw new Error('tick did not run');
    return outcome.entry;
  };
  return { store, chain, venue, ref, deps, run };
}

describe('tick', () => {
  it('scans from the birthday, sees the treasury and opens the lock', async () => {
    const t = setup();
    t.chain.notes = [note(BIRTHDAY + 10, 5_000_000n)];
    const e = await t.run();

    expect(t.chain.scans).toEqual([{ from: BIRTHDAY, to: BIRTHDAY + 100, known: [] }]);
    expect(e.snapshot.treasury?.zat).toBe(5_000_000n);
    expect(e.scan).toEqual({ from: BIRTHDAY, to: BIRTHDAY + 100, tip: BIRTHDAY + 100, caughtUp: true });
    expect(e.decision.mode).toBe('REBALANCE');
    expect(e.order).toMatchObject({ seq: 1, side: 'sell', lots: 5, reduceOnly: false, result: { ok: true, filledLots: 5 } });
    expect(e.order?.cloid).toBe(cloidFor('org', 1, 0));
    expect(e.seq).toBe(1);
    expect(e.prev).toBe(ZERO_ROOT);
    expect(e.errors).toEqual([]);
    expect(t.venue.shortLots).toBe(5);
  });

  it('holds once the short matches the treasury, and chains its journal', async () => {
    const t = setup();
    t.chain.notes = [note(BIRTHDAY + 10, 5_000_000n)];
    await t.run();
    const second = await t.run();
    expect(second.decision.mode).toBe('HOLD');
    expect(second.order).toBeNull();
    expect(t.venue.orders).toHaveLength(1);
    expect(verifyChain(t.store.journal('org'), ZERO_ROOT)).toEqual({ ok: true });
    expect(second.prev).toBe(t.store.journal('org')[0]?.digest);
  });

  it('re-reads the last blocks on every tick', async () => {
    const t = setup();
    await t.run();
    t.chain.height += 3;
    await t.run();
    expect(t.chain.scans[1]).toMatchObject({ from: BIRTHDAY + 100 - REORG_DEPTH + 1, to: BIRTHDAY + 103 });
  });

  it('drops a payment whose block was reorganised away', async () => {
    const t = setup();
    t.chain.notes = [note(BIRTHDAY + 95, 5_000_000n)];
    await t.run();
    expect(t.venue.shortLots).toBe(5);

    t.chain.notes = [];
    t.chain.height += 1;
    const e = await t.run();
    expect(e.snapshot.treasury?.zat).toBe(0n);
    expect(e.order).toMatchObject({ side: 'buy', lots: 5, reduceOnly: true });
    expect(t.venue.shortLots).toBe(0);
  });

  it('follows the treasury down when a known note is spent', async () => {
    const t = setup();
    t.chain.notes = [note(BIRTHDAY + 10, 3_000_000n), note(BIRTHDAY + 11, 2_000_000n)];
    await t.run();
    expect(t.venue.shortLots).toBe(5);

    t.chain.height += 30;
    t.chain.spends = [{ height: t.chain.height, nullifier: `nf${BIRTHDAY + 11}-2000000` }];
    const e = await t.run();
    expect(t.chain.scans[1]?.known.sort()).toEqual([`nf${BIRTHDAY + 10}-3000000`, `nf${BIRTHDAY + 11}-2000000`]);
    expect(e.snapshot.treasury?.zat).toBe(3_000_000n);
    expect(e.order).toMatchObject({ side: 'buy', lots: 2, reduceOnly: true });
  });

  it('does not hedge notes whose spends it cannot follow', async () => {
    const t = setup();
    t.chain.notes = [note(BIRTHDAY + 10, 5_000_000n, { pool: 'sapling', nullifier: null })];
    const e = await t.run();
    expect(e.snapshot.treasury?.zat).toBe(0n);
    expect(e.order).toBeNull();
    expect(t.store.untrackedBalance('org')).toBe(5_000_000n);
  });

  it('spreads a long first sync over several ticks and decides nothing until it is done', async () => {
    const t = setup();
    t.chain.height = BIRTHDAY + MAX_BLOCKS_PER_TICK + 500;
    t.chain.notes = [note(BIRTHDAY + 10, 5_000_000n)];
    const first = await t.run();
    expect(first.scan).toMatchObject({ to: BIRTHDAY + MAX_BLOCKS_PER_TICK - 1, caughtUp: false });
    expect(first.snapshot.treasury).toBeNull();
    expect(first.order).toBeNull();
    expect(first.decision.refusals.map((r) => r.code)).toEqual(['STALE_TREASURY']);

    const second = await t.run();
    expect(second.scan?.caughtUp).toBe(true);
    expect(second.order).toMatchObject({ side: 'sell', lots: 5 });
  });

  it('holds and says why when the chain cannot be read', async () => {
    const t = setup();
    t.chain.down = true;
    const e = await t.run();
    expect(e.snapshot.treasury).toBeNull();
    expect(e.order).toBeNull();
    expect(e.errors).toEqual([{ source: 'treasury', message: 'lightwalletd unreachable' }]);
    expect(e.decision.refusals.map((r) => r.code)).toEqual(['STALE_TREASURY']);
  });

  it('holds and says why when the venue cannot be read', async () => {
    const t = setup();
    t.chain.notes = [note(BIRTHDAY + 10, 5_000_000n)];
    t.venue.down = true;
    const e = await t.run();
    expect(e.snapshot.hl).toBeNull();
    expect(e.order).toBeNull();
    expect(e.errors).toEqual([{ source: 'venue', message: 'venue timeout' }]);
    expect(e.decision.refusals.map((r) => r.code)).toEqual(['STALE_HL']);
  });

  it('opens nothing without a reference price', async () => {
    const t = setup();
    t.chain.notes = [note(BIRTHDAY + 10, 5_000_000n)];
    t.ref.down = true;
    const e = await t.run();
    expect(e.order).toBeNull();
    expect(e.errors[0]?.source).toBe('reference');
    expect(e.decision.refusals.map((r) => r.code)).toEqual(['STALE_REF']);
  });

  it('journals a rejected order and does not try again inside the tick', async () => {
    const t = setup();
    t.chain.notes = [note(BIRTHDAY + 10, 5_000_000n)];
    t.venue.rejectWith = 'Insufficient margin to place order';
    const e = await t.run();
    expect(t.venue.orders).toHaveLength(1);
    expect(e.order?.result).toEqual({ ok: false, filledLots: 0, avgPx: null, oid: null, error: 'Insufficient margin to place order' });
  });

  it('records an unknown outcome when the venue adapter throws', async () => {
    const t = setup();
    t.chain.notes = [note(BIRTHDAY + 10, 5_000_000n)];
    t.venue.place = async () => {
      throw new Error('socket closed');
    };
    const e = await t.run();
    expect(e.order?.result).toMatchObject({ ok: false, error: 'outcome unknown: socket closed' });
  });

  it('skips a tick while another one is running', async () => {
    const t = setup();
    t.chain.notes = [note(BIRTHDAY + 10, 5_000_000n)];
    const [a, b] = await Promise.all([tick('org', t.deps), tick('org', t.deps)]);
    expect([a.ran, b.ran].sort()).toEqual([false, true]);
    expect(t.venue.orders).toHaveLength(1);
  });

  it('reuses the order id when a tick is repeated after a failed write', async () => {
    const t = setup();
    t.chain.notes = [note(BIRTHDAY + 10, 5_000_000n)];
    const append = t.store.appendJournal.bind(t.store);
    let failures = 1;
    t.store.appendJournal = async (entry) => {
      if (failures-- > 0) throw new Error('database unavailable');
      return append(entry);
    };

    await expect(t.run()).rejects.toThrow('database unavailable');
    expect(t.venue.shortLots).toBe(5);

    // The repeat sees the filled short, so it has nothing left to do; had it
    // tried again, it would have carried the same id and been refused.
    const e = await t.run();
    expect(e.seq).toBe(1);
    expect(e.order).toBeNull();
    expect(t.venue.orders).toHaveLength(1);
    expect(cloidFor('org', 1, 0)).toBe(t.venue.orders[0]?.cloid);
  });

  it('unwinds the short when the lock is switched off', async () => {
    const t = setup();
    t.chain.notes = [note(BIRTHDAY + 10, 5_000_000n)];
    await t.run();
    t.store.update('org', { lockEnabled: false });
    const e = await t.run();
    expect(e.order).toMatchObject({ side: 'buy', lots: 5, reduceOnly: true });
    expect(e.advisories).toEqual([]);
    expect(t.venue.shortLots).toBe(0);
  });

  it('opens nothing while the lock is off', async () => {
    const t = setup({ lockEnabled: false });
    t.chain.notes = [note(BIRTHDAY + 10, 5_000_000n)];
    const e = await t.run();
    expect(e.order).toBeNull();
    expect(e.decision.targetLots).toBe(0);
  });

  it('asks for margin when the treasury outgrows it', async () => {
    const t = setup();
    t.venue.equity = 20;
    t.chain.notes = [note(BIRTHDAY + 10, 10_000_000n)];
    const e = await t.run();
    // $20 at 2x carries 3 lots of the 10 the treasury calls for.
    expect(e.order).toMatchObject({ side: 'sell', lots: 3 });
    expect(e.decision.refusals.map((r) => r.code)).toEqual(['LEVERAGE_CAP']);
    expect(e.advisories.map((a) => a.kind)).toEqual(['TOP_UP_MARGIN', 'RELOCK']);
  });
});

describe('journal chain', () => {
  it('notices a changed entry and a missing one', async () => {
    const t = setup();
    t.chain.notes = [note(BIRTHDAY + 10, 5_000_000n)];
    await t.run();
    await t.run();
    await t.run();
    const journal = structuredClone(t.store.journal('org'));

    const edited = structuredClone(journal);
    edited[1]!.decision.reasons = ['nothing to see here'];
    expect(verifyChain(edited, ZERO_ROOT)).toEqual({ ok: false, seq: 2, reason: 'content does not match its digest' });

    const gap = [journal[0]!, journal[2]!];
    expect(verifyChain(gap, ZERO_ROOT)).toEqual({ ok: false, seq: 3, reason: 'does not follow the previous entry' });
    expect(verifyChain(journal, ZERO_ROOT)).toEqual({ ok: true });
  });

  it('refuses entries that are out of sequence', async () => {
    const t = setup();
    const e = await t.run();
    await expect(t.store.appendJournal(e)).rejects.toThrow(/out of sequence/);
  });
});
