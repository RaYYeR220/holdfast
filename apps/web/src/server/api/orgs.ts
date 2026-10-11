import { z } from 'zod';
import { orgId, ownerEndpoint, reply, sessionEndpoint } from '../http/endpoint';
import { createOrganisation, listOrganisations, readOrganisation, updateOrganisation } from '../orgs/service';

export const orgParams = z.strictObject({ orgId });

const name = z.string().trim().min(1).max(120);
const monthlyBurnUsd = z.number().min(0).max(1e12).nullable().optional();
/** Shape only; the service checks that each is an address of its chain. */
const account = z.string().min(1).max(64).nullable().optional();

/** GET /api/orgs: the organisations the signed-in address owns. */
export const getOrgs = sessionEndpoint({}, async ({ deps, session }) => ({ orgs: await listOrganisations(deps, session.address) }));

/**
 * POST /api/orgs { name, ufvk, birthday, monthlyBurnUsd?, tempoAccount?, solanaOwner? }:
 * registers an organisation owned by the signed-in address. The answer holds
 * the addresses of the service keys made for it and no key.
 */
export const postOrg = sessionEndpoint(
  {
    body: z.strictObject({
      name,
      ufvk: z.string().min(1).max(4_000),
      birthday: z.number().int().min(1).max(100_000_000),
      monthlyBurnUsd,
      tempoAccount: account,
      solanaOwner: account,
    }),
  },
  async ({ deps, session, body }) => reply(await createOrganisation(deps, session.address, body), { status: 201 }),
);

/** GET /api/orgs/[orgId] */
export const getOrg = ownerEndpoint({ params: orgParams }, async ({ deps, org }) => readOrganisation(deps, org.id));

/** PATCH /api/orgs/[orgId] { name?, monthlyBurnUsd?, tempoAccount?, solanaOwner? }: fields left out stay as they are; null clears. */
export const patchOrg = ownerEndpoint(
  { params: orgParams, body: z.strictObject({ name: name.optional(), monthlyBurnUsd, tempoAccount: account, solanaOwner: account }) },
  async ({ deps, org, body }) => updateOrganisation(deps, org.id, body),
);
