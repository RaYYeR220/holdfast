import type { KeyKind, OrgRecord, ServiceKeyStatus } from '@holdfast/db';
import type { HoldfastNetwork } from '../config';
import type { Deps } from '../deps';
import { type Reading, reading } from '../reading';

/**
 * What the Settings page shows of an organisation: its profile, the accounts
 * it is tied to, and every key the service has made for it. Addresses and
 * dates only; the viewing key appears as the address it receives on, and the
 * secret half of a service key is never read here.
 */

/** Where the treasury address comes from: it is derived from the stored key, not read from a chain. */
export const VIEWING_KEY = 'viewing key';

/**
 * The unified address the treasury's viewing key receives on. The key is
 * decrypted to derive it and goes no further: the answer holds the address
 * alone, and a failure names no part of the key.
 */
export async function treasuryAddress(deps: Pick<Deps, 'store' | 'zcash' | 'now' | 'redact'>, org: Pick<OrgRecord, 'id'>): Promise<Reading<{ address: string }>> {
  return reading(VIEWING_KEY, deps, async () => {
    const { ufvk } = await deps.store.loadOrg(org.id);
    const checked = deps.zcash.check(ufvk);
    if (!checked.ok) throw new Error('the stored viewing key no longer passes its check, so the treasury address cannot be derived');
    return { address: checked.address };
  });
}

export interface SettingsKey {
  kind: KeyKind;
  address: string;
  status: ServiceKeyStatus;
  /** When the service made the key. */
  createdAt: number;
  revokedAt: number | null;
}

export interface SettingsFacts {
  id: string;
  name: string;
  createdAt: number;
  monthlyBurnUsd: number | null;
  publicDemo: boolean;
  /** Which Zcash chain the treasury is on and which Hyperliquid the hedge is on. */
  network: HoldfastNetwork;
  /** The networks the two payout rails of this deployment are on; null for one whose settings cannot be used. */
  rails: { tempo: string | null; solana: string | null };
  /** The organisation's Hyperliquid account, which is the address that owns it. */
  owner: string;
  treasury: Reading<{ address: string }>;
  /** The first block that can hold treasury funds, and the last one the scan has covered. */
  birthday: number;
  scannedTo: number | null;
  tempoAccount: string | null;
  solanaOwner: string | null;
  /** Every key the service has made for the organisation, newest first; replaced ones are marked revoked. */
  keys: SettingsKey[];
}

/** A setting of the deployment, or null when it is missing or malformed: the page then leaves it unnamed. */
function configured<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

export async function settingsFacts(deps: Pick<Deps, 'store' | 'zcash' | 'tempo' | 'solana' | 'network' | 'now' | 'redact'>, org: OrgRecord): Promise<SettingsFacts> {
  const [keys, treasury] = await Promise.all([deps.store.listKeys(org.id), treasuryAddress(deps, org)]);
  return {
    id: org.id,
    name: org.name,
    createdAt: org.createdAt,
    monthlyBurnUsd: org.monthlyBurnUsd,
    publicDemo: org.publicDemo,
    network: deps.network,
    rails: { tempo: configured(() => deps.tempo.network), solana: configured(() => deps.solana.cluster) },
    owner: org.hlUser,
    treasury,
    birthday: org.birthday,
    scannedTo: org.scannedTo,
    tempoAccount: org.tempoAccount,
    solanaOwner: org.solanaOwner,
    keys: keys.map((key) => ({ kind: key.kind, address: key.address, status: key.status, createdAt: key.createdAt, revokedAt: key.revokedAt })),
  };
}
