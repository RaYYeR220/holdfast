import { randomUUID } from 'node:crypto';
import { DEFAULT_POLICY, type Policy } from '@holdfast/core';
import type { KeyKind, NewServiceKey, OrgPatch, OrgRecord } from '@holdfast/db';
import { redactViewingKeys } from '@holdfast/zcash';
import { getAddress, isAddress } from 'viem';
import { type HoldfastNetwork, looksLikeSolanaAddress } from '../config';
import type { Deps } from '../deps';
import { invalid } from '../errors';

/** Sapling is the oldest pool a viewing key reads; no treasury can hold funds from before it activated. */
const FIRST_SHIELDED_BLOCK: Record<HoldfastNetwork, number> = { mainnet: 419_200, testnet: 280_000 };

/** The keys the service holds for an organisation. None of them can move the organisation's money on its own terms. */
const SERVICE_KEY_KINDS: readonly KeyKind[] = ['hl_agent', 'tempo_access', 'solana_delegate'];

export interface NewOrganisation {
  name: string;
  ufvk: string;
  birthday: number;
  monthlyBurnUsd?: number | null | undefined;
  tempoAccount?: string | null | undefined;
  solanaOwner?: string | null | undefined;
}

export interface OrganisationProfile {
  name?: string | undefined;
  monthlyBurnUsd?: number | null | undefined;
  tempoAccount?: string | null | undefined;
  solanaOwner?: string | null | undefined;
}

/** An organisation as its owner sees it. The viewing key and the secrets of the service keys are not part of it. */
export interface OrganisationView {
  id: string;
  name: string;
  createdAt: number;
  /** The Hyperliquid account of the organisation, which is the address that owns it. */
  owner: string;
  birthday: number;
  scannedTo: number | null;
  lockEnabled: boolean;
  policy: Policy;
  monthlyBurnUsd: number | null;
  publicDemo: boolean;
  tempoAccount: string | null;
  solanaOwner: string | null;
  /** The address of each key the service acts with. These are what the treasurer authorizes. */
  serviceKeys: { kind: KeyKind; address: string }[];
}

/** A Tempo account as the chain writes it. A mixed-case address has to carry a correct checksum. */
export function tempoAccountOf(text: string): string {
  if (!isAddress(text)) throw invalid('tempoAccount is not an account address');
  return getAddress(text);
}

export function solanaOwnerOf(text: string): string {
  if (!looksLikeSolanaAddress(text)) throw invalid('solanaOwner is not a Solana address');
  return text;
}

const optionalAccount = (value: string | null | undefined, read: (text: string) => string): string | null | undefined =>
  value === undefined || value === null ? value : read(value);

async function view(deps: Pick<Deps, 'store'>, org: OrgRecord): Promise<OrganisationView> {
  const keys = await deps.store.listKeys(org.id);
  return {
    id: org.id,
    name: org.name,
    createdAt: org.createdAt,
    owner: org.hlUser,
    birthday: org.birthday,
    scannedTo: org.scannedTo,
    lockEnabled: org.lockEnabled,
    policy: org.policy,
    monthlyBurnUsd: org.monthlyBurnUsd,
    publicDemo: org.publicDemo,
    tempoAccount: org.tempoAccount,
    solanaOwner: org.solanaOwner,
    serviceKeys: keys
      .filter((key) => key.status === 'active' && SERVICE_KEY_KINDS.includes(key.kind))
      .map((key) => ({ kind: key.kind, address: key.address }))
      .sort((a, b) => SERVICE_KEY_KINDS.indexOf(a.kind) - SERVICE_KEY_KINDS.indexOf(b.kind)),
  };
}

/**
 * Register an organisation for `owner`, the address that signed in. The
 * treasury is known only through its viewing key, which is checked to be one
 * and nothing more. The service makes its own keys for the organisation
 * here: a Hyperliquid agent, a Tempo access key and a Solana delegate. Until
 * the treasurer authorizes each of them on its chain they can do nothing, and
 * after that only what was authorized.
 */
export async function createOrganisation(deps: Pick<Deps, 'store' | 'zcash' | 'hyperliquid' | 'tempo' | 'solana'>, owner: string, input: NewOrganisation): Promise<OrganisationView> {
  const ufvk = input.ufvk.trim();
  const checked = deps.zcash.check(ufvk);
  if (!checked.ok) throw invalid(`the viewing key was not accepted: ${redactViewingKeys(checked.error, ufvk)}`);

  const earliest = FIRST_SHIELDED_BLOCK[deps.zcash.network];
  if (input.birthday < earliest) throw invalid(`the birthday height is before block ${earliest}, where shielded funds first became possible`);

  const agent = deps.hyperliquid.newAgentKey();
  const access = deps.tempo.newAccessKey();
  const delegate = await deps.solana.newDelegateKey();
  const serviceKeys: NewServiceKey[] = [
    { kind: 'hl_agent', address: agent.address, secret: agent.privateKey },
    { kind: 'tempo_access', address: access.address, secret: access.privateKey },
    { kind: 'solana_delegate', address: delegate.address, secret: delegate.secret },
  ];

  const id = randomUUID();
  await deps.store.createOrg(
    {
      id,
      name: input.name,
      ufvk,
      birthday: input.birthday,
      hlUser: owner.toLowerCase(),
      policy: DEFAULT_POLICY,
      // The lock is the treasurer's decision; nothing is hedged until it is switched on.
      lockEnabled: false,
      monthlyBurnUsd: input.monthlyBurnUsd ?? null,
      publicDemo: false,
      tempoAccount: optionalAccount(input.tempoAccount, tempoAccountOf) ?? null,
      solanaOwner: optionalAccount(input.solanaOwner, solanaOwnerOf) ?? null,
    },
    serviceKeys,
  );
  return readOrganisation(deps, id);
}

export async function readOrganisation(deps: Pick<Deps, 'store'>, orgId: string): Promise<OrganisationView> {
  const org = await deps.store.findOrg(orgId);
  if (org === null) throw new Error(`unknown organisation ${orgId}`);
  return view(deps, org);
}

/** The organisations an address owns, oldest first. */
export async function listOrganisations(deps: Pick<Deps, 'store'>, owner: string): Promise<{ id: string; name: string; createdAt: number; lockEnabled: boolean }[]> {
  const orgs = await deps.store.listOrgs({ owner });
  return orgs.map((org) => ({ id: org.id, name: org.name, createdAt: org.createdAt, lockEnabled: org.lockEnabled }));
}

/** Change the name, the burn figure or the payout accounts. Fields that are not given stay as they are. */
export async function updateOrganisation(deps: Pick<Deps, 'store'>, orgId: string, profile: OrganisationProfile): Promise<OrganisationView> {
  const patch: OrgPatch = {};
  if (profile.name !== undefined) patch.name = profile.name;
  if (profile.monthlyBurnUsd !== undefined) patch.monthlyBurnUsd = profile.monthlyBurnUsd;
  const tempoAccount = optionalAccount(profile.tempoAccount, tempoAccountOf);
  if (tempoAccount !== undefined) patch.tempoAccount = tempoAccount;
  const solanaOwner = optionalAccount(profile.solanaOwner, solanaOwnerOf);
  if (solanaOwner !== undefined) patch.solanaOwner = solanaOwner;
  await deps.store.updateOrg(orgId, patch);
  return readOrganisation(deps, orgId);
}
