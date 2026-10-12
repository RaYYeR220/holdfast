import { getDemoOverview } from '@/server/api/public';
import { bind } from '@/server/http/bind';
import { keepResponses } from '@/app/_lib/keep';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Public and the same for everyone, so an answer is kept for a few seconds: a burst of requests costs one read.
export const GET = keepResponses(bind(getDemoOverview), 10_000);
