import type { OrderRequest, PayoutAllowance, ReferencePrice } from '@holdfast/core';
import type { Fill, FundingPayment, HyperliquidState, HyperliquidVenue, PlaceResult } from '@holdfast/hyperliquid';
import type { SolanaPayResult, SolanaPort, SolanaPreview, SolanaRail, SolanaRefusalProbe, SolanaRunInput, SolanaRunOnChain } from '../../src/server/deps';

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
