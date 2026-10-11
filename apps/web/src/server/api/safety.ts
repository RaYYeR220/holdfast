import { z } from 'zod';
import { ownerEndpoint } from '../http/endpoint';
import { PROBE_KINDS, listRefusals, runProbe, safetyOf } from '../safety/service';
import { orgParams } from './orgs';

/** GET /api/orgs/[orgId]/safety: each key's scope as its chain reports it now, and the refusals on record. */
export const getSafety = ownerEndpoint({ params: orgParams }, async ({ deps, org }) => safetyOf(deps, org));

/** GET /api/orgs/[orgId]/safety/refusals */
export const getRefusals = ownerEndpoint({ params: orgParams }, async ({ deps, org }) => ({ refusals: await listRefusals(deps, org.id) }));

/**
 * POST /api/orgs/[orgId]/safety/probes { kind }: sends something the key's
 * chain or venue must refuse and records the refusal. There is no field for a
 * destination: a probe only ever names the organisation's own accounts.
 */
export const postProbe = ownerEndpoint({ params: orgParams, body: z.strictObject({ kind: z.enum(PROBE_KINDS) }) }, async ({ deps, org, body }) => runProbe(deps, org, body.kind));
