import { getPayouts, postPayout } from '@/server/api/payouts';
import { bind } from '@/server/http/bind';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = bind(getPayouts);
export const POST = bind(postPayout);
