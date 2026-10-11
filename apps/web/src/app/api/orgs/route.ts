import { getOrgs, postOrg } from '@/server/api/orgs';
import { bind } from '@/server/http/bind';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = bind(getOrgs);
export const POST = bind(postOrg);
