import { postOpenAttestation } from '@/server/api/attestations';
import { bind } from '@/server/http/bind';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = bind(postOpenAttestation);
