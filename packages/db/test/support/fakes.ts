import type {
  HedgeVenue,
  OrderRequest,
  OrderResult,
  OwnedNote,
  ReferencePrice,
  ScanResult,
  TreasuryScanner,
  VenueState,
} from '@holdfast/core';
import type { Store } from '@holdfast/engine';

export const PX = 1_223.3;
export const BIRTHDAY = 3_512_000;

/** What a JS string can carry and Postgres cannot store, and the character that marks where it was. */
export const NUL = String.fromCharCode(0);
export const HIGH_HALF = String.fromCharCode(0xd83d);
export const LOW_HALF = String.fromCharCode(0xdc00);
export const GAP = String.fromCharCode(0xfffd);

export class Clock {
  ms = 1_800_000_000_000;
  readonly now = () => this.ms;

  advance(ms: number): void {
    this.ms += ms;
  }
}

export const note = (height: number, zat: bigint, over: Partial<OwnedNote> = {}): OwnedNote => ({
  id: `tx${height}:ironwood:${zat}`,
  txid: `tx${height}`,
  height,
  time: 1_799_000_000_000 + height * 75_000,
  zat,
  memo: '',
  pool: 'ironwood',
  kind: 'incoming',
  nullifier: `nf${height}-${zat}`,
  spent: false,
  ...over,
});

/** A chain that holds whatever notes and spends a test puts on it. */
export class Chain implements TreasuryScanner {
  height = BIRTHDAY + 100;
  notes: OwnedNote[] = [];
  spends: { height: number; nullifier: string }[] = [];

  async tip(): Promise<number> {
    return this.height;
  }

  async scan(i: { fromHeight: number; toHeight: number; knownNullifiers: string[] }): Promise<ScanResult> {
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

/** A venue that fills every order in full and refuses a repeated order id. */
export class Venue implements HedgeVenue {
  shortLots = 0;
  equity = 100;
  orders: OrderRequest[] = [];
  private readonly seen = new Set<string>();
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  async state(): Promise<VenueState> {
    return { asOf: this.now(), markPx: PX, oraclePx: PX, shortLots: this.shortLots, accountValueUsd: this.equity };
  }

  async fundingAprBps(): Promise<number> {
    return 1_190;
  }

  async place(o: OrderRequest): Promise<OrderResult> {
    this.orders.push(o);
    if (this.seen.has(o.cloid)) return { ok: false, filledLots: 0, avgPx: null, oid: null, error: 'duplicate client order id' };
    this.seen.add(o.cloid);
    this.shortLots += o.side === 'sell' ? o.lots : -o.lots;
    return { ok: true, filledLots: o.lots, avgPx: o.limitPx, oid: `oid-${this.orders.length}`, error: null };
  }
}

export const reference = (now: () => number): ReferencePrice => ({
  async zecUsd() {
    return { px: PX, asOf: now() };
  },
});

/** A promise that settles when the test says so: work that is still running. */
export function pending<T = void>() {
  let finish!: (value: T) => void;
  const done = new Promise<T>((resolve) => {
    finish = resolve;
  });
  return { done, finish };
}

/**
 * Start several attempts at something only one may do. Whoever gets in is
 * kept there until the others have been turned away, so the outcome does not
 * depend on how fast anything is; if more than one gets in, they give up
 * waiting and the count shows it.
 */
export async function contend<T extends { ran: boolean }>(count: number, attempt: (hold: () => Promise<void>) => Promise<T>): Promise<T[]> {
  const othersGone = pending();
  let turnedAway = 0;
  const hold = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const patience = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 2_000);
    });
    await Promise.race([othersGone.done, patience]);
    clearTimeout(timer);
  };
  return Promise.all(
    Array.from({ length: count }, async () => {
      const outcome = await attempt(hold);
      if (!outcome.ran && ++turnedAway === count - 1) othersGone.finish();
      return outcome;
    }),
  );
}

/**
 * Take an organisation's lock and stay inside, the way a tick that is slow
 * or dead does. Resolves once the lock is held; `leave` lets the work finish.
 */
export async function occupy(store: Store, orgId: string) {
  const inside = pending();
  const exit = pending();
  const outcome = store.withOrgLock(orgId, async () => {
    inside.finish();
    await exit.done;
  });
  const entered = await Promise.race([inside.done.then(() => true), outcome.then(() => false)]);
  if (!entered) throw new Error(`the lock on ${orgId} was already taken`);
  return {
    async leave() {
      exit.finish();
      return outcome;
    },
  };
}
