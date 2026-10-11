import { z } from 'zod';
import { scorecardOf, seriesOf } from '../backtest/service';
import { demoBooks, demoJournal, demoList, demoOrg, demoOverview, demoPayouts, demoReceipts, demoSafety } from '../demo/service';
import { orgId, publicEndpoint } from '../http/endpoint';
import { receiptOf } from '../payouts/receipt';

/**
 * What anyone may read without signing in: the organisations that chose to
 * be a public demo, the backtest of the default policy, and the receipt
 * behind a receipt token.
 */

const demoParams = z.strictObject({ orgId });

/** GET /api/demo: the organisations that are a public demo. */
export const getDemoList = publicEndpoint({}, async ({ deps }) => ({ orgs: await demoList(deps) }));

/** GET /api/demo/[orgId]/overview */
export const getDemoOverview = publicEndpoint({ params: demoParams }, async ({ deps, params }) => demoOverview(deps, await demoOrg(deps, params.orgId)));

/** GET /api/demo/[orgId]/journal?limit=&beforeSeq= */
export const getDemoJournal = publicEndpoint(
  {
    params: demoParams,
    query: z.strictObject({
      limit: z.coerce.number().int().min(1).max(100).optional(),
      beforeSeq: z.coerce.number().int().min(1).optional(),
    }),
  },
  async ({ deps, params, query }) => demoJournal(deps, await demoOrg(deps, params.orgId), query),
);

/** GET /api/demo/[orgId]/receipts */
export const getDemoReceipts = publicEndpoint({ params: demoParams }, async ({ deps, params }) => demoReceipts(deps, await demoOrg(deps, params.orgId)));

/** GET /api/demo/[orgId]/payouts */
export const getDemoPayouts = publicEndpoint({ params: demoParams }, async ({ deps, params }) => demoPayouts(deps, await demoOrg(deps, params.orgId)));

/** GET /api/demo/[orgId]/safety */
export const getDemoSafety = publicEndpoint({ params: demoParams }, async ({ deps, params }) => demoSafety(deps, await demoOrg(deps, params.orgId)));

/** GET /api/demo/[orgId]/books */
export const getDemoBooks = publicEndpoint({ params: demoParams }, async ({ deps, params }) => demoBooks(deps, await demoOrg(deps, params.orgId)));

/** GET /api/backtest/scorecard */
export const getScorecard = publicEndpoint({}, async ({ deps }) => scorecardOf(deps));

/** GET /api/backtest/series?scenario= */
export const getSeries = publicEndpoint({ query: z.strictObject({ scenario: z.string().min(1).max(64) }) }, async ({ deps, query }) => seriesOf(deps, query.scenario));

/** A receipt token is 32 random bytes in base64url. */
const receiptToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** GET /api/receipts/[token]: one paid payout line, for whoever holds its token. */
export const getReceipt = publicEndpoint({ params: z.strictObject({ token: receiptToken }) }, async ({ deps, params }) => receiptOf(deps, params.token));
