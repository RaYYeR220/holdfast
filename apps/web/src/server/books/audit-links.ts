import { createHash, randomBytes } from 'node:crypto';
import { type AuditScope, type ScopedStatement, parseAuditScope } from '@holdfast/books';
import type { AuditLinkRow } from '@holdfast/db';
import type { Deps } from '../deps';
import { invalid, notFound } from '../errors';
import { messageOf } from '../redact';
import { scopedBooks } from './service';

const TOKEN_BYTES = 32;

/** What is kept of a link's token: enough to recognise it, not enough to use it. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface AuditLinkView {
  /** Names the link to its owner, for revoking it. It is the hash of the token and opens nothing. */
  id: string;
  label: string;
  /** Null when what is stored is not a scope; such a link shows nothing. */
  scope: AuditScope | null;
  expiresAt: number | null;
  revokedAt: number | null;
  createdAt: number;
}

function scopeOf(row: AuditLinkRow): AuditScope | null {
  try {
    return parseAuditScope(row.scope);
  } catch {
    return null;
  }
}

const viewOf = (row: AuditLinkRow): AuditLinkView => ({ id: row.tokenHash, label: row.label, scope: scopeOf(row), expiresAt: row.expiresAt, revokedAt: row.revokedAt, createdAt: row.createdAt });

/**
 * Make a link an auditor can open without an account. The token is returned
 * here once and never again: only its hash is stored. The scope says which
 * modules and which dates the holder sees.
 */
export async function createLink(deps: Pick<Deps, 'store' | 'now'>, orgId: string, input: { label: string; scope: unknown; expiresAt: number | null }): Promise<{ token: string; link: AuditLinkView }> {
  let scope: AuditScope;
  try {
    scope = parseAuditScope(input.scope);
  } catch (error) {
    throw invalid(messageOf(error));
  }
  if (scope.modules.length === 0) throw invalid('an audit scope has to cover at least one module');
  if (scope.from !== null && scope.to !== null && scope.from > scope.to) throw invalid('the scope ends before it starts');
  if (input.expiresAt !== null && input.expiresAt <= deps.now()) throw invalid('the link would have expired before it was made');

  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const row = await deps.store.createAuditLink(orgId, { tokenHash: hashToken(token), label: input.label, scope: { from: scope.from, to: scope.to, modules: [...scope.modules] }, expiresAt: input.expiresAt });
  return { token, link: viewOf(row) };
}

/** Every link of the organisation, newest first; revoked and expired ones too. */
export async function listLinks(deps: Pick<Deps, 'store'>, orgId: string): Promise<AuditLinkView[]> {
  return (await deps.store.listAuditLinks(orgId)).map(viewOf);
}

export async function revokeLink(deps: Pick<Deps, 'store'>, orgId: string, id: string): Promise<AuditLinkView> {
  const row = await deps.store.revokeAuditLink(orgId, id);
  if (row === null) throw notFound();
  return viewOf(row);
}

export interface AuditView extends ScopedStatement {
  organisation: string;
  label: string;
  expiresAt: number | null;
}

/**
 * What the holder of a token sees: the statement and ledger of the link's
 * organisation, cut down to the link's scope. A token that is unknown,
 * revoked or expired, or whose stored scope cannot be read as one, opens
 * nothing and is told nothing.
 */
export async function auditView(deps: Pick<Deps, 'store' | 'hyperliquid' | 'tempo' | 'solana' | 'now' | 'redact'>, token: string): Promise<AuditView> {
  const link = await deps.store.liveAuditLink(hashToken(token));
  if (link === null) throw notFound();
  const scope = scopeOf(link);
  if (scope === null || scope.modules.length === 0) throw notFound();
  const org = await deps.store.findOrg(link.orgId);
  if (org === null) throw notFound();
  return { organisation: org.name, label: link.label, expiresAt: link.expiresAt, ...(await scopedBooks(deps, org, scope)) };
}
