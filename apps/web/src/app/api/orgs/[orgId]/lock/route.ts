import { putLock } from '@/server/api/policy';
import { bind } from '@/server/http/bind';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PUT = bind(putLock);
