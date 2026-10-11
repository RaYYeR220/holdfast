import type { OutgoingPayment, OwnedNote } from '@holdfast/core';
import { describe, expect, it } from 'vitest';
import { buildLedger, buildStatement, type FeeRecord, isReceipt, isTreasuryZec, reconcile, sumAmounts, type SwapRecord } from '../src/index';
import { POLICY, USDC_HYPERCORE_ID, ZEC_ID, journalOf } from './fixtures';

/** A small deterministic generator, so a failing history can be replayed from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const START = Date.parse('2026-09-01T00:00:00Z');
const FIRST_BLOCK = 3_500_000;
const BLOCK_MS = 75_000;

interface Spend {
  txid: string;
  out: bigint;
  fee: bigint;
}

/**
 * A treasury that receives and spends at random. Every spend consumes whole
 * notes, pays some of their value out, pays a fee and gets the rest back as
 * change; some of the transparent ones fund a swap, and now and then the
 * treasury pays its own address instead of anybody else. A journal tick after
 * each transaction records what the unspent notes hold.
 */
function simulate(seed: number, steps: number) {
  const next = random(seed);
  const between = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const notes: OwnedNote[] = [];
  const outgoing: OutgoingPayment[] = [];
  const fees: FeeRecord[] = [];
  const swaps: SwapRecord[] = [];
  const spends: Spend[] = [];
  const ticks: Parameters<typeof journalOf>[0][number][] = [];
  let height = FIRST_BLOCK;
  let received = 0n;

  for (let step = 0; step < steps; step++) {
    height += between(1, 40);
    const time = START + (height - FIRST_BLOCK) * BLOCK_MS;
    const txid = `tx-${seed}-${step}`;
    const unspent = notes.filter((n) => !n.spent);
    const note = (kind: OwnedNote['kind'], zat: bigint, name: string = kind): OwnedNote => ({
      id: `${txid}:orchard:${name}`,
      txid,
      height,
      time,
      zat,
      memo: kind === 'incoming' ? `receipt ${step}` : '',
      pool: 'orchard',
      kind,
      nullifier: `nf-${txid}-${name}`,
      spent: false,
    });

    const inputs = unspent.slice(0, between(1, Math.min(3, Math.max(1, unspent.length))));
    const fee = BigInt(between(2, 4) * 5_000);
    const spendable = inputs.reduce((sum, n) => sum + n.zat, 0n) - fee;

    if (spendable <= 0n || next() < 0.5) {
      const grant = note('incoming', BigInt(between(100_000, 500_000_000)));
      notes.push(grant);
      received += grant.zat;
    } else if (spendable > 1n && next() < 0.15) {
      // The treasury moves part of what it holds to its own address: a note arrives, and nothing was received.
      const moved = BigInt(Math.max(1, Math.floor(Number(spendable - 1n) * next())));
      for (const input of inputs) input.spent = true;
      notes.push(note('incoming', moved, 'self'), note('change', spendable - moved));
      fees.push({ txid, zat: fee, height });
      spends.push({ txid, out: 0n, fee });
    } else {
      // Now and then the whole of the inputs is paid out and nothing comes back.
      const out = next() < 0.15 ? spendable : BigInt(Math.max(1, Math.floor(Number(spendable) * next())));
      const transparent = next() < 0.5;
      for (const input of inputs) input.spent = true;
      if (spendable > out) notes.push(note('change', spendable - out));
      outgoing.push({
        id: transparent ? `${txid}:transparent` : `${txid}:orchard:out`,
        txid,
        height,
        time,
        zat: out,
        memo: transparent ? '' : `invoice ${step}`,
        pool: transparent ? 'transparent' : 'orchard',
      });
      fees.push({ txid, zat: fee, height });
      spends.push({ txid, out, fee });
      if (transparent && next() < 0.6) {
        swaps.push({
          id: `swap-${seed}-${step}`,
          purpose: 'margin',
          originAsset: ZEC_ID,
          destinationAsset: USDC_HYPERCORE_ID,
          amountIn: out,
          minAmountOut: 1n,
          amountOut: out * 12n,
          depositAddress: `t1-${step}`,
          recipient: '0xteam',
          state: 'SUCCESS',
          originTxs: [],
          destinationTxs: [`0xarrival-${step}`],
          createdAt: time - 120_000,
          updatedAt: time + 480_000,
        });
      }
    }
    const held = notes.filter((n) => !n.spent).reduce((sum, n) => sum + n.zat, 0n);
    ticks.push({ at: time + 30_000, treasury: { zat: held, scannedTo: height }, venue: null });
  }
  return { notes, outgoing, fees, swaps, spends, received, journal: journalOf(ticks) };
}

const STEPS = 60;
const SEEDS = Array.from({ length: 40 }, (_, i) => 1_000 + i * 7_919);
const heldBy = (notes: readonly OwnedNote[]) => notes.filter((n) => !n.spent).reduce((sum, n) => sum + n.zat, 0n);

describe('conservation over random histories', () => {
  it('generates histories worth checking', () => {
    const sim = simulate(SEEDS[0] as number, STEPS);
    expect(sim.spends.length).toBeGreaterThan(10);
    expect(sim.swaps.length).toBeGreaterThan(2);
    expect(sim.notes.some((n) => n.kind === 'change')).toBe(true);
    expect(sim.notes.some((n) => n.spent)).toBe(true);
    expect(SEEDS.some((seed) => simulate(seed, STEPS).spends.some((spend) => spend.out === 0n))).toBe(true);
  });

  it.each(SEEDS)('the ledger adds up to the notes, seed %i', (seed) => {
    const sim = simulate(seed, STEPS);
    const ledger = buildLedger(sim);

    expect(sumAmounts(ledger.filter(isTreasuryZec))).toBe(heldBy(sim.notes));

    expect(sumAmounts(ledger.filter(isReceipt))).toBe(sim.received);

    for (const spend of sim.spends) {
      const entries = ledger.filter((e) => e.proof.tx === spend.txid && e.source === 'zcash');
      expect(sumAmounts(entries)).toBe(-(spend.out + spend.fee));
    }
  });

  it.each(SEEDS)('the journal agrees with the ledger at every tick, seed %i', (seed) => {
    const sim = simulate(seed, STEPS);
    const result = reconcile({ ledger: buildLedger(sim), journal: sim.journal, swaps: sim.swaps });
    expect(result.problems).toEqual([]);
    expect(result.matched.filter((m) => m.kind === 'balance')).toEqual([{ kind: 'balance', refs: ['journal:1', `journal:${STEPS}`] }]);
    expect(result.matched.filter((m) => m.kind === 'swap')).toHaveLength(sim.swaps.length);
  });

  it.each(SEEDS.slice(0, 10))('the statement accounts for the balance, seed %i', (seed) => {
    const sim = simulate(seed, STEPS);
    const now = (sim.journal.at(-1)?.at ?? 0) + 1_000;
    const s = buildStatement({ ledger: buildLedger(sim), journal: sim.journal, policy: POLICY, now, monthlyBurnUsd: null });

    expect(s.treasury?.zat).toBe(heldBy(sim.notes));
    expect(s.receipts!.zat - s.payments!.zat - s.swapped!.zat - s.fees.networkZat!).toBe(heldBy(sim.notes));
    expect(s.swapped?.count).toBe(sim.swaps.length);
    expect(s.receipts?.zat).toBe(sim.received);
    expect(s.payments!.count + s.swapped!.count).toBe(sim.spends.filter((spend) => spend.out > 0n).length);
  });

  it('notices a single zatoshi gone missing anywhere in a history', () => {
    const sim = simulate(4_242, STEPS);
    const index = sim.notes.findIndex((n) => n.memo !== '' && n.id.endsWith(':incoming') && n.height > (sim.notes[0] as OwnedNote).height);
    const notes = sim.notes.map((n, i) => (i === index ? { ...n, zat: n.zat - 1n } : n));
    const result = reconcile({ ledger: buildLedger({ ...sim, notes }), journal: sim.journal, swaps: sim.swaps });
    const [problem] = result.problems;
    expect(result.problems).toHaveLength(1);
    expect(problem).toMatchObject({ kind: 'balance_mismatch', severity: 'error' });
    expect(problem?.detail).toContain('(+1)');
    expect(problem?.refs.at(-1)).toBe(`journal:${STEPS}`);
  });
});
