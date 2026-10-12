import type { HedgeSnapshot, SeriesState } from '@holdfast/attest';
import { type OrderRequest, type PayoutAllowance, type ReferencePrice, ZERO_ROOT } from '@holdfast/core';
import type { Fill, FundingPayment, HyperliquidState, HyperliquidVenue, PlaceResult } from '@holdfast/hyperliquid';
import { type Address, type Hex, isAddressEqual, keccak256, toHex } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { contractVerifies } from '../../../../packages/attest/test/support';
import type { AttestationCall, AttestationReceipt, AttestorPort, ContractRefusal, SolanaPayResult, SolanaPort, SolanaPreview, SolanaRail, SolanaRefusalProbe, SolanaRunInput, SolanaRunOnChain } from '../../src/server/deps';

export const PX = 1_223.3;

/** A hedge venue that fills every order in full, refuses a repeated order id, and can be taken down. */
export class FakeVenue implements HyperliquidVenue {
  shortLots = 0;
  equity = 100;
  markPx = PX;
  oraclePx = PX;
  fundingApr = 1_190;
  /** When set, every read fails with this message. */
  down: string | null = null;
  /** How far behind the clock the venue's own timestamp is, ms. */
  lag = 0;
  readonly orders: OrderRequest[] = [];
  readonly fills: Fill[] = [];
  readonly funding: FundingPayment[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly now: () => number) {}

  private guard(): void {
    if (this.down !== null) throw new Error(this.down);
  }

  async state(): Promise<HyperliquidState> {
    this.guard();
    return {
      asOf: this.now() - this.lag,
      markPx: this.markPx,
      oraclePx: this.oraclePx,
      shortLots: this.shortLots,
      accountValueUsd: this.equity,
      coin: 'ZEC',
      mode: 'unified',
      abstraction: 'unifiedAccount',
    };
  }

  async fundingAprBps(): Promise<number> {
    this.guard();
    return this.fundingApr;
  }

  async place(order: OrderRequest): Promise<PlaceResult> {
    this.orders.push(order);
    if (this.seen.has(order.cloid)) {
      return { ok: false, filledLots: 0, avgPx: null, oid: null, error: 'duplicate client order id', status: 'rejected', replayed: true };
    }
    this.seen.add(order.cloid);
    this.shortLots += order.side === 'sell' ? order.lots : -order.lots;
    const oid = `oid-${this.orders.length}`;
    this.fills.push({
      time: this.now(),
      coin: 'ZEC',
      side: order.side,
      direction: order.side === 'sell' ? 'Open Short' : 'Close Short',
      size: order.lots / 100,
      px: order.limitPx,
      fee: 0.01,
      feeToken: 'USDC',
      closedPnlUsd: 0,
      oid,
      cloid: order.cloid,
      tid: `tid-${this.orders.length}`,
      crossed: true,
    });
    return { ok: true, filledLots: order.lots, avgPx: order.limitPx, oid, error: null, status: 'filled', replayed: false };
  }

  async userFunding(_user: string, sinceMs: number): Promise<FundingPayment[]> {
    this.guard();
    return this.funding.filter((payment) => payment.time >= sinceMs);
  }

  async userFills(_user: string, sinceMs: number): Promise<Fill[]> {
    this.guard();
    return this.fills.filter((fill) => fill.time >= sinceMs);
  }
}

/** A reference price that follows the clock and can be taken down. */
export class FakeReference implements ReferencePrice {
  px = PX;
  down: string | null = null;

  constructor(private readonly now: () => number) {}

  async zecUsd(): Promise<{ px: number; asOf: number }> {
    if (this.down !== null) throw new Error(this.down);
    return { px: this.px, asOf: this.now() };
  }
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** A transparent Zcash address nobody holds, different for every `n`. */
export function depositAddress(n: number): string {
  return `t1Rz5oeDUphb5vwrFvUXi9xWtyTTsLGvF${BASE58[Math.floor(n / 58) % 58]}${BASE58[n % 58]}`;
}

/** Deposit addresses are unique for good, as the real service's are: tests share one database. */
let depositsIssued = 0;

interface QuoteBody {
  dry: boolean;
  originAsset: string;
  destinationAsset: string;
  amount: string;
  recipient: string;
  refundTo: string;
  slippageTolerance: number;
  deadline: string;
}

/**
 * 1Click as far as the application talks to it: it prices a swap at the
 * going rate less half a percent, hands out a deposit address per quote, and
 * reports whatever status a test has given that address.
 */
export class FakeOneClick {
  down: string | null = null;
  /** When set, what the next quotes carry in place of a deposit address; an empty string for none at all. */
  forceDeposit: string | null = null;
  readonly quotes: QuoteBody[] = [];
  readonly statusCalls: string[] = [];
  /** What `/v0/status` answers, by deposit address. An address that is not here is unknown to the service. */
  readonly swaps = new Map<string, { status: string; swapDetails?: Record<string, unknown>; updatedAt?: string }>();
  /** The deposit address of the latest quote that got one. */
  lastDeposit: string | null = null;

  readonly fetch: typeof fetch = async (input, init) => {
    if (this.down !== null) throw new Error(this.down);
    const url = new URL(String(input));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    if (url.pathname === '/v0/quote') {
      const request = JSON.parse(String(init?.body)) as QuoteBody;
      this.quotes.push(request);
      const zat = BigInt(request.amount);
      const usdIn = (Number(zat) / 1e8) * PX;
      const usdOut = usdIn * 0.995;
      const amountOut = BigInt(Math.floor(usdOut * 1e6));
      const address = request.dry ? undefined : (this.forceDeposit ?? depositAddress(++depositsIssued));
      if (address !== undefined && address !== '') this.lastDeposit = address;
      if (address !== undefined) this.swaps.set(address, { status: 'PENDING_DEPOSIT' });
      return json({
        signature: 'ed25519:quote-signature',
        quote: {
          depositAddress: address,
          amountIn: request.amount,
          amountOut: amountOut.toString(),
          minAmountOut: ((amountOut * BigInt(10_000 - request.slippageTolerance)) / 10_000n).toString(),
          amountInUsd: usdIn.toFixed(4),
          amountOutUsd: usdOut.toFixed(4),
          timeEstimate: 120,
          deadline: request.deadline,
        },
      });
    }

    if (url.pathname === '/v0/status') {
      const address = url.searchParams.get('depositAddress') ?? '';
      this.statusCalls.push(address);
      const swap = this.swaps.get(address);
      if (swap === undefined) return json({ message: 'unknown deposit address' }, 404);
      return json(swap);
    }

    return json({ message: `no such path ${url.pathname}` }, 404);
  };
}

export const SOLANA_OWNER = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
export const SOLANA_PAYEES = ['9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy'];

/**
 * The Solana payout rail as the application sees it, in memory: one team
 * wallet with an allowance, runs that are paid once and found again, and
 * switches for the ways the chain or the node can let a caller down.
 */
export class FakeSolana implements SolanaPort {
  cluster: SolanaPort['cluster'] = 'devnet';
  mint = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
  readonly decimals = 6;
  readonly tokenSymbol = 'USDC';

  allowance = 50_000_000n;
  slot = 412_000_000n;
  /** When set, every call that reaches the node fails with this message. */
  down: string | null = null;
  /** What the next payment does instead of paying. */
  nextPay: 'pay' | 'unknown' | 'fail' = 'pay';
  /** When set, the rail refuses to pay, with this as its reason. */
  refuseWith: string | null = null;
  readonly paid = new Map<string, SolanaRunOnChain>();
  readonly payCalls: SolanaRunInput[] = [];
  /** The earlier service keys each rail was made with, by the secret of its present one. */
  readonly previousDelegates = new Map<string, readonly string[]>();
  readonly sent: string[] = [];
  readonly probes: { account: string; to: string }[] = [];
  /** How single transactions were recorded, by signature, for `recorded`. */
  readonly outcomes = new Map<string, { failed: boolean; error: string | null }>();
  private keys = 0;
  private signatures = 0;
  private readonly addresses = new Map<string, string>();

  private guard(): void {
    if (this.down !== null) throw new Error(this.down);
  }

  private signature(): string {
    return `5sig${String(++this.signatures).padStart(4, '1')}VERzZfLQ3WxyzAbCdEfGhJkLmNpQrStUvWxYz123456789ABCDEFGH`;
  }

  async newDelegateKey(): Promise<{ secret: string; address: string }> {
    const n = ++this.keys;
    const secret = n.toString(16).padStart(64, '0');
    const address = `De1egate${BASE58[n % 58]}1111111111111111111111111111111111`;
    this.addresses.set(secret, address);
    return { secret, address };
  }

  /** Let a key that was made elsewhere be used here. */
  know(secret: string, address: string): void {
    this.addresses.set(secret, address);
  }

  rail(delegateSecret: string, previousDelegates: readonly string[] = []): SolanaRail {
    this.previousDelegates.set(delegateSecret, previousDelegates);
    const address = this.addresses.get(delegateSecret);
    const total = (i: SolanaRunInput) => i.lines.reduce((sum, line) => sum + line.amount, 0n);
    const sameLines = (run: SolanaRunOnChain, i: SolanaRunInput) =>
      run.transfers.length === i.lines.length && run.transfers.every((t, k) => t.to === i.lines[k]?.to && t.amount === i.lines[k]?.amount);
    const refuse = (error: string): SolanaPayResult => ({ ok: false, tx: null, error, outcome: 'refused', replayed: false, lineMemos: false, historyError: null });

    return {
      delegate: async () => {
        if (address === undefined) throw new Error('unknown service key');
        return address;
      },

      remaining: async (): Promise<PayoutAllowance> => {
        this.guard();
        return { remaining: this.allowance, limit: null, resetsAt: null };
      },

      checkpoint: async () => {
        this.guard();
        return this.slot;
      },

      preview: async (i): Promise<SolanaPreview> => {
        const base = { alreadyPaid: false, spent: false, paidBy: null, lineMemos: true, cost: null, historyError: null };
        if (this.down !== null) return { ...base, ok: false, error: this.down };
        const before = this.paid.get(i.runId);
        if (before !== undefined) return { ...base, ok: sameLines(before, i), error: sameLines(before, i) ? null : `run ${i.runId} was paid with other lines`, alreadyPaid: sameLines(before, i), spent: true, paidBy: before.signature };
        if (total(i) > this.allowance) return { ...base, ok: false, error: `exceeds delegated allowance: run needs ${total(i)}, ${this.allowance} remaining` };
        return { ...base, ok: true, error: null, cost: { newTokenAccounts: 0, rentLamports: 0n, markerLamports: 897_840n, feeLamports: 5_000n } };
      },

      pay: async (i): Promise<SolanaPayResult> => {
        this.payCalls.push(i);
        if (this.down !== null) return refuse(this.down);
        if (this.refuseWith !== null) return refuse(this.refuseWith);
        const before = this.paid.get(i.runId);
        if (before !== undefined) {
          if (!sameLines(before, i)) return refuse(`run ${i.runId} is already paid in ${before.signature} with other lines`);
          return { ok: true, tx: before.signature, error: null, outcome: 'paid', replayed: true, lineMemos: true, historyError: null };
        }
        if (total(i) > this.allowance) return refuse(`exceeds delegated allowance: run needs ${total(i)}, ${this.allowance} remaining`);
        const signature = this.signature();
        this.sent.push(signature);
        if (this.nextPay === 'unknown') {
          this.nextPay = 'pay';
          return { ok: false, tx: signature, error: 'the outcome of the payout is unknown: confirmation timed out', outcome: 'unknown', replayed: false, lineMemos: true, historyError: null };
        }
        if (this.nextPay === 'fail') {
          this.nextPay = 'pay';
          return { ok: false, tx: signature, error: 'the transaction failed on chain: custom program error 0x1', outcome: 'failed', replayed: false, lineMemos: true, historyError: null };
        }
        this.allowance -= total(i);
        this.slot += 10n;
        this.paid.set(i.runId, {
          runId: i.runId,
          signature,
          slot: this.slot,
          time: 1_800_000_000_000,
          total: total(i),
          transfers: i.lines.map((line) => ({ to: line.to, tokenAccount: `ata-of-${line.to}`, amount: line.amount, memo: line.memo === '' ? null : line.memo })),
        });
        return { ok: true, tx: signature, error: null, outcome: 'paid', replayed: false, lineMemos: true, historyError: null };
      },

      findRun: async (_account, runId) => {
        this.guard();
        return this.paid.get(runId) ?? null;
      },

      probeOverAllowance: async (i): Promise<SolanaRefusalProbe> => {
        this.probes.push(i);
        if (this.down !== null) return { signature: null, failedOnChain: false, error: this.down };
        const signature = this.signature();
        this.outcomes.set(signature, { failed: true, error: 'the Token program refused the transfer: insufficient delegated amount' });
        return { signature, failedOnChain: true, error: 'the Token program refused the transfer: insufficient delegated amount' };
      },
    };
  }

  async buildApproval(i: { owner: string; delegate: string; amount: bigint }) {
    this.guard();
    return {
      transaction: Buffer.from(`approve:${i.owner}:${i.delegate}:${i.amount}`).toString('base64'),
      summary: { owner: i.owner, tokenAccount: `ata-of-${i.owner}`, mint: this.mint, delegate: i.delegate, amount: (Number(i.amount) / 1e6).toString() },
      lastValidBlockHeight: 300_000_000n,
    };
  }

  async buildRevoke(i: { owner: string }) {
    this.guard();
    return {
      transaction: Buffer.from(`revoke:${i.owner}`).toString('base64'),
      summary: { owner: i.owner, tokenAccount: `ata-of-${i.owner}`, mint: this.mint },
      lastValidBlockHeight: 300_000_000n,
    };
  }

  async recorded(signature: string): Promise<{ failed: boolean; error: string | null } | null> {
    this.guard();
    return this.outcomes.get(signature) ?? null;
  }

  txUrl(signature: string): string {
    return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
  }
}

export const ATTESTOR_CONTRACT: Address = '0x00000000000000000000000000000000000a77e5';

type StoredSnapshot = Omit<HedgeSnapshot, 'series' | 'number'>;

/** A refusal written the way the real adapter writes one: the contract's error and its values. */
const contractRefusal = (error: string, ...values: unknown[]): ContractRefusal => ({ error, text: `${error}(${values.map(String).join(', ')})` });

/**
 * The HedgeAttestor contract as the application sees it, in memory. Accounts
 * name attesters, snapshots go into series under the contract's own rules,
 * and the position and prices a snapshot records are the ones the test has
 * set here, as the real contract records whatever HyperCore holds. Switches
 * cover the ways a node or a transaction can let its sender down.
 */
export class FakeAttestor implements AttestorPort {
  readonly chainId = 999;
  readonly contract = ATTESTOR_CONTRACT;
  readonly perp = { index: 214, szDecimals: 2 };
  everyMs = 60 * 60_000;

  /** What the contract reads from HyperCore when it records a snapshot. */
  szi = -5n;
  oraclePx = 12_233_000n;
  markPx = 12_231_500n;
  l1Block = 1_179_360_279n;

  /** When set, every call that reaches the node fails with this message. */
  down: string | null = null;
  /** When set, the node turns a transaction away with this message, and nothing is sent. */
  rejectSend: string | null = null;
  /** When set, what the contract answers to every attestation, whatever its own rules would say: a HyperCore read that fails, for one. */
  refuseWith: ContractRefusal | null = null;
  /** What becomes of a transaction that is sent: included at once, held back until `mine`, or never seen again. */
  inclusion: 'now' | 'held' | 'never' = 'now';
  /** Every transaction the node took, in order. */
  readonly sent: { hash: Hex; from: Address; call: AttestationCall }[] = [];
  /** Every attestation the contract was asked about without sending it. */
  readonly asked: AttestationCall[] = [];
  private readonly attesters = new Map<string, Address>();
  private readonly histories = new Map<string, StoredSnapshot[][]>();
  private readonly endedAt = new Map<string, bigint[]>();
  private readonly receipts = new Map<Hex, AttestationReceipt>();
  private readonly signed = new Map<Hex, { hash: Hex; from: Address; call: AttestationCall }>();
  private signatures = 0;
  private held: { hash: Hex; from: Address; call: AttestationCall }[] = [];

  constructor(private readonly now: () => number) {}

  private guard(): void {
    if (this.down !== null) throw new Error(this.down);
  }

  private timestamp(): bigint {
    return BigInt(Math.floor(this.now() / 1000));
  }

  /** Every series of an account, the last being the current one. An account that never attested has one empty series. */
  private seriesOf(user: Address): StoredSnapshot[][] {
    const key = user.toLowerCase();
    let history = this.histories.get(key);
    if (history === undefined) {
      history = [[]];
      this.histories.set(key, history);
    }
    return history;
  }

  private history(user: Address, series: bigint): StoredSnapshot[] {
    const history = this.seriesOf(user)[Number(series)];
    if (history === undefined) throw new Error(`the contract answered ${contractRefusal('UnknownSeries', user, series).text}`);
    return history;
  }

  /** The contract's own checks on an attestation, in the contract's order. */
  private refusal(from: Address, call: AttestationCall): ContractRefusal | null {
    if (this.refuseWith !== null) return this.refuseWith;
    const attester = this.attesters.get(call.user.toLowerCase());
    if (attester === undefined || !isAddressEqual(attester, from)) return contractRefusal('NotAttester', call.user, from);
    if ((call.journalCount === 0n) !== (call.journalRoot === ZERO_ROOT)) return contractRefusal('JournalRootCountMismatch', call.journalRoot, call.journalCount);
    const previous = this.seriesOf(call.user).at(-1)?.at(-1);
    if (previous !== undefined) {
      if (call.journalCount < previous.journalCount) return contractRefusal('JournalShrank', previous.journalCount, call.journalCount);
      if (call.journalCount === previous.journalCount && call.journalRoot !== previous.journalRoot) return contractRefusal('JournalRewritten', previous.journalRoot, call.journalRoot);
    }
    return null;
  }

  private include(tx: { hash: Hex; from: Address; call: AttestationCall }): void {
    const { call } = tx;
    if (this.refusal(tx.from, call) !== null) {
      this.receipts.set(tx.hash, { ok: false, recorded: null });
      return;
    }
    const all = this.seriesOf(call.user);
    const number = this.put(call.user, { journalCount: call.journalCount, journalRoot: call.journalRoot, treasuryCommitment: call.treasuryCommitment });
    const series = BigInt(all.length - 1);
    const stored = all[all.length - 1]?.[Number(number)] as StoredSnapshot;
    this.receipts.set(tx.hash, { ok: true, recorded: { user: call.user, snapshot: { series, number, ...stored } } });
  }

  /** `setAttester`, as the account itself would send it. */
  name(user: string, attester: string): void {
    this.attesters.set(user.toLowerCase(), attester as Address);
  }

  /** `startSeries`, as the account itself would send it. */
  startSeries(user: string): void {
    const all = this.seriesOf(user as Address);
    const ended = this.endedAt.get(user.toLowerCase()) ?? [];
    ended[all.length - 1] = this.timestamp();
    this.endedAt.set(user.toLowerCase(), ended);
    all.push([]);
  }

  /** Put a snapshot into the current series without asking the contract's rules, and say what number it got. */
  put(user: string, over: Partial<StoredSnapshot>): bigint {
    const current = this.seriesOf(user as Address).at(-1) as StoredSnapshot[];
    this.l1Block += 600n;
    current.push({
      perpIndex: this.perp.index,
      szi: this.szi,
      oraclePx: this.oraclePx,
      markPx: this.markPx,
      l1BlockNumber: this.l1Block,
      timestamp: this.timestamp(),
      journalCount: 0n,
      journalRoot: ZERO_ROOT,
      treasuryCommitment: ZERO_ROOT,
      ...over,
    });
    return BigInt(current.length - 1);
  }

  /** Include every transaction that was held back. */
  mine(): void {
    const waiting = this.held;
    this.held = [];
    for (const tx of waiting) this.include(tx);
  }

  /** The snapshots of an account's current series, oldest first. */
  snapshots(user: string): StoredSnapshot[] {
    return [...(this.seriesOf(user as Address).at(-1) ?? [])];
  }

  async attesterOf(user: Address): Promise<Address | null> {
    this.guard();
    return this.attesters.get(user.toLowerCase()) ?? null;
  }

  async series(user: Address, series: bigint | 'current'): Promise<SeriesState> {
    this.guard();
    const all = this.seriesOf(user);
    const current = BigInt(all.length - 1);
    const number = series === 'current' ? current : series;
    const snapshotCount = BigInt(this.history(user, number).length);
    const endedAt = number === current ? null : (this.endedAt.get(user.toLowerCase())?.[Number(number)] ?? null);
    return { series: number, snapshotCount, current: number === current, endedAt };
  }

  async snapshot(user: Address, series: bigint, number: bigint | 'latest'): Promise<HedgeSnapshot> {
    this.guard();
    const history = this.history(user, series);
    if (number === 'latest' && history.length === 0) throw new Error(`the contract answered ${contractRefusal('NoSnapshots', user, series).text}`);
    const at = number === 'latest' ? BigInt(history.length - 1) : number;
    const stored = history[Number(at)];
    if (stored === undefined) throw new Error(`the contract answered ${contractRefusal('UnknownSnapshot', user, series, at).text}`);
    return { series, number: at, ...stored };
  }

  async verifyEntry(user: Address, series: bigint, number: bigint, leaf: Hex, proof: readonly Hex[]): Promise<boolean> {
    const snapshot = await this.snapshot(user, series, number);
    return contractVerifies(snapshot.journalRoot, snapshot.journalCount, leaf, proof);
  }

  async refusalOf(attester: Address, call: AttestationCall): Promise<ContractRefusal | null> {
    this.guard();
    this.asked.push(call);
    return this.refusal(attester, call);
  }

  async sign(attesterPrivateKey: Hex, call: AttestationCall): Promise<{ hash: Hex; raw: Hex }> {
    this.guard();
    const raw = toHex(`attestation ${++this.signatures}`);
    const tx = { hash: keccak256(raw), from: privateKeyToAddress(attesterPrivateKey), call };
    this.signed.set(raw, tx);
    return { hash: tx.hash, raw };
  }

  async broadcast(raw: Hex): Promise<void> {
    this.guard();
    if (this.rejectSend !== null) throw new Error(`sending the attestation failed: ${this.rejectSend}`);
    const tx = this.signed.get(raw);
    if (tx === undefined) throw new Error('sending the attestation failed: the node could not decode the transaction');
    this.sent.push(tx);
    if (this.inclusion === 'now') this.include(tx);
    if (this.inclusion === 'held') this.held.push(tx);
  }

  /** Sign and send in one go, as an attester outside the application would: for snapshots a test needs on chain beforehand. */
  async send(attesterPrivateKey: Hex, call: AttestationCall): Promise<Hex> {
    const { hash, raw } = await this.sign(attesterPrivateKey, call);
    await this.broadcast(raw);
    return hash;
  }

  async receipt(hash: Hex): Promise<AttestationReceipt | null> {
    this.guard();
    return this.receipts.get(hash) ?? null;
  }
}
