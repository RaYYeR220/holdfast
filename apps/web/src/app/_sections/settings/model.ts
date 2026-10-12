/**
 * What the Settings page works out for itself: whether the profile form
 * holds something the server will take, and what each kind of key is called.
 */

export const NAME_MAX = 120;
export const BURN_MAX = 1e12;

export interface ProfileFields {
  name: string;
  /** Dollars a month as typed; empty for none. */
  burn: string;
}

export type ProfileField = 'name' | 'burn';

export type ProfileCheck =
  | { ok: true; profile: { name: string; monthlyBurnUsd: number | null } }
  | { ok: false; errors: Partial<Record<ProfileField, string>> };

const AMOUNT = /^\d+(\.\d{1,2})?$/;

/**
 * The profile form, checked the way the server checks it: a name of 1 to
 * 120 characters, and a monthly burn that is empty or a number of dollars,
 * with at most two decimals, that the server's bound allows. A dollar sign,
 * spaces and thousands separators are read past; anything else is refused
 * here rather than guessed at.
 */
export function checkProfile(fields: ProfileFields): ProfileCheck {
  const errors: Partial<Record<ProfileField, string>> = {};
  const name = fields.name.trim();
  if (name === '') errors.name = 'An organisation has to have a name.';
  else if (name.length > NAME_MAX) errors.name = `A name is at most ${NAME_MAX} characters; this one has ${name.length}.`;

  let monthlyBurnUsd: number | null = null;
  const typed = fields.burn.trim().replace(/^\$/, '').replace(/[\s,]/g, '');
  if (typed !== '') {
    if (!AMOUNT.test(typed)) errors.burn = 'Write the burn as a number of dollars, such as 42500 or 42500.50. Leave it empty to set none.';
    else if (Number(typed) > BURN_MAX) errors.burn = 'That is more than the server takes for a monthly burn.';
    else monthlyBurnUsd = Number(typed);
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, profile: { name, monthlyBurnUsd } };
}

/** The part of a checked profile that differs from what the server holds; null when nothing does. */
export function profileChanges(checked: { name: string; monthlyBurnUsd: number | null }, held: { name: string; monthlyBurnUsd: number | null }): { name?: string; monthlyBurnUsd?: number | null } | null {
  const patch: { name?: string; monthlyBurnUsd?: number | null } = {};
  if (checked.name !== held.name) patch.name = checked.name;
  if (checked.monthlyBurnUsd !== held.monthlyBurnUsd) patch.monthlyBurnUsd = checked.monthlyBurnUsd;
  return Object.keys(patch).length === 0 ? null : patch;
}

/** A burn figure as the form holds it: plain digits, with decimals only when it has any. */
export function burnText(monthlyBurnUsd: number | null): string {
  if (monthlyBurnUsd === null) return '';
  return Number.isInteger(monthlyBurnUsd) ? String(monthlyBurnUsd) : monthlyBurnUsd.toFixed(2);
}

export interface KeyKindCopy {
  name: string;
  chain: string;
  /** What the key is for, in a few words. */
  does: string;
}

/** What each kind of service key is called. A kind this list does not know is shown under its own name. */
export const KEY_KIND: Record<string, KeyKindCopy> = {
  hl_agent: { name: 'Agent key', chain: 'Hyperliquid', does: 'Trades the short on the team’s own account. Cannot withdraw.' },
  tempo_access: { name: 'Access key', chain: 'Tempo', does: 'Pays contractors up to a limit per period, once the account authorizes it.' },
  solana_delegate: { name: 'Token delegate', chain: 'Solana', does: 'Pays contractors up to a fixed allowance, once the wallet approves it.' },
  hl_attester: { name: 'Attester key', chain: 'HyperEVM', does: 'Records snapshots of the hedge, once the account names it. Moves no money.' },
  tempo_sponsor: { name: 'Fee sponsor key', chain: 'Tempo', does: 'Pays the fee of a payout, apart from the team’s money.' },
};

export const keyKind = (kind: string): KeyKindCopy => KEY_KIND[kind] ?? { name: kind.replaceAll('_', ' '), chain: '', does: '' };
