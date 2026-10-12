import { z } from 'zod';
import { ownerEndpoint } from '../http/endpoint';
import { replaceTempoAccessKey, solanaApproval, solanaRail, solanaRevoke, submitTempoAuthorization, submitTempoRevoke, tempoAuthorizationRequest, tempoRail, tempoRevokeRequest } from '../rails/service';
import { orgParams } from './orgs';

/** An amount in token base units, written as a decimal string: a JSON number cannot carry one exactly. */
export const baseUnits = z
  .string()
  .regex(/^[1-9]\d{0,38}$/)
  .transform((digits) => BigInt(digits));

const TEN_YEARS_SECONDS = 10 * 365 * 86_400;

const terms = z.strictObject({
  limit: baseUnits,
  periodSeconds: z.number().int().min(0).max(TEN_YEARS_SECONDS),
  expiry: z.number().int().positive(),
  recipients: z.array(z.string().min(1).max(64)).max(25).optional(),
});

/** GET /api/orgs/[orgId]/rails/tempo: the rail, and the access key as the chain has it now. */
export const getTempoRail = ownerEndpoint({ params: orgParams }, async ({ deps, org }) => tempoRail(deps, org));

/** POST /api/orgs/[orgId]/rails/tempo/authorization { limit, periodSeconds, expiry, recipients? }: what the root signs. Changes nothing. */
export const postTempoAuthorization = ownerEndpoint({ params: orgParams, body: terms }, async ({ deps, org, body }) => tempoAuthorizationRequest(deps, org, body));

/** POST /api/orgs/[orgId]/rails/tempo/authorization/submit { terms, signature | signedWire } */
export const postTempoAuthorizationSubmit = ownerEndpoint(
  {
    params: orgParams,
    body: z.strictObject({
      terms,
      signature: z.string().regex(/^0x[0-9a-fA-F]+$/).max(4_000).optional(),
      signedWire: z.string().regex(/^0x[0-9a-fA-F]+$/).max(8_000).optional(),
    }),
  },
  async ({ deps, org, body }) => submitTempoAuthorization(deps, org, body),
);

/**
 * POST /api/orgs/[orgId]/rails/tempo/revoke: what the root signs to take the
 * access key back, read from the chain now. The service's sponsor pays the
 * fee. Changes nothing.
 */
export const postTempoRevoke = ownerEndpoint({ params: orgParams }, async ({ deps, org }) => tempoRevokeRequest(deps, org));

/**
 * POST /api/orgs/[orgId]/rails/tempo/revoke/submit { signedTransaction }:
 * sends the revocation the root signed, and nothing that is anything else.
 */
export const postTempoRevokeSubmit = ownerEndpoint(
  { params: orgParams, body: z.strictObject({ signedTransaction: z.string().regex(/^0x[0-9a-fA-F]+$/).max(8_000) }) },
  async ({ deps, org, body }) => submitTempoRevoke(deps, org, body),
);

/**
 * POST /api/orgs/[orgId]/rails/tempo/key: a new access key in the place of
 * one the chain shows as revoked or expired. Answers as GET rails/tempo does,
 * for the new key. A key that can still sign, or was never authorized, is not
 * replaced.
 */
export const postTempoKey = ownerEndpoint({ params: orgParams }, async ({ deps, org }) => replaceTempoAccessKey(deps, org));

/** GET /api/orgs/[orgId]/rails/solana: the rail, and the delegate's allowance as the chain has it now. */
export const getSolanaRail = ownerEndpoint({ params: orgParams }, async ({ deps, org }) => solanaRail(deps, org));

/** POST /api/orgs/[orgId]/rails/solana/approval { amount }: the unsigned approval for the owner's wallet. Changes nothing. */
export const postSolanaApproval = ownerEndpoint({ params: orgParams, body: z.strictObject({ amount: baseUnits }) }, async ({ deps, org, body }) => solanaApproval(deps, org, body.amount));

/** POST /api/orgs/[orgId]/rails/solana/revoke: the unsigned revocation for the owner's wallet. Changes nothing. */
export const postSolanaRevoke = ownerEndpoint({ params: orgParams }, async ({ deps, org }) => solanaRevoke(deps, org));
