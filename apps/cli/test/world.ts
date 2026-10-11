import {
  buildLedger,
  buildPublishedStatement,
  type FeeRecord,
  type FundingPayment,
  type HedgeFill,
  type PayoutEvidence,
  type PublishedStatement,
  serializePublishedStatement,
  type SwapRecord,
} from '@holdfast/books';
import {
  DEFAULT_POLICY,
  type HedgeVenue,
  type OrderRequest,
  type OrderResult,
  type OutgoingPayment,
  type OwnedNote,
  type ScanResult,
  type TreasuryScanner,
  type VenueState,
} from '@holdfast/core';
import { MemoryStore, tick } from '@holdfast/engine';
import type { Sources, VenueReader } from '../src/env';

export const ORG = 'holdfast-demo';
export const UFVK = 'uview1qqqqdemoviewingkeythatmustneverbeprinted0000000000';
export const TREASURY_ADDRESS = 'u1holdfastdemotreasury0address';
/** A viewing key that is a real key, of somebody else's account. */
export const OTHER_UFVK = 'uview1qqqqsomebodyelsesviewingkey00000000000000000000000';
export const OTHER_ADDRESS = 'u1somebodyelse0address';
export const TESTNET_UFVK = 'uviewtest1qqqqatestnetviewingkey000000000000000000000000';
export const HL_ACCOUNT = '0xda22459d4776c240e9182be9e569f07617cef664';
export const BIRTHDAY = 3_512_000;
export const RECEIPT_TX = '27472243738462004e72b46b2b2f3ba20318d36d3ee1f0fbcb93ef5aa2e6ff84';
export const SPEND_TX = '2b3865fbbd334d4db4d1da760d2d8be30c72a89368e3bb6fbf7f2c9b42c00a7e';
export const ARRIVAL_TX = '0xa52944568cd2b32e48f277ee1c8728746036fc0b6f264fb009ab68e595745e10';
export const GRANT_MEMO = 'ZCG grant, milestone 2 of 4. Paid to the Holdfast demo treasury.';
export const TEMPO_PATH_USD = '0x20c0000000000000000000000000000000000000';

const at = (time: string) => Date.parse(`2026-10-09T${time}Z`);
const GENESIS = at('06:00:00');
const BLOCK_MS = 75_000;

export class Clock {
  ms = GENESIS;
  readonly now = () => this.ms;
}

interface Mined {
  txid: string;
  height: number;
  notes: OwnedNote[];
  outgoing: OutgoingPayment[];
  fee: bigint | null;
  /** Nullifiers of the notes this transaction spent. */
  spends: string[];
}

/** A Zcash chain that mines a block every 75 seconds and shows a viewing key what a real one would. */
export class FakeChain implements TreasuryScanner {
  readonly mined: Mined[] = [];
  down: string | null = null;
  /** A lagging endpoint reports a tip this many blocks short. */
  behind = 0;
  scans = 0;

  constructor(private readonly clock: Clock) {}

  private height(): number {
    return BIRTHDAY + Math.floor((this.clock.now() - GENESIS) / BLOCK_MS);
  }

  private timeOf(height: number): number {
    return GENESIS + (height - BIRTHDAY) * BLOCK_MS;
  }

  async tip(): Promise<number> {
    if (this.down !== null) throw new Error(this.down);
    return this.height() - this.behind;
  }

  async scan(i: { fromHeight: number; toHeight: number; knownNullifiers: string[] }): Promise<ScanResult> {
    if (this.down !== null) throw new Error(this.down);
    this.scans++;
    const seen = this.mined.filter((tx) => tx.height >= i.fromHeight && tx.height <= i.toHeight);
    const spent = new Set(seen.flatMap((tx) => tx.spends));
    return {
      notes: seen.flatMap((tx) => tx.notes).map((note) => ({ ...note, spent: note.nullifier !== null && spent.has(note.nullifier) })),
      outgoing: seen.flatMap((tx) => tx.outgoing),
      fees: seen.flatMap((tx) => (tx.fee === null ? [] : [{ txid: tx.txid, zat: tx.fee }])),
      spentNullifiers: i.knownNullifiers.filter((nullifier) => spent.has(nullifier)),
    };
  }

  private note(txid: string, height: number, kind: OwnedNote['kind'], zat: bigint, memo: string): OwnedNote {
    const tag = `${txid.slice(0, 8)}-${kind}`;
    return { id: `${txid}:orchard:${tag}`, txid, height, time: this.timeOf(height), zat, memo, pool: 'orchard', kind, nullifier: `nf-${tag}`, spent: false };
  }

  receive(txid: string, zat: bigint, memo: string): OwnedNote {
    const height = this.height();
    const note = this.note(txid, height, 'incoming', zat, memo);
    this.mined.push({ txid, height, notes: [note], outgoing: [], fee: null, spends: [] });
    return note;
  }

  /** Spend notes to a transparent address; whatever is left after the fee comes back as change. */
  sendTransparent(txid: string, inputs: OwnedNote[], zat: bigint, fee: bigint): void {
    const height = this.height();
    const change = inputs.reduce((sum, note) => sum + note.zat, 0n) - zat - fee;
    this.mined.push({
      txid,
      height,
      notes: change > 0n ? [this.note(txid, height, 'change', change, '')] : [],
      outgoing: [{ id: `${txid}:transparent`, txid, height, time: this.timeOf(height), zat, memo: '', pool: 'transparent' }],
      fee,
      spends: inputs.flatMap((note) => (note.nullifier === null ? [] : [note.nullifier])),
    });
  }

  /** Fees as the database keeps them, with the block of their transaction. */
  fees(): FeeRecord[] {
    return this.mined.flatMap((tx) => (tx.fee === null ? [] : [{ txid: tx.txid, zat: tx.fee, height: tx.height }]));
  }
}

const TAKER_FEE_PER_MILLION = 450;
const HOURLY_FUNDING_RATE = 0.0000125;

/** A Hyperliquid account that fills every order in full at the mark and keeps its own history. */
export class FakeVenue implements HedgeVenue, VenueReader {
  markPx = 1218.4;
  shortLots = 0;
  /** Deposits, less fees, plus funding. */
  cash = 0;
  entryPx = 0;
  readonly fills: HedgeFill[] = [];
  readonly funding: FundingPayment[] = [];
  down: string | null = null;
  reads = 0;
  private nextOid = 570_748_779_376;

  constructor(private readonly clock: Clock) {}

  private check(): void {
    if (this.down !== null) throw new Error(this.down);
    this.reads++;
  }

  async state(): Promise<VenueState> {
    this.check();
    const unrealised = (this.shortLots / 100) * (this.entryPx - this.markPx);
    return { asOf: this.clock.now(), markPx: this.markPx, oraclePx: this.markPx, shortLots: this.shortLots, accountValueUsd: this.cash + unrealised };
  }

  async fundingAprBps(): Promise<number> {
    return 1_095;
  }

  async place(order: OrderRequest): Promise<OrderResult> {
    const size = order.lots / 100;
    const fee = Math.floor(size * this.markPx * TAKER_FEE_PER_MILLION) / 1_000_000;
    const oid = String(this.nextOid++);
    this.fills.push({
      time: this.clock.now() + 412,
      coin: 'ZEC',
      side: order.side,
      direction: order.side === 'sell' ? 'Open Short' : 'Close Short',
      size,
      px: this.markPx,
      fee,
      feeToken: 'USDC',
      closedPnlUsd: 0,
      oid,
      cloid: order.cloid,
      tid: `3182746509${this.fills.length.toString().padStart(5, '0')}`,
    });
    this.entryPx = this.markPx;
    this.shortLots += order.side === 'sell' ? order.lots : -order.lots;
    this.cash -= fee;
    return { ok: true, filledLots: order.lots, avgPx: this.markPx, oid, error: null };
  }

  /** Funding is paid on a position; an account without one gets no payment at all. */
  payFunding(): void {
    if (this.shortLots === 0) return;
    const usd = Math.round(HOURLY_FUNDING_RATE * (this.shortLots / 100) * this.markPx * 1_000_000) / 1_000_000;
    this.cash += usd;
    this.funding.push({ time: this.clock.now(), coin: 'ZEC', usd, size: -this.shortLots / 100, fundingRate: HOURLY_FUNDING_RATE });
  }

  async userFills(_user: string, sinceMs: number): Promise<HedgeFill[]> {
    this.check();
    return this.fills.filter((fill) => fill.time >= sinceMs);
  }

  async userFunding(_user: string, sinceMs: number): Promise<FundingPayment[]> {
    this.check();
    return this.funding.filter((payment) => payment.time >= sinceMs);
  }
}

const marginSwap: SwapRecord = {
  id: '0d7c2b0e-52a4-4c7b-9f0e-3a1d5b8c6e21',
  purpose: 'margin',
  originAsset: 'nep141:zec.omft.near',
  destinationAsset: '1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054',
  amountIn: 930_000n,
  minAmountOut: 1_091_000_000n,
  amountOut: 1_102_097_700n,
  depositAddress: 't1Rz5oeDUphb5vwrFvUXi9xWtyTTsLGvF6C',
  recipient: HL_ACCOUNT,
  state: 'SUCCESS',
  originTxs: [SPEND_TX],
  destinationTxs: [ARRIVAL_TX],
  createdAt: at('14:01:05'),
  updatedAt: at('14:11:48'),
};

const RUN_TX = '0x4f1b6c2d9e8a7b3c5d6e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e';
const payouts: PayoutEvidence[] = [
  {
    run: {
      id: 'HF-2026-10-0001',
      chain: 'tempo',
      token: TEMPO_PATH_USD,
      status: 'paid',
      total: 4_500_000n,
      tx: RUN_TX,
      createdAt: at('15:28:00'),
      executedAt: at('15:30:11'),
      lines: [
        { lineNo: 1, payeeName: 'Ada Reyes', toAddress: '0x8ba1f109551bD432803012645Ac136ddd64DBA72', amount: 3_000_000n, memo: 'HF-2026-10-0001/1', tx: RUN_TX, logIndex: 4 },
        { lineNo: 2, payeeName: 'Kofi Mensah', toAddress: '0x2546BcD3c84621e976D8185a91A922aE77ECEc30', amount: 1_500_000n, memo: 'HF-2026-10-0001/2', tx: RUN_TX, logIndex: 5 },
      ],
    },
    onChain: {
      tx: RUN_TX,
      transfers: [
        { to: '0x8ba1f109551bd432803012645ac136ddd64dba72', tokenAccount: null, amount: 3_000_000n, memo: 'HF-2026-10-0001/1' },
        { to: '0x2546bcd3c84621e976d8185a91a922ae77ecec30', tokenAccount: null, amount: 1_500_000n, memo: 'HF-2026-10-0001/2' },
      ],
      otherTxs: [],
    },
  },
];

export interface World {
  clock: Clock;
  chain: FakeChain;
  venue: FakeVenue;
  sources: Sources;
  published: PublishedStatement;
  /** The export as it would be written to disk. */
  file: string;
}

export interface WorldOptions {
  /** The first block the organisation says its treasury could hold funds in. */
  birthday?: number;
  /** The organisation's own scanner never reaches the chain, so its books hold no Zcash history at all. */
  blindToZcash?: boolean;
}

/** What each viewing key is the key of. The address comes from the key, never from a statement. */
async function describeKey(ufvk: string) {
  if (ufvk === UFVK) return { ok: true as const, network: 'mainnet' as const, address: TREASURY_ADDRESS };
  if (ufvk === OTHER_UFVK) return { ok: true as const, network: 'mainnet' as const, address: OTHER_ADDRESS };
  if (ufvk === TESTNET_UFVK) return { ok: true as const, network: 'testnet' as const, address: 'utest1demo' };
  return { ok: false as const, error: 'the key does not decode' };
}

/**
 * The demo treasury's first day, lived through by the real engine against a
 * fake chain and a fake venue: a grant arrives, part of it is swapped into
 * margin, the controller opens the short, funding is paid and a small payout
 * run goes out. The statement is then published the way the app would.
 */
export async function demoWorld(options: WorldOptions = {}): Promise<World> {
  const clock = new Clock();
  const chain = new FakeChain(clock);
  const venue = new FakeVenue(clock);
  const store = new MemoryStore();
  const birthday = options.birthday ?? BIRTHDAY;
  store.addOrg({ id: ORG, ufvk: UFVK, birthday, hlUser: HL_ACCOUNT, policy: DEFAULT_POLICY, lockEnabled: true });
  if (options.blindToZcash === true) chain.down = 'lightwalletd unreachable';

  const reference = { zecUsd: async () => ({ px: venue.markPx, asOf: clock.now() }) };
  const tickAt = async (time: string, markPx: number) => {
    clock.ms = at(time);
    venue.markPx = markPx;
    const outcome = await tick(ORG, { store, scanner: chain, venue, reference, now: clock.now });
    if (!outcome.ran) throw new Error('the tick did not run');
    return outcome.entry;
  };

  await tickAt('10:00:00', 1219.5);
  clock.ms = at('10:12:31');
  const grant = chain.receive(RECEIPT_TX, 1_975_000n, GRANT_MEMO);
  await tickAt('10:15:00', 1219.8);

  clock.ms = at('14:03:20');
  chain.sendTransparent(SPEND_TX, [grant], 930_000n, 15_000n);
  await tickAt('14:05:00', 1225.6);

  // The swap has delivered 11.020977 USDC to the venue: there is margin now, and the controller sells one lot.
  venue.cash = 11.020977;
  await tickAt('14:20:00', 1226.4);
  await tickAt('14:21:00', 1227.0);

  clock.ms = at('15:00:00.012');
  venue.payFunding();
  await tickAt('15:01:00', 1226.9);
  clock.ms = at('16:00:00.048');
  venue.payFunding();
  await tickAt('16:30:00', 1228.6);

  const now = at('16:30:30');
  const journal = store.journal(ORG);
  const { scannedTo } = await store.loadOrg(ORG);
  const blind = options.blindToZcash === true;
  const swaps = blind ? [] : [marginSwap];
  const ledger = buildLedger({
    notes: store.notes(ORG),
    outgoing: store.outgoing(ORG),
    fees: blind ? [] : chain.fees().filter((fee) => store.outgoing(ORG).some((out) => out.txid === fee.txid)),
    fills: venue.fills,
    funding: venue.funding,
    swaps,
    payoutRuns: payouts.map((p) => p.run),
    prices: journal.flatMap((entry) => (entry.snapshot.ref === null ? [] : [{ ts: entry.snapshot.ref.asOf, px: entry.snapshot.ref.px }])),
    assets: { [TEMPO_PATH_USD]: { symbol: 'pathUSD', decimals: 6, chain: 'tempo', usdPegged: true } },
  });

  const published = buildPublishedStatement({
    org: {
      id: ORG,
      name: 'Holdfast demo treasury',
      zcash: { network: 'mainnet', address: TREASURY_ADDRESS, birthday, scannedTo },
      hyperliquid: { account: HL_ACCOUNT, since: GENESIS, through: now },
      payoutAccounts: [{ chain: 'tempo', account: '0x52908400098527886E0F7030069857D2E4169EE7', token: TEMPO_PATH_USD }],
    },
    policy: DEFAULT_POLICY,
    ledger,
    journal,
    swaps,
    payouts,
    now,
    monthlyBurnUsd: 4,
    seriesStep: 'entry',
  });
  clock.ms = now;
  // Whatever kept the organisation's own scanner from the chain, the reader's reaches it.
  chain.down = null;

  const sources: Sources = { describeKey, zcash: async () => chain, hyperliquid: async () => venue };
  return { clock, chain, venue, sources, published, file: serializePublishedStatement(published) };
}
