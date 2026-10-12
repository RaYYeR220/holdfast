import type { OrgRecord } from '@holdfast/db';
import { demoOrg } from '@/server/demo/service';
import { type SettingsFacts, settingsFacts } from '@/server/pages/settings';
import { type Attempt, attempt } from '../safety/attempt';

/**
 * What the Settings page reads: the organisation's profile, the accounts it
 * is tied to and the keys the service has made for it.
 */

/** The demo organisation's settings, for anyone to read. An organisation that is not a public demo answers as missing. */
export function loadDemoSettings(orgId: string): Promise<Attempt<SettingsFacts>> {
  return attempt(async (deps) => settingsFacts(deps, await demoOrg(deps, orgId)));
}

/** The settings of the signed-in owner's organisation. */
export function loadOwnerSettings(org: OrgRecord): Promise<Attempt<SettingsFacts>> {
  return attempt((deps) => settingsFacts(deps, org));
}
