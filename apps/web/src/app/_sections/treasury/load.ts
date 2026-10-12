import type { OrgRecord } from '@holdfast/db';
import { demoOrg } from '@/server/demo/service';
import { type TreasuryPage, treasuryPage } from '@/server/pages/treasury';
import { type Failure, PAGE_PATIENCE_MS, failureOf, within } from '@/server/pages/treasury-lock-reads';
import { runtime } from '@/server/runtime';
import { loadDemo } from '../../_lib/demo';

/**
 * The Treasury page's read, made once for a request on the real
 * dependencies: for the public demo, and for the organisation of the owner
 * who is signed in. Nothing here throws.
 */

export interface TreasuryData {
  org: { id: string; name: string; publicDemo: boolean; hasSolanaWallet: boolean };
  treasury: TreasuryPage;
}

export type TreasuryRead = { status: 'ok'; data: TreasuryData } | ({ status: 'empty' | 'unavailable' } & Failure);

async function read(org: OrgRecord): Promise<TreasuryData> {
  const treasury = await within(PAGE_PATIENCE_MS, treasuryPage(runtime(), org));
  return { org: { id: org.id, name: org.name, publicDemo: org.publicDemo, hasSolanaWallet: org.solanaOwner !== null }, treasury };
}

/** The treasury of the public demo. */
export async function loadDemoTreasury(): Promise<TreasuryRead> {
  const demo = await loadDemo();
  if (demo.status !== 'ok') return demo;
  const deps = runtime();
  try {
    return { status: 'ok', data: await read(await within(PAGE_PATIENCE_MS, demoOrg(deps, demo.org.id))) };
  } catch (error) {
    return { status: 'unavailable', ...failureOf(deps, error, deps.now()) };
  }
}

/** The treasury of the organisation of the owner who is signed in. */
export async function loadOwnerTreasury(org: OrgRecord): Promise<TreasuryRead> {
  const deps = runtime();
  try {
    return { status: 'ok', data: await read(org) };
  } catch (error) {
    return { status: 'unavailable', ...failureOf(deps, error, deps.now()) };
  }
}
