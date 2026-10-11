import { AUDIT_MODULES, inRange, toCsv } from '@holdfast/books';
import { z } from 'zod';
import { auditView, createLink, listLinks, revokeLink } from '../books/audit-links';
import { gatherBooks, publishedStatement, reconciliationOf, statementOf } from '../books/service';
import { orgId, ownerEndpoint, publicEndpoint, reply } from '../http/endpoint';
import { orgParams } from './orgs';

const moment = z.number().int().min(0).max(8_640_000_000_000_000);
const format = z.enum(['json', 'csv']).default('json');

/** A file for the browser to save. Like every other answer, it is not to be kept by a cache. */
function download(body: string, type: string, filename: string): Response {
  return new Response(body, { headers: { 'content-type': `${type}; charset=utf-8`, 'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'no-store' } });
}

/**
 * GET /api/orgs/[orgId]/books/statement?from=&to=&format=json|csv: the
 * statement as of now and the ledger entries of the period; as CSV, the
 * ledger alone.
 */
export const getStatement = ownerEndpoint(
  { params: orgParams, query: z.strictObject({ from: z.coerce.number().pipe(moment).optional(), to: z.coerce.number().pipe(moment).optional(), format }) },
  async ({ deps, org, query }) => {
    const range = { from: query.from ?? null, to: query.to ?? null };
    const books = await gatherBooks(deps, org);
    const ledger = books.ledger.filter((entry) => inRange(entry.ts, range));
    if (query.format === 'csv') return download(toCsv(ledger), 'text/csv', 'holdfast-ledger.csv');
    return { statement: statementOf(deps, org, books, range), ledger };
  },
);

/** GET /api/orgs/[orgId]/books/reconciliation: the records held against each other and against the chains, read now. */
export const getReconciliation = ownerEndpoint({ params: orgParams }, async ({ deps, org }) => reconciliationOf(deps, org, await gatherBooks(deps, org)));

/**
 * GET /api/orgs/[orgId]/books/export?format=json|csv: as JSON, the statement
 * with everything it was derived from, in the form `holdfast verify` reads;
 * as CSV, the whole ledger.
 */
export const getExport = ownerEndpoint({ params: orgParams, query: z.strictObject({ format }) }, async ({ deps, org, query }) => {
  if (query.format === 'csv') return download(toCsv((await gatherBooks(deps, org)).ledger), 'text/csv', 'holdfast-ledger.csv');
  return download(await publishedStatement(deps, org), 'application/json', 'holdfast-statement.json');
});

/** GET /api/orgs/[orgId]/audit-links */
export const getAuditLinks = ownerEndpoint({ params: orgParams }, async ({ deps, org }) => ({ links: await listLinks(deps, org.id) }));

/**
 * POST /api/orgs/[orgId]/audit-links { label, scope: { from, to, modules }, expiresAt? }:
 * answers with the link and its token. The token is shown this once.
 */
export const postAuditLink = ownerEndpoint(
  {
    params: orgParams,
    body: z.strictObject({
      label: z.string().trim().min(1).max(120),
      scope: z.strictObject({ from: moment.nullable(), to: moment.nullable(), modules: z.array(z.enum(AUDIT_MODULES)).min(1).max(AUDIT_MODULES.length) }),
      expiresAt: moment.nullable().default(null),
    }),
  },
  async ({ deps, org, body }) => reply(await createLink(deps, org.id, body), { status: 201 }),
);

/** DELETE /api/orgs/[orgId]/audit-links/[linkId]: the link stops working from this moment. */
export const deleteAuditLink = ownerEndpoint({ params: z.strictObject({ orgId, linkId: z.string().regex(/^[0-9a-f]{64}$/) }) }, async ({ deps, org, params }) => ({ link: await revokeLink(deps, org.id, params.linkId) }));

/**
 * GET /api/audit/[token]?format=json|csv: the scoped statement behind an
 * auditor link, for whoever holds its token. No session is asked for.
 */
export const getAudit = publicEndpoint({ params: z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }), query: z.strictObject({ format }) }, async ({ deps, params, query }) => {
  const view = await auditView(deps, params.token);
  return query.format === 'csv' ? download(toCsv(view.ledger), 'text/csv', 'holdfast-ledger.csv') : view;
});
