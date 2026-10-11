import { postTick } from '@/server/api/tick';
import { bind } from '@/server/http/bind';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Seconds the platform is asked to allow; the tick stops starting work well before that. */
export const maxDuration = 300;

export const POST = bind(postTick);
