import { getZcashTip } from '@/server/api/zcash';
import { bind } from '@/server/http/bind';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = bind(getZcashTip);
