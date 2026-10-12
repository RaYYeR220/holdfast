import { postTempoRevokeSubmit } from '@/server/api/rails';
import { bind } from '@/server/http/bind';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Seconds the platform is asked to allow: this route waits on a chain. */
export const maxDuration = 300;

export const POST = bind(postTempoRevokeSubmit);
