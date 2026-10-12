import type { OrgRecord } from '@holdfast/db';
import type { JournalEntry } from '@holdfast/engine';
import { type Address, getAddress } from 'viem';
import { type World, BIRTHDAY, keyAddress, newAccount, note, organisation, sessionOf, tickOnce } from './world';

export const HOUR = 60 * 60_000;
export const TREASURY_ZAT = 5_000_000n;

export interface Attesting {
  org: OrgRecord;
  /** The address of the organisation's attester key, as the database keeps it. */
  attester: string;
  /** The organisation's account as the contract is given it. */
  account: Address;
  /** A session of the organisation's owner. */
  cookie: string;
}

/**
 * An organisation with ZEC in its treasury and the lock on, whose attester
 * key its account has named on the contract. No tick has run for it yet.
 */
export async function registered(w: World, over: { name?: string; publicDemo?: boolean } = {}): Promise<Attesting> {
  const owner = newAccount();
  const org = await organisation(w, owner.address, { name: over.name ?? 'Attested Labs' });
  await w.store.updateOrg(org.id, { lockEnabled: true, publicDemo: over.publicDemo ?? false });
  w.chain.notes = [note(BIRTHDAY + 10, TREASURY_ZAT)];
  const attester = await keyAddress(w, org.id, 'hl_attester');
  w.attestor.name(org.hlUser, attester);
  return { org: { ...org, lockEnabled: true, publicDemo: over.publicDemo ?? false }, attester, account: getAddress(org.hlUser), cookie: await sessionOf(w, owner.address) };
}

/**
 * A tick `ms` after whatever happened last, with the Zcash chain having moved
 * on meanwhile: a tip that stood still for long is refused as stale, and the
 * tick would then read no treasury.
 */
export async function tickAfter(w: World, org: Pick<OrgRecord, 'id'>, ms: number): Promise<JournalEntry> {
  w.clock.advance(ms - 60_000);
  w.chain.height += Math.max(1, Math.round(ms / 75_000));
  return tickOnce(w, org.id);
}

/** The whole journal of an organisation, oldest first. */
export const journalOf = (w: World, org: Pick<OrgRecord, 'id'>): Promise<JournalEntry[]> => w.store.journalRange(org.id, 1, 100_000);
