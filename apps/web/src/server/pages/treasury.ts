import { zatToZec } from '@holdfast/core';
import type { OrgRecord, SwapPurpose } from '@holdfast/db';
import type { JournalEntry } from '@holdfast/engine';
import { formatZec } from '@holdfast/zcash';
import type { HoldfastNetwork } from '../config';
import type { Deps } from '../deps';
import { listSwaps } from '../funding/service';
import { ZCASH, latestEntry, referenceReading, treasuryReading } from '../live';
import { type Reading, available, mapReading, missing } from '../reading';
import { messageOf } from '../redact';

/**
 * What the viewing key shows of one organisation's treasury: the address it
 * receives on, the shielded balance of the latest scan, the payments that
 * came in with their memos, what the treasury itself sent and the fees it
 * paid, and the swaps that turned ZEC into dollars on the organisation's own
 * accounts.
 *
 * The viewing key is read here to derive the address and for nothing else;
 * the key itself is never part of an answer. The payments, like the balance,
 * are those of the latest tick, and are unavailable once that reading is
 * older than the organisation's policy allows.
 */

type TreasuryDeps = Pick<Deps, 'store' | 'zcash' | 'reference' | 'now' | 'redact' | 'report'>;

const KEY = 'viewing key';
const DATABASE = 'database';
const SHOWN = 100;

export interface TreasuryPayment {
  /** Stable identity of the row. */
  id: string;
  txid: string;
  height: number;
  /** Block time, ms. */
  time: number;
  zat: bigint;
  zec: string;
  memo: string;
  /** The pool it was received in or sent from; "transparent" for a payment that left the shielded pools. */
  pool: string;
}

export interface TreasuryActivity {
  /** Payments made to the treasury, newest first. `spent` is true once the treasury spent the note. */
  received: (TreasuryPayment & { spent: boolean })[];
  /** Change the treasury's own spends returned to it. */
  change: { count: number; zat: bigint; zec: string };
  /** What the treasury sent, newest first, as far as a viewing key can tell. */
  sent: TreasuryPayment[];
  /** Fees of the transactions the treasury sent, newest first. */
  fees: { txid: string; height: number; zat: bigint; zec: string }[];
  totals: { receivedZat: bigint; sentZat: bigint; feesZat: bigint };
  /** True when more rows exist than are shown. */
  truncated: boolean;
}

export interface TreasurySwap {
  id: string;
  purpose: SwapPurpose;
  /** ZEC paid in, zatoshi. */
  amountIn: bigint;
  amountInZec: string;
  /** The least the recipient can receive, in base units of the destination token. */
  minAmountOut: bigint;
  /** What the recipient received; null until the swap service reports it. */
  amountOut: bigint | null;
  /** The one-time transparent address the deposit is paid to. */
  depositAddress: string;
  /** The organisation's own account the dollars are delivered to. */
  recipient: string;
  /** The swap service's state, as it last reported it. */
  state: string;
  final: boolean;
  /** Zcash transactions the swap service named as the deposit. */
  originTxs: string[];
  /** Transactions that delivered to the recipient. */
  destinationTxs: string[];
  createdAt: number;
  updatedAt: number;
}

export interface TreasuryPage {
  network: HoldfastNetwork;
  /** The unified address the viewing key receives on. */
  address: Reading<string>;
  /** The first block the scan reads. */
  birthday: number;
  /** The last block fully scanned; null before the first scan. */
  scannedTo: number | null;
  /** The scan of the latest tick: how far it read, the chain tip it saw, and whether it had caught up with it. */
  scan: { seq: number; at: number; to: number; tip: number; caughtUp: boolean } | null;
  /** The shielded balance as the latest tick read it. */
  balance: Reading<{ zat: bigint; zec: string; seq: number }>;
  /** An independent ZEC price in dollars, read now; `asOf` is the moment the sources quoted it. */
  price: Reading<{ px: number; asOf: number }>;
  /** The balance at that price. It needs both. */
  valueUsd: Reading<{ usd: number; px: number; priceAsOf: number }>;
  activity: Reading<TreasuryActivity>;
  swaps: Reading<TreasurySwap[]>;
}

const newestFirst = <T extends { height: number }>(rows: readonly T[]): T[] => [...rows].reverse();
const sum = (rows: readonly { zat: bigint }[]): bigint => rows.reduce((total, row) => total + row.zat, 0n);

function scanOf(latest: JournalEntry | undefined): TreasuryPage['scan'] {
  if (latest === undefined || latest.scan === null) return null;
  return { seq: latest.seq, at: latest.at, to: latest.scan.to, tip: latest.scan.tip, caughtUp: latest.scan.caughtUp };
}

async function activityOf(deps: Pick<Deps, 'store'>, orgId: string): Promise<TreasuryActivity> {
  const [notes, outgoing, fees] = await Promise.all([deps.store.notes(orgId), deps.store.outgoing(orgId), deps.store.fees(orgId)]);
  const incoming = notes.filter((note) => note.kind === 'incoming');
  const change = notes.filter((note) => note.kind === 'change');
  return {
    received: newestFirst(incoming)
      .slice(0, SHOWN)
      .map((note) => ({ id: note.id, txid: note.txid, height: note.height, time: note.time, zat: note.zat, zec: formatZec(note.zat), memo: note.memo, pool: note.pool, spent: note.spent })),
    change: { count: change.length, zat: sum(change), zec: formatZec(sum(change)) },
    sent: newestFirst(outgoing)
      .slice(0, SHOWN)
      .map((out) => ({ id: out.id, txid: out.txid, height: out.height, time: out.time, zat: out.zat, zec: formatZec(out.zat), memo: out.memo, pool: out.pool })),
    fees: newestFirst(fees)
      .slice(0, SHOWN)
      .map((fee) => ({ txid: fee.txid, height: fee.height, zat: fee.zat, zec: formatZec(fee.zat) })),
    totals: { receivedZat: sum(incoming), sentZat: sum(outgoing), feesZat: sum(fees) },
    truncated: incoming.length > SHOWN || outgoing.length > SHOWN || fees.length > SHOWN,
  };
}

/**
 * A read of the organisation's own records. A failure is written to the log
 * and shown without its text: the error of a failed query quotes the
 * statement it ran.
 */
async function stored<T>(deps: Pick<Deps, 'now' | 'redact' | 'report'>, source: string, readAt: () => number, read: () => Promise<T>): Promise<Reading<T>> {
  try {
    const value = await read();
    return available(source, readAt(), value);
  } catch (error) {
    deps.report(deps.redact(error instanceof Error ? (error.stack ?? error.message) : messageOf(error)));
    return missing(source, deps.now(), 'the database could not be read');
  }
}

/** The treasury of one organisation as the page reads it. */
export async function treasuryPage(deps: TreasuryDeps, org: OrgRecord): Promise<TreasuryPage> {
  const latest = await latestEntry(deps, org.id);
  const treasury = treasuryReading(deps, org.policy, latest);

  const [address, price, activity, swaps] = await Promise.all([
    stored(deps, KEY, deps.now, async () => (await deps.store.loadOrg(org.id)).ufvk).then((key) => {
      if (key.status !== 'ok') return key;
      const checked = deps.zcash.check(key.value);
      return checked.ok ? available(KEY, key.readAt, checked.address) : missing<string>(KEY, key.readAt, 'the stored viewing key no longer derives an address');
    }),
    referenceReading(deps, org.policy),
    treasury.status === 'ok' ? stored(deps, ZCASH, () => treasury.readAt, () => activityOf(deps, org.id)) : Promise.resolve(missing<TreasuryActivity>(treasury.source, treasury.readAt, treasury.reason)),
    stored(deps, DATABASE, deps.now, async () =>
      (await listSwaps(deps, org.id)).map(
        (swap): TreasurySwap => ({
          id: swap.id,
          purpose: swap.purpose,
          amountIn: swap.amountIn,
          amountInZec: formatZec(swap.amountIn),
          minAmountOut: swap.minAmountOut,
          amountOut: swap.amountOut,
          depositAddress: swap.depositAddress,
          recipient: swap.recipient,
          state: swap.state,
          final: swap.final,
          originTxs: swap.originTxs,
          destinationTxs: swap.destinationTxs,
          createdAt: swap.createdAt,
          updatedAt: swap.updatedAt,
        }),
      ),
    ),
  ]);

  const balance = mapReading(treasury, (read) => ({ zat: read.zat, zec: formatZec(read.zat), seq: read.seq }));
  const valueUsd = ((): TreasuryPage['valueUsd'] => {
    if (treasury.status !== 'ok') return treasury;
    if (price.status !== 'ok') return price;
    // As old as the older of the two: the balance of the latest tick at a price read now.
    return available('zcash+reference', Math.min(treasury.readAt, price.value.asOf), { usd: zatToZec(treasury.value.zat) * price.value.px, px: price.value.px, priceAsOf: price.value.asOf });
  })();

  return {
    network: deps.zcash.network,
    address,
    birthday: org.birthday,
    scannedTo: org.scannedTo,
    scan: scanOf(latest),
    balance,
    price,
    valueUsd,
    activity,
    swaps,
  };
}
