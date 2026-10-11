import { z } from 'zod';
import { DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS, listSwaps, quoteFunding, swapStatus } from '../funding/service';
import { orgId, ownerEndpoint, reply } from '../http/endpoint';
import { orgParams } from './orgs';

/** Zatoshi as a decimal string; the whole ZEC supply has sixteen digits. */
const zatoshi = z
  .string()
  .regex(/^[1-9]\d{0,16}$/)
  .transform((digits) => BigInt(digits));

/**
 * POST /api/orgs/[orgId]/funding/quotes { purpose, amountZat, refundTo, slippageBps?, dry? }:
 * quotes ZEC into dollars for the organisation's own Hyperliquid account
 * ("margin") or its own Solana wallet ("payout_float"). There is no field for
 * a recipient: it is always the organisation's.
 */
export const postQuote = ownerEndpoint(
  {
    params: orgParams,
    body: z.strictObject({
      purpose: z.enum(['margin', 'payout_float']),
      amountZat: zatoshi,
      refundTo: z.string().min(1).max(128),
      slippageBps: z.number().int().min(0).max(MAX_SLIPPAGE_BPS).default(DEFAULT_SLIPPAGE_BPS),
      dry: z.boolean().default(false),
    }),
  },
  async ({ deps, org, body }) => reply(await quoteFunding(deps, org, body), { status: body.dry ? 200 : 201 }),
);

/** GET /api/orgs/[orgId]/funding/swaps: the swaps as the database has them, newest first. */
export const getSwaps = ownerEndpoint({ params: orgParams }, async ({ deps, org }) => ({ swaps: await listSwaps(deps, org.id) }));

/** GET /api/orgs/[orgId]/funding/swaps/[swapId]: asks the swap service where the swap stands and records the answer. */
export const getSwap = ownerEndpoint({ params: z.strictObject({ orgId, swapId: z.uuid() }) }, async ({ deps, org, params }) => swapStatus(deps, org.id, params.swapId));
