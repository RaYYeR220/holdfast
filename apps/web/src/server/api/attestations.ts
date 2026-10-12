import { z } from 'zod';
import { attestorOf, openCommitment, ownerAttestations } from '../attestations/service';
import { orgId, ownerEndpoint } from '../http/endpoint';
import { orgParams } from './orgs';

/** A series or a snapshot number as a path writes it: decimal digits. The contract counts both from zero. */
const counter = z
  .string()
  .regex(/^(0|[1-9]\d{0,19})$/)
  .transform((digits) => BigInt(digits));

/** One snapshot of one organisation: `[orgId]/attestations/[series]/[number]`. */
export const snapshotParams = z.strictObject({ orgId, series: counter, number: counter });

/**
 * GET /api/orgs/[orgId]/attestor: the organisation's attester key, the
 * contract, the calls `setAttester` and `startSeries` as `{ to, data, chainId }`
 * for the owner's wallet to send from the organisation's account, and whether
 * the chain shows the key registered now.
 */
export const getAttestor = ownerEndpoint({ params: orgParams }, async ({ deps, org }) => attestorOf(deps, org));

/**
 * GET /api/orgs/[orgId]/attestations: the latest snapshots as the chain holds
 * them, what the service sent or tried with how each attempt ended, and
 * whether attesting has stopped for want of a new series.
 */
export const getAttestations = ownerEndpoint({ params: orgParams }, async ({ deps, org }) => ownerAttestations(deps, org));

/**
 * POST /api/orgs/[orgId]/attestations/[series]/[number]/open: the balance and
 * the salt behind the treasury commitment of one snapshot. Disclosing them is
 * the organisation's decision, so only its owner is answered.
 */
export const postOpenAttestation = ownerEndpoint({ params: snapshotParams }, async ({ deps, org, params }) => openCommitment(deps, org, params.series, params.number));
