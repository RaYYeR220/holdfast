import { z } from 'zod';
import { ownerEndpoint } from '../http/endpoint';
import { currentAdvisories, previewLock, replacePolicy, setLock } from '../policy/service';
import { orgParams } from './orgs';

/** GET /api/orgs/[orgId]/policy */
export const getPolicy = ownerEndpoint({ params: orgParams }, async ({ org }) => ({ policy: org.policy, lockEnabled: org.lockEnabled }));

/** PUT /api/orgs/[orgId]/policy <policy>: the whole policy, which has to pass validation as it stands. */
export const putPolicy = ownerEndpoint({ params: orgParams, body: z.record(z.string(), z.unknown()) }, async ({ deps, org, body }) => replacePolicy(deps, org, body));

/** PUT /api/orgs/[orgId]/lock { enabled } */
export const putLock = ownerEndpoint({ params: orgParams, body: z.strictObject({ enabled: z.boolean() }) }, async ({ deps, org, body }) => setLock(deps, org, body.enabled));

/** GET /api/orgs/[orgId]/lock/preview?swapCostBps= */
export const getLockPreview = ownerEndpoint(
  { params: orgParams, query: z.strictObject({ swapCostBps: z.coerce.number().int().min(0).max(1_000).optional() }) },
  async ({ deps, org, query }) => previewLock(deps, org, query.swapCostBps),
);

/** GET /api/orgs/[orgId]/advisories */
export const getAdvisories = ownerEndpoint({ params: orgParams }, async ({ deps, org }) => currentAdvisories(deps, org));
