import { z } from 'zod';
import { ownerEndpoint } from '../http/endpoint';
import { approvalRequest, submitApproval, venueState } from '../hyperliquid/service';
import { orgParams } from './orgs';

const chainId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** GET /api/orgs/[orgId]/hyperliquid/approval?chainId=&validUntil=: the typed data that approves the organisation's agent. */
export const getApproval = ownerEndpoint(
  { params: orgParams, query: z.strictObject({ chainId: z.coerce.number().pipe(chainId).optional(), validUntil: z.coerce.number().pipe(timestamp).optional() }) },
  async ({ deps, org, query }) => approvalRequest(deps, org, { signatureChainId: query.chainId, validUntil: query.validUntil }),
);

/** POST /api/orgs/[orgId]/hyperliquid/approval { nonce, signature, signatureChainId?, validUntil? }: submits the owner's signature. */
export const postApproval = ownerEndpoint(
  {
    params: orgParams,
    body: z.strictObject({
      nonce: timestamp,
      signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
      signatureChainId: chainId.optional(),
      validUntil: timestamp.optional(),
    }),
  },
  async ({ deps, org, body }) => submitApproval(deps, org, body),
);

/** GET /api/orgs/[orgId]/hyperliquid/state: the account on the venue, read now. */
export const getVenueState = ownerEndpoint({ params: orgParams }, async ({ deps, org }) => venueState(deps, org));
