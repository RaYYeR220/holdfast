import type { OrgRecord } from '@holdfast/db';
import type { KeyStatus } from '@holdfast/tempo';
import type { Deps } from '../deps';
import { solanaAccess, tempoAccess } from '../rails/access';
import { type Reading, available, missing, reading } from '../reading';

export type KeyKindShown = 'zcash_viewing_key' | 'hl_agent' | 'tempo_access' | 'solana_delegate';

/** One key the service holds for an organisation: what it is, what bounds it, and who enforces the bound. */
export interface KeyScope {
  kind: KeyKindShown;
  /** The public half; null for the viewing key, which has none to show. */
  address: string | null;
  chain: 'zcash' | 'hyperliquid' | 'tempo' | 'solana';
  /** Where the limit lives. None of these limits is enforced by Holdfast itself. */
  enforcedBy: string;
  /** What the chain or venue says the key may do, read now. */
  scope: Reading<unknown>;
}

const ENFORCED_BY = {
  zcash: 'the Zcash protocol: a viewing key decrypts what the account received and sent and carries no authority to spend',
  hyperliquid: 'Hyperliquid: an approved agent signs trading actions for the account, while a withdrawal or transfer is applied to whoever signed it, which for an agent is its own empty address',
  tempo: 'the Tempo Account Keychain: expiry, spending limit and call scope are checked by the chain on every transaction the key signs',
  solana: 'the SPL Token program: a delegate moves at most the approved amount, from the one token account it was approved on',
} as const;

/**
 * Every key the service holds for the organisation, with its scope as the
 * chain or venue reports it at this moment. A scope that cannot be read is
 * reported as unavailable; it is never filled in from what the database
 * remembers.
 */
export async function keyScopes(deps: Pick<Deps, 'store' | 'tempo' | 'solana' | 'now' | 'redact'>, org: OrgRecord): Promise<KeyScope[]> {
  const now = deps.now();
  const keys = await deps.store.listKeys(org.id);
  const addressOf = (kind: KeyKindShown) => keys.find((key) => key.kind === kind && key.status === 'active')?.address ?? null;

  // A rail that cannot be used yet, for want of an account or a key, is a reason its scope is unavailable.
  const [tempo, solana] = await Promise.all([
    reading<KeyStatus>('tempo', deps, async () => {
      const { rail, account } = await tempoAccess(deps, org);
      return rail.keyStatus(account);
    }),
    reading('solana', deps, async () => {
      const { rail, owner } = await solanaAccess(deps, org);
      const allowance = await rail.remaining(owner);
      return { owner, remaining: allowance.remaining };
    }),
  ]);

  return [
    {
      kind: 'zcash_viewing_key',
      address: null,
      chain: 'zcash',
      enforcedBy: ENFORCED_BY.zcash,
      // Not a reading of the chain: it is what the key is, checked when the organisation was registered.
      scope: available('key format', now, { canView: true, canSpend: false }),
    },
    {
      kind: 'hl_agent',
      address: addressOf('hl_agent'),
      chain: 'hyperliquid',
      enforcedBy: ENFORCED_BY.hyperliquid,
      scope: missing('hyperliquid', now, 'the Hyperliquid adapter has no read of the agents an account has approved'),
    },
    { kind: 'tempo_access', address: addressOf('tempo_access'), chain: 'tempo', enforcedBy: ENFORCED_BY.tempo, scope: tempo },
    { kind: 'solana_delegate', address: addressOf('solana_delegate'), chain: 'solana', enforcedBy: ENFORCED_BY.solana, scope: solana },
  ];
}
