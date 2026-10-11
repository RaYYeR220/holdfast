import { deleteAuditLink } from '@/server/api/books';
import { bind } from '@/server/http/bind';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const DELETE = bind(deleteAuditLink);
