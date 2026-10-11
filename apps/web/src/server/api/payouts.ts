import { z } from 'zod';
import { orgId, ownerEndpoint, reply } from '../http/endpoint';
import { createRun, executeRun, listRuns, previewRun, runStatus } from '../payouts/service';
import { orgParams } from './orgs';
import { baseUnits } from './rails';

const runParams = z.strictObject({ orgId, runId: z.string().regex(/^HF-\d{4}-\d{2}-\d{4}$/) });

/** Printable ASCII without a space at either end, so that what is stored is exactly what an explorer shows. */
const reference = z
  .string()
  .max(64)
  .regex(/^[\x20-\x7e]*$/)
  .refine((text) => text === text.trim(), 'must not start or end with a space')
  .default('');

const line = z.strictObject({
  payee: z.strictObject({ name: z.string().trim().min(1).max(120), address: z.string().min(1).max(64) }),
  amount: baseUnits,
  reference,
});

/** GET /api/orgs/[orgId]/payouts: the runs as the database has them, newest first. */
export const getPayouts = ownerEndpoint({ params: orgParams }, async ({ deps, org }) => ({ runs: await listRuns(deps, org.id) }));

/** POST /api/orgs/[orgId]/payouts { chain, lines: [{ payee: { name, address }, amount, reference? }] }: a draft run. */
export const postPayout = ownerEndpoint(
  { params: orgParams, body: z.strictObject({ chain: z.enum(['tempo', 'solana']), lines: z.array(line).min(1).max(64) }) },
  async ({ deps, org, body }) => reply(await createRun(deps, org, body), { status: 201 }),
);

/** GET /api/orgs/[orgId]/payouts/[runId]: the run beside what its chain shows now. */
export const getPayout = ownerEndpoint({ params: runParams }, async ({ deps, org, params }) => runStatus(deps, org, params.runId));

/** GET /api/orgs/[orgId]/payouts/[runId]/preview: what executing would do, without sending. */
export const getPayoutPreview = ownerEndpoint({ params: runParams }, async ({ deps, org, params }) => previewRun(deps, org, params.runId));

/** POST /api/orgs/[orgId]/payouts/[runId]/execute: pays the run through its rail. Safe to repeat. */
export const postPayoutExecute = ownerEndpoint({ params: runParams }, async ({ deps, org, params }) => executeRun(deps, org, params.runId));
