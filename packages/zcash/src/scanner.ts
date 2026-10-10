import type { OutgoingPayment, OwnedNote, ScanResult, ShieldedPool, TreasuryScanner } from '@holdfast/core';
import * as native from '@ledgerhq/zcash-utils';

export type ZcashNetwork = 'mainnet' | 'testnet';

/** The slice of the native scanner this adapter relies on; injectable for tests. */
export interface ScanLib {
  getChainTip(grpcUrl: string): Promise<number>;
  startSync(params: native.SyncParams): Promise<{
    next(): Promise<native.ShieldedTransaction | null>;
    stats(): Promise<native.SyncStats>;
  }>;
}

export interface ScannerConfig {
  network: ZcashNetwork;
  /** lightwalletd / Zaino gRPC endpoints, tried in order. */
  endpoints: string[];
  lib?: ScanLib;
}

export const MAINNET_ENDPOINTS = ['https://zec.rocks:443', 'https://na.zec.rocks:443', 'https://eu.zec.rocks:443'];

export class ScannerUnavailableError extends Error {
  constructor(readonly attempts: { endpoint: string; error: string }[]) {
    super(`no Zcash endpoint answered: ${attempts.map((a) => `${a.endpoint} (${a.error})`).join('; ')}`);
    this.name = 'ScannerUnavailableError';
  }
}

const POOLS: [keyof Pick<native.ShieldedTransaction, 'saplingNotes' | 'orchardNotes' | 'ironwoodNotes'>, ShieldedPool][] = [
  ['saplingNotes', 'sapling'],
  ['orchardNotes', 'orchard'],
  ['ironwoodNotes', 'ironwood'],
];

function toZat(amount: number, what: string): bigint {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError(`${what}: amount ${amount} is not a whole number of zatoshi`);
  return BigInt(amount);
}

function mapTransaction(tx: native.ShieldedTransaction, into: ScanResult): void {
  const time = tx.blockTime * 1_000;
  let sentShielded = false;
  let ownsAnInput = false;

  for (const [field, pool] of POOLS) {
    tx[field].forEach((note, index) => {
      // The commitment identifies a note for good; pools without one fall back to position in the transaction.
      const id = `${tx.txid}:${pool}:${note.cmx ?? index}`;
      const zat = toZat(note.amount, id);
      if (note.transferType === 'outgoing') {
        sentShielded = true;
        into.outgoing.push({ id, txid: tx.txid, height: tx.blockHeight, time, zat, memo: note.memo, pool });
        return;
      }
      if (note.transferType === 'internal') ownsAnInput = true;
      const owned: OwnedNote = {
        id,
        txid: tx.txid,
        height: tx.blockHeight,
        time,
        zat,
        memo: note.memo,
        pool,
        kind: note.transferType === 'internal' ? 'change' : 'incoming',
        nullifier: note.nullifier ?? null,
        spent: note.isSpent,
      };
      into.notes.push(owned);
    });
  }

  // A shielded-to-transparent send leaves nothing to decrypt for the value it
  // moved; the transparent output total is the only trace of it.
  if (tx.transparentOut > 0 && !tx.hasTransparentInputs) {
    const out: OutgoingPayment = {
      id: `${tx.txid}:transparent`,
      txid: tx.txid,
      height: tx.blockHeight,
      time,
      zat: toZat(tx.transparentOut, `${tx.txid}:transparent`),
      memo: '',
      pool: 'transparent',
    };
    into.outgoing.push(out);
    sentShielded = true;
  }

  if ((sentShielded || ownsAnInput) && tx.fee > 0) {
    into.fees.push({ txid: tx.txid, zat: toZat(tx.fee, `${tx.txid}:fee`) });
  }
}

export function createTreasuryScanner(config: ScannerConfig): TreasuryScanner {
  const lib: ScanLib = config.lib ?? native;
  if (config.endpoints.length === 0) throw new RangeError('at least one Zcash endpoint is required');

  async function withFailover<T>(run: (endpoint: string) => Promise<T>): Promise<T> {
    const attempts: { endpoint: string; error: string }[] = [];
    for (const endpoint of config.endpoints) {
      try {
        return await run(endpoint);
      } catch (e) {
        attempts.push({ endpoint, error: e instanceof Error ? e.message : String(e) });
      }
    }
    throw new ScannerUnavailableError(attempts);
  }

  return {
    tip: () =>
      withFailover(async (endpoint) => {
        const height = await lib.getChainTip(endpoint);
        if (!Number.isInteger(height) || height <= 0) throw new Error(`implausible chain tip ${height}`);
        return height;
      }),

    scan: ({ ufvk, fromHeight, toHeight, knownNullifiers }) => {
      if (!Number.isInteger(fromHeight) || !Number.isInteger(toHeight) || fromHeight < 0 || toHeight < fromHeight) {
        return Promise.reject(new RangeError(`invalid scan range ${fromHeight}..${toHeight}`));
      }
      // A scan either completes on one endpoint or is retried whole on the
      // next; results from a half-finished stream are never returned.
      return withFailover(async (endpoint) => {
        const stream = await lib.startSync({
          grpcUrl: endpoint,
          viewingKey: ufvk,
          startHeight: fromHeight,
          endHeight: toHeight,
          network: config.network,
          knownNullifiers,
        });
        const result: ScanResult = { notes: [], outgoing: [], fees: [], spentNullifiers: [] };
        for (let tx = await stream.next(); tx !== null; tx = await stream.next()) mapTransaction(tx, result);
        const stats = await stream.stats();
        const expected = toHeight - fromHeight + 1;
        if (stats.blocksScanned < expected) {
          throw new Error(`scanned ${stats.blocksScanned} of ${expected} blocks`);
        }
        result.spentNullifiers = [...stats.spentKnownNullifiers];
        return result;
      });
    },
  };
}
