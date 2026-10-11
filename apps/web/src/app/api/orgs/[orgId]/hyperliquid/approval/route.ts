import { getApproval, postApproval } from '@/server/api/hyperliquid';
import { bind } from '@/server/http/bind';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = bind(getApproval);
export const POST = bind(postApproval);
