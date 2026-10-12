/**
 * NEAR Intents 1Click: the swap rail every ZEC movement uses. A quote returns
 * a one-time deposit address; whoever sends the origin asset there gets the
 * destination asset delivered to the recipient named in the quote. Holdfast
 * only asks for quotes and watches them settle — the treasurer's wallet sends
 * the deposit, and the recipient is always an account the treasurer owns.
 */

export const ONECLICK_URL = 'https://1click.chaindefuser.com';

export const ASSETS = {
  /** Native ZEC; deposits and withdrawals are transparent-address only. */
  ZEC: 'nep141:zec.omft.near',
  /** USDC credited straight to a Hyperliquid account. */
  USDC_HYPERCORE: '1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054',
  USDC_SOLANA: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
  USDC_BASE: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
  USDC_ARBITRUM: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
} as const;

export type AssetId = (typeof ASSETS)[keyof typeof ASSETS];

export interface QuoteRequest {
  originAsset: AssetId;
  destinationAsset: AssetId;
  /** Exact amount sent, in the origin asset's base units. */
  amount: bigint;
  /** Where the destination asset is delivered. */
  recipient: string;
  /** Where the origin asset returns if the swap cannot complete. */
  refundTo: string;
  slippageBps: number;
  /** How long the deposit address stays valid. */
  validForMs: number;
  /** A dry quote prices the swap without creating a deposit address. */
  dry: boolean;
}

export interface Quote {
  /** Null for a dry quote. */
  depositAddress: string | null;
  amountIn: bigint;
  amountOut: bigint;
  /** The least the recipient can receive after slippage. */
  minAmountOut: bigint;
  amountInUsd: number;
  amountOutUsd: number;
  /** Everything lost between the two legs, in bps of the input value. */
  costBps: number;
  etaSeconds: number;
  /** After this moment a deposit is refunded instead of swapped. */
  deadline: number;
  /** The service's signature over the quote, kept as evidence. */
  signature: string;
}

export type SwapState = 'PENDING_DEPOSIT' | 'PROCESSING' | 'SUCCESS' | 'INCOMPLETE_DEPOSIT' | 'REFUNDED' | 'FAILED' | 'UNKNOWN';

/**
 * The quote a swap was made on, as the service repeats it when it is asked
 * where the swap stands: what was asked for, and what was promised.
 */
export interface QuotedSwap {
  originAsset: string;
  destinationAsset: string;
  /** Where the destination asset is delivered. */
  recipient: string;
  /** Where the origin asset returns if the swap cannot complete; null when the service names no address. */
  refundTo: string | null;
  depositAddress: string;
  amountIn: bigint;
  amountOut: bigint;
  /** The least the recipient can receive after slippage. */
  minAmountOut: bigint;
  /** When the quote was made, ms. */
  quotedAt: number;
  /** After this moment a deposit is refunded instead of swapped; null when the service states none. */
  deadline: number | null;
  /** The service's signature over the quote. */
  signature: string;
}

export interface SwapStatus {
  state: SwapState;
  /** True once the swap can no longer change state. */
  final: boolean;
  amountIn: bigint | null;
  amountOut: bigint | null;
  originTxs: string[];
  destinationTxs: string[];
  updatedAt: number | null;
  /** Null when the answer repeats no quote, or one that cannot be read in full. */
  quoted: QuotedSwap | null;
}

export class OneClickError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'OneClickError';
  }
}

export interface OneClickConfig {
  baseUrl?: string;
  /** Optional partner key; lowers the service fee. */
  apiKey?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

const FINAL: SwapState[] = ['SUCCESS', 'REFUNDED', 'FAILED'];
const STATES: SwapState[] = ['PENDING_DEPOSIT', 'PROCESSING', 'SUCCESS', 'INCOMPLETE_DEPOSIT', 'REFUNDED', 'FAILED'];

function asBigInt(v: unknown, what: string): bigint {
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  throw new OneClickError(`1Click returned no usable ${what}`, null);
}

function asNumber(v: unknown, what: string): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n === 'number' && Number.isFinite(n)) return n;
  throw new OneClickError(`1Click returned no usable ${what}`, null);
}

function optionalBigInt(v: unknown): bigint | null {
  return typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : null;
}

function txHashes(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((t) => (typeof t?.hash === 'string' ? [t.hash] : []));
}

const record = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const moment = (v: unknown): number | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : null);

/**
 * The quote inside a status answer. Every part that says what the swap was
 * has to be there, or none of it is taken: half a quote would say less than
 * it seems to.
 */
function quotedSwap(v: unknown): QuotedSwap | null {
  const response = record(v);
  const request = record(response?.quoteRequest);
  const quote = record(response?.quote);
  if (response === null || request === null || quote === null) return null;

  const originAsset = text(request.originAsset);
  const destinationAsset = text(request.destinationAsset);
  const recipient = text(request.recipient);
  const depositAddress = text(quote.depositAddress);
  const amountIn = optionalBigInt(quote.amountIn);
  const amountOut = optionalBigInt(quote.amountOut);
  const minAmountOut = optionalBigInt(quote.minAmountOut);
  const quotedAt = moment(response.timestamp);
  if (originAsset === null || destinationAsset === null || recipient === null || depositAddress === null) return null;
  if (amountIn === null || amountOut === null || minAmountOut === null || quotedAt === null) return null;
  return {
    originAsset,
    destinationAsset,
    recipient,
    refundTo: text(request.refundTo),
    depositAddress,
    amountIn,
    amountOut,
    minAmountOut,
    quotedAt,
    deadline: moment(quote.deadline),
    signature: text(response.signature) ?? '',
  };
}

export function createOneClick(config: OneClickConfig = {}) {
  const baseUrl = config.baseUrl ?? ONECLICK_URL;
  const doFetch = config.fetch ?? fetch;
  const now = config.now ?? Date.now;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.apiKey !== undefined) headers.authorization = `Bearer ${config.apiKey}`;

  async function call(path: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, { ...init, headers });
    } catch (e) {
      throw new OneClickError(`1Click is unreachable: ${e instanceof Error ? e.message : String(e)}`, null);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new OneClickError(`1Click answered ${res.status} with a body that is not JSON`, res.status);
    }
    return { status: res.status, body };
  }

  return {
    async quote(req: QuoteRequest): Promise<Quote> {
      if (req.amount <= 0n) throw new RangeError('quote amount must be positive');
      if (!Number.isInteger(req.slippageBps) || req.slippageBps < 0 || req.slippageBps > 1_000) {
        throw new RangeError('slippage must be between 0 and 1000 bps');
      }
      const deadline = now() + req.validForMs;
      const { status, body } = await call('/v0/quote', {
        method: 'POST',
        body: JSON.stringify({
          dry: req.dry,
          swapType: 'EXACT_INPUT',
          slippageTolerance: req.slippageBps,
          originAsset: req.originAsset,
          depositType: 'ORIGIN_CHAIN',
          destinationAsset: req.destinationAsset,
          amount: req.amount.toString(),
          refundTo: req.refundTo,
          refundType: 'ORIGIN_CHAIN',
          recipient: req.recipient,
          recipientType: 'DESTINATION_CHAIN',
          deadline: new Date(deadline).toISOString(),
        }),
      });
      const b = body as { message?: unknown; quote?: Record<string, unknown>; signature?: unknown };
      if (status !== 200 && status !== 201) {
        throw new OneClickError(typeof b?.message === 'string' ? b.message : `1Click answered ${status}`, status);
      }
      const q = b.quote;
      if (typeof q !== 'object' || q === null) throw new OneClickError('1Click returned no quote', status);

      const depositAddress = typeof q.depositAddress === 'string' && q.depositAddress !== '' ? q.depositAddress : null;
      if (!req.dry && depositAddress === null) throw new OneClickError('1Click returned a quote without a deposit address', status);

      const amountIn = asBigInt(q.amountIn, 'input amount');
      if (amountIn !== req.amount) throw new OneClickError('1Click quoted a different input amount than requested', status);
      const amountInUsd = asNumber(q.amountInUsd, 'input value');
      const amountOutUsd = asNumber(q.amountOutUsd, 'output value');

      return {
        depositAddress,
        amountIn,
        amountOut: asBigInt(q.amountOut, 'output amount'),
        minAmountOut: asBigInt(q.minAmountOut, 'minimum output'),
        amountInUsd,
        amountOutUsd,
        costBps: amountInUsd > 0 ? Math.round(((amountInUsd - amountOutUsd) / amountInUsd) * 10_000) : 0,
        etaSeconds: asNumber(q.timeEstimate, 'time estimate'),
        deadline: typeof q.deadline === 'string' && !Number.isNaN(Date.parse(q.deadline)) ? Date.parse(q.deadline) : deadline,
        signature: typeof b.signature === 'string' ? b.signature : '',
      };
    },

    /** Tell the service a deposit was sent; purely a speed-up, never required. */
    async announceDeposit(depositAddress: string, txHash: string): Promise<void> {
      await call('/v0/deposit/submit', { method: 'POST', body: JSON.stringify({ depositAddress, txHash }) });
    },

    async status(depositAddress: string): Promise<SwapStatus> {
      const { status, body } = await call(`/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`, { method: 'GET' });
      const b = body as { status?: unknown; updatedAt?: unknown; swapDetails?: Record<string, unknown>; quoteResponse?: unknown; message?: unknown };
      if (status === 404) {
        throw new OneClickError(typeof b?.message === 'string' ? b.message : 'unknown deposit address', 404);
      }
      if (status !== 200) throw new OneClickError(typeof b?.message === 'string' ? b.message : `1Click answered ${status}`, status);

      const state = STATES.includes(b.status as SwapState) ? (b.status as SwapState) : 'UNKNOWN';
      const d = b.swapDetails ?? {};
      const updatedAt = typeof b.updatedAt === 'string' ? Date.parse(b.updatedAt) : Number.NaN;
      return {
        state,
        final: FINAL.includes(state),
        amountIn: optionalBigInt(d.amountIn),
        amountOut: optionalBigInt(d.amountOut),
        originTxs: txHashes(d.originChainTxHashes),
        destinationTxs: txHashes(d.destinationChainTxHashes),
        updatedAt: Number.isNaN(updatedAt) ? null : updatedAt,
        quoted: quotedSwap(b.quoteResponse),
      };
    },
  };
}

export type OneClick = ReturnType<typeof createOneClick>;
