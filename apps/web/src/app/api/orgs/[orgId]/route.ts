import { getOrg, patchOrg } from '@/server/api/orgs';
import { bind } from '@/server/http/bind';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = bind(getOrg);
export const PATCH = bind(patchOrg);
