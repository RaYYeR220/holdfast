import { getSolanaRail } from '@/server/api/rails';
import { bind } from '@/server/http/bind';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = bind(getSolanaRail);
