import type { ShieldedNote, ShieldedTransaction, SyncParams } from '@ledgerhq/zcash-utils';
import { describe, expect, it } from 'vitest';
import { type ScanLib, ScannerUnavailableError, createTreasuryScanner } from '../src/scanner';

function note(over: Partial<ShieldedNote>, without: ('nullifier' | 'cmx')[] = []): ShieldedNote {
  const n: ShieldedNote = {
    amount: 1_450_000,
    transferType: 'incoming',
    memo: 'Grant milestone 2',
    pool: 'ironwood',
    nullifier: 'aa'.repeat(32),
    cmx: 'c1'.repeat(32),
    isSpent: false,
    ...over,
  };
  for (const key of without) delete n[key];
  return n;
}

const tx = (over: Partial<ShieldedTransaction>): ShieldedTransaction => ({
  txid: 'f0'.repeat(32),
  hex: '',
  blockHeight: 3_512_900,
  blockHash: '00'.repeat(32),
  blockTime: 1_791_600_000,
  fee: 10_000,
  transparentOut: 0,
  hasTransparentInputs: false,
  saplingNotes: [],
  orchardNotes: [],
  ironwoodNotes: [],
  ...over,
});

function fakeLib(o: {
  txs?: ShieldedTransaction[];
  spent?: string[];
  blocksScanned?: number;
  failOn?: string[];
  calls?: SyncParams[];
  tip?: number;
}): ScanLib {
  return {
    async getChainTip(url) {
      if (o.failOn?.includes(url)) throw new Error('connection refused');
      return o.tip ?? 3_512_916;
    },
    async startSync(params) {
      o.calls?.push(params);
      if (o.failOn?.includes(params.grpcUrl)) throw new Error('deadline exceeded');
      const queue = [...(o.txs ?? [])];
      return {
        next: async () => queue.shift() ?? null,
        stats: async () => ({
          blocksScanned: o.blocksScanned ?? params.endHeight - params.startHeight + 1,
          elapsedMs: 5,
          spentKnownNullifiers: o.spent ?? [],
        }),
      };
    },
  };
}

const range = { ufvk: 'uview1test', fromHeight: 3_512_800, toHeight: 3_512_900, knownNullifiers: [] as string[] };
const scanner = (lib: ScanLib, endpoints = ['https://a:443', 'https://b:443']) =>
  createTreasuryScanner({ network: 'mainnet', endpoints, lib });

describe('treasury scanner', () => {
  it('reports the chain tip', async () => {
    expect(await scanner(fakeLib({ tip: 3_512_916 })).tip()).toBe(3_512_916);
  });

  it('rejects a chain tip that cannot be right', async () => {
    await expect(scanner(fakeLib({ tip: 0 })).tip()).rejects.toBeInstanceOf(ScannerUnavailableError);
  });

  it('maps an incoming payment with its memo', async () => {
    const r = await scanner(fakeLib({ txs: [tx({ ironwoodNotes: [note({})] })] })).scan(range);
    expect(r.notes).toEqual([
      {
        id: `${'f0'.repeat(32)}:ironwood:${'c1'.repeat(32)}`,
        txid: 'f0'.repeat(32),
        height: 3_512_900,
        time: 1_791_600_000_000,
        zat: 1_450_000n,
        memo: 'Grant milestone 2',
        pool: 'ironwood',
        kind: 'incoming',
        nullifier: 'aa'.repeat(32),
        spent: false,
      },
    ]);
    expect(r.outgoing).toEqual([]);
    expect(r.fees).toEqual([]);
  });

  it('does not charge the treasury the fee of a payment it received', async () => {
    const r = await scanner(fakeLib({ txs: [tx({ fee: 15_000, orchardNotes: [note({ pool: 'orchard' })] })] })).scan(range);
    expect(r.fees).toEqual([]);
  });

  it('separates change from payments sent, and books the fee', async () => {
    const sent = tx({
      ironwoodNotes: [
        note({ transferType: 'outgoing', amount: 400_000, memo: 'Invoice 14', cmx: 'd1'.repeat(32) }, ['nullifier']),
        note({ transferType: 'internal', amount: 1_040_000, memo: '', cmx: 'd2'.repeat(32) }),
      ],
    });
    const r = await scanner(fakeLib({ txs: [sent] })).scan(range);
    expect(r.outgoing.map((o) => [o.zat, o.memo, o.pool])).toEqual([[400_000n, 'Invoice 14', 'ironwood']]);
    expect(r.notes.map((n) => [n.kind, n.zat])).toEqual([['change', 1_040_000n]]);
    expect(r.fees).toEqual([{ txid: 'f0'.repeat(32), zat: 10_000n }]);
  });

  it('sees a shielded-to-transparent send through its transparent total', async () => {
    const sent = tx({
      transparentOut: 450_000,
      ironwoodNotes: [note({ transferType: 'internal', amount: 990_000, memo: '' })],
    });
    const r = await scanner(fakeLib({ txs: [sent] })).scan(range);
    expect(r.outgoing).toEqual([
      {
        id: `${'f0'.repeat(32)}:transparent`,
        txid: 'f0'.repeat(32),
        height: 3_512_900,
        time: 1_791_600_000_000,
        zat: 450_000n,
        memo: '',
        pool: 'transparent',
      },
    ]);
    expect(r.fees).toHaveLength(1);
  });

  it('does not mistake a transparent-funded transaction for a treasury send', async () => {
    const shielding = tx({ transparentOut: 5_000, hasTransparentInputs: true, ironwoodNotes: [note({})] });
    const r = await scanner(fakeLib({ txs: [shielding] })).scan(range);
    expect(r.outgoing).toEqual([]);
    expect(r.fees).toEqual([]);
  });

  it('identifies notes without a commitment by position', async () => {
    const r = await scanner(
      fakeLib({ txs: [tx({ saplingNotes: [note({ pool: 'sapling' }, ['cmx', 'nullifier'])] })] }),
    ).scan(range);
    expect(r.notes[0]?.id).toBe(`${'f0'.repeat(32)}:sapling:0`);
    expect(r.notes[0]?.nullifier).toBeNull();
  });

  it('passes known nullifiers down and returns the ones that were spent', async () => {
    const calls: SyncParams[] = [];
    const known = ['11'.repeat(32), '22'.repeat(32)];
    const r = await scanner(fakeLib({ calls, spent: ['22'.repeat(32)] })).scan({ ...range, knownNullifiers: known });
    expect(calls[0]?.knownNullifiers).toEqual(known);
    expect(calls[0]).toMatchObject({ startHeight: 3_512_800, endHeight: 3_512_900, network: 'mainnet', viewingKey: 'uview1test' });
    expect(r.spentNullifiers).toEqual(['22'.repeat(32)]);
  });

  it('marks notes spent later in the same range', async () => {
    const r = await scanner(fakeLib({ txs: [tx({ ironwoodNotes: [note({ isSpent: true })] })] })).scan(range);
    expect(r.notes[0]?.spent).toBe(true);
  });

  it('falls over to the next endpoint', async () => {
    const calls: SyncParams[] = [];
    const lib = fakeLib({ calls, failOn: ['https://a:443'], txs: [tx({ ironwoodNotes: [note({})] })] });
    const s = scanner(lib);
    expect(await s.tip()).toBe(3_512_916);
    const r = await s.scan(range);
    expect(r.notes).toHaveLength(1);
    expect(calls.map((c) => c.grpcUrl)).toEqual(['https://a:443', 'https://b:443']);
  });

  it('fails loudly when every endpoint is down', async () => {
    const s = scanner(fakeLib({ failOn: ['https://a:443', 'https://b:443'] }));
    await expect(s.scan(range)).rejects.toThrow(/a:443 \(deadline exceeded\).*b:443/);
    await expect(s.tip()).rejects.toBeInstanceOf(ScannerUnavailableError);
  });

  it('refuses a scan that covered fewer blocks than asked', async () => {
    const s = scanner(fakeLib({ blocksScanned: 40, txs: [tx({ ironwoodNotes: [note({})] })] }), ['https://a:443']);
    await expect(s.scan(range)).rejects.toThrow(/scanned 40 of 101 blocks/);
  });

  it('refuses amounts that are not whole zatoshi', async () => {
    const s = scanner(fakeLib({ txs: [tx({ ironwoodNotes: [note({ amount: 1.5 })] })] }), ['https://a:443']);
    await expect(s.scan(range)).rejects.toThrow(/not a whole number of zatoshi/);
  });

  it('refuses a malformed range and an empty endpoint list', async () => {
    await expect(scanner(fakeLib({})).scan({ ...range, fromHeight: 10, toHeight: 5 })).rejects.toThrow(/invalid scan range/);
    expect(() => createTreasuryScanner({ network: 'mainnet', endpoints: [] })).toThrow();
  });
});
