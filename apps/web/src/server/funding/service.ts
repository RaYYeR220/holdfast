import { isSwapFinal } from '@holdfast/books';
import type { OrgRecord, SwapPurpose, SwapRow } from '@holdfast/db';
import { ASSETS, type AssetId, type Quote } from '@holdfast/intents';
import { addressKind, buildPaymentUri } from '@holdfast/zcash';
import { SOLANA_USDC } from '../config';
import type { Deps } from '../deps';
import { ApiError, invalid, notFound, refused, unavailable } from '../errors';
import { messageOf } from '../redact';

/** How long a deposit address waits for its ZEC. A deposit that arrives later is sent back, not swapped. */
export const QUOTE_VALID_FOR_MS = 60 * 60_000;
export const DEFAULT_SLIPPAGE_BPS = 100;
export const MAX_SLIPPAGE_BPS = 500;

const SWAP_SERVICE = '1Click';

/** Where a swap may deliver: only ever an account of the organisation itself. */
export type FundingPurpose = Extract<SwapPurpose, 'margin' | 'payout_float'>;

export interface FundingRequest {
  purpose: FundingPurpose;
  amountZat: bigint;
  /** A transparent address of the treasurer's, where the ZEC returns if the swap cannot complete. */
  refundTo: string;
  slippageBps: number;
  /** Price the swap without creating a deposit address or recording anything. */
  dry: boolean;
}

export interface FundingQuote {
  /** Null for a dry quote, which is not recorded. */
  swapId: string | null;
  purpose: FundingPurpose;
  recipient: string;
  originAsset: string;
  destinationAsset: string;
  amountIn: bigint;
  amountOut: bigint;
  /** The least the recipient can receive after slippage. */
  minAmountOut: bigint;
  amountInUsd: number;
  amountOutUsd: number;
  costBps: number;
  etaSeconds: number;
  deadline: number;
  depositAddress: string | null;
  /** A ZIP-321 request for the deposit, for the treasurer's own wallet to pay. */
  paymentUri: string | null;
}

export interface SwapView extends SwapRow {
  /** True once the swap can no longer change state. */
  final: boolean;
}

export type SwapRefresh =
  | { swapId: string; orgId: string; status: 'ok'; state: string; final: boolean }
  | { swapId: string; orgId: string; status: 'unavailable'; reason: string };

/** What a purpose is funded in and where it is delivered: the asset, and the organisation's own account for it. */
export function fundingDestination(deps: Pick<Deps, 'solana'>, org: Pick<OrgRecord, 'hlUser' | 'solanaOwner'>, purpose: FundingPurpose): { asset: AssetId; recipient: string } {
  if (purpose === 'margin') return { asset: ASSETS.USDC_HYPERCORE, recipient: org.hlUser };
  if (deps.solana.cluster !== 'mainnet-beta' || deps.solana.mint !== SOLANA_USDC['mainnet-beta']) {
    throw refused('the swap service delivers USDC on Solana mainnet, and this deployment pays out in another token or on another cluster');
  }
  if (org.solanaOwner === null) throw refused('the organisation has no Solana wallet yet; set one in its profile first');
  return { asset: ASSETS.USDC_SOLANA, recipient: org.solanaOwner };
}

/**
 * Quote ZEC into dollars for one of the organisation's own accounts: margin
 * on its Hyperliquid account, or float on its Solana wallet. The service
 * moves nothing: it returns a one-time deposit address as a payment request
 * for the treasurer's wallet, and records the swap so that it can be followed.
 */
export async function quoteFunding(deps: Pick<Deps, 'store' | 'oneClick' | 'solana' | 'network' | 'redact'>, org: OrgRecord, request: FundingRequest): Promise<FundingQuote> {
  if (deps.network !== 'mainnet') throw refused('ZEC is swapped on mainnet only, and this deployment runs on testnet');
  if (addressKind(request.refundTo) !== 'transparent') {
    throw invalid('refundTo must be a transparent Zcash address: the swap service returns ZEC to transparent addresses only');
  }
  const { asset, recipient } = fundingDestination(deps, org, request.purpose);

  let quote: Quote;
  try {
    quote = await deps.oneClick.quote({
      originAsset: ASSETS.ZEC,
      destinationAsset: asset,
      amount: request.amountZat,
      recipient,
      refundTo: request.refundTo,
      slippageBps: request.slippageBps,
      validForMs: QUOTE_VALID_FOR_MS,
      dry: request.dry,
    });
  } catch (error) {
    throw unavailable(SWAP_SERVICE, deps.redact(messageOf(error)));
  }

  const priced = {
    purpose: request.purpose,
    recipient,
    originAsset: ASSETS.ZEC,
    destinationAsset: asset,
    amountIn: quote.amountIn,
    amountOut: quote.amountOut,
    minAmountOut: quote.minAmountOut,
    amountInUsd: quote.amountInUsd,
    amountOutUsd: quote.amountOutUsd,
    costBps: quote.costBps,
    etaSeconds: quote.etaSeconds,
    deadline: quote.deadline,
  };
  if (request.dry) return { ...priced, swapId: null, depositAddress: null, paymentUri: null };

  const { depositAddress } = quote;
  let paymentUri: string;
  try {
    if (depositAddress === null) throw new RangeError('no deposit address');
    paymentUri = buildPaymentUri([{ address: depositAddress, amountZat: quote.amountIn }]);
  } catch {
    // Nothing is recorded and nothing is handed to the treasurer to pay.
    throw unavailable(SWAP_SERVICE, 'it returned a quote without a usable Zcash deposit address');
  }

  const swap = await deps.store.recordSwap(org.id, {
    purpose: request.purpose,
    originAsset: ASSETS.ZEC,
    destinationAsset: asset,
    amountIn: quote.amountIn,
    minAmountOut: quote.minAmountOut,
    depositAddress,
    recipient,
    quote,
    state: 'PENDING_DEPOSIT',
  });
  return { ...priced, swapId: swap.id, depositAddress, paymentUri };
}

const viewOf = (swap: SwapRow): SwapView => ({ ...swap, final: isSwapFinal(swap) });

/** The organisation's swaps as the database has them, newest first. */
export async function listSwaps(deps: Pick<Deps, 'store'>, orgId: string): Promise<SwapView[]> {
  return (await deps.store.listSwaps(orgId)).map(viewOf);
}

/** Ask the swap service where a swap stands and write the answer down. Throws when it gives none that can be used. */
async function ask(deps: Pick<Deps, 'store' | 'oneClick'>, swap: SwapRow): Promise<SwapRow> {
  const status = await deps.oneClick.status(swap.depositAddress);
  if (status.state === 'UNKNOWN') throw new Error('it reports a state this service does not know');
  const updated = await deps.store.updateSwap(swap.orgId, swap.id, {
    state: status.state,
    originTxs: status.originTxs,
    destinationTxs: status.destinationTxs,
    amountOut: status.amountOut,
  });
  if (updated === null) throw new Error('the swap is no longer in the database');
  return updated;
}

/** Refresh one swap for the scheduler. A failure is part of the answer, never an exception. */
export async function refreshSwap(deps: Pick<Deps, 'store' | 'oneClick' | 'redact'>, swap: SwapRow): Promise<SwapRefresh> {
  try {
    const updated = await ask(deps, swap);
    return { swapId: swap.id, orgId: swap.orgId, status: 'ok', state: updated.state, final: isSwapFinal(updated) };
  } catch (error) {
    return { swapId: swap.id, orgId: swap.orgId, status: 'unavailable', reason: deps.redact(messageOf(error)) };
  }
}

/**
 * Where a swap stands, asked of the swap service now and recorded. A swap
 * that has settled cannot change and is answered from the record. When the
 * service cannot be asked the answer is "unavailable"; what the record last
 * held is given beside it, labelled as that.
 */
export async function swapStatus(deps: Pick<Deps, 'store' | 'oneClick' | 'redact'>, orgId: string, swapId: string): Promise<SwapView> {
  const swap = await deps.store.findSwap(orgId, swapId);
  if (swap === null) throw notFound();
  if (isSwapFinal(swap)) return viewOf(swap);
  try {
    return viewOf(await ask(deps, swap));
  } catch (error) {
    throw new ApiError(503, 'unavailable', `${SWAP_SERVICE} is unavailable: ${deps.redact(messageOf(error))}`, {
      source: SWAP_SERVICE,
      lastRecorded: { state: swap.state, updatedAt: swap.updatedAt },
    });
  }
}
