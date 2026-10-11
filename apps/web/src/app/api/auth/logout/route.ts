import { postLogout } from '@/server/api/auth';
import { bind } from '@/server/http/bind';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = bind(postLogout);
