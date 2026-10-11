import { getPolicy, putPolicy } from '@/server/api/policy';
import { bind } from '@/server/http/bind';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = bind(getPolicy);
export const PUT = bind(putPolicy);
