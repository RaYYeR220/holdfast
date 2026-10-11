import { postQuote } from '@/server/api/funding';
import { bind } from '@/server/http/bind';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = bind(postQuote);
