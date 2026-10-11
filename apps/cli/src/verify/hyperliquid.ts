import { buildLedger, type FundingPayment, type HedgeFill, type LedgerEntry, type PublishedStatement } from '@holdfast/books';
import type { Sources } from '../env';
import { describeDiff, diffEntries, type EntryField, isClean } from './compare';
import { describeError, fail, firstFew, pass, skipped, type StepResult } from './report';

/** Hyperliquid serves only the most recent fills of an account; a history this long may have lost its beginning. */
const FILL_HISTORY_LIMIT = 10_000;
const COIN = 'ZEC';
const LOTS_PER_COIN = 100;

/** The transaction hash is left out: the venue's fill history is read here without one. */
const ON_VENUE: readonly EntryField[] = ['ts', 'kind', 'asset', 'decimals', 'amount', 'usd', 'usdPrice', 'usdPriceAt', 'ref'];

const FROM_A_FILL: readonly LedgerEntry['kind'][] = ['hedge_open', 'hedge_close', 'realized_pnl', 'trade_fee'];

/**
 * The short the account held at `asOf`, worked back from what it holds now:
 * every sale since then made it larger and every purchase smaller.
 */
function shortLotsAt(asOf: number, shortNow: number, fills: readonly HedgeFill[]): number {
  let lots = shortNow;
  for (const fill of fills) {
    if (fill.coin !== COIN || fill.time <= asOf) continue;
    const traded = Math.round(fill.size * LOTS_PER_COIN);
    lots += fill.side === 'sell' ? -traded : traded;
  }
  return lots;
}

/**
 * Read the published account's fills, funding and position from Hyperliquid
 * and hold the ledger's entries against them. The position is compared at
 * the moment of the latest journal snapshot, which is taken before that
 * entry's own order trades.
 */
export async function checkHyperliquid(published: PublishedStatement, offline: boolean, sources: Sources): Promise<StepResult> {
  if (offline) return skipped('hyperliquid', 'not run: --offline');
  const { account, since, through } = published.org.hyperliquid;

  let fills: HedgeFill[];
  let funding: FundingPayment[];
  let shortNow: number;
  try {
    const venue = await sources.hyperliquid();
    const [fetchedFills, fetchedFunding, state] = await Promise.all([venue.userFills(account, since), venue.userFunding(account, since), venue.state(account)]);
    fills = fetchedFills;
    funding = fetchedFunding;
    shortNow = state.shortLots;
  } catch (e) {
    return skipped('hyperliquid', `the venue could not be read: ${describeError(e)}`);
  }

  const covered = (time: number) => time >= since && time <= through;
  const rebuilt = buildLedger({ fills: fills.filter((f) => covered(f.time)), funding: funding.filter((p) => covered(p.time)) });
  let ledger = published.ledger.filter((entry) => entry.source === 'hyperliquid');

  const notes: string[] = [];
  const oldest = fills[0]?.time;
  if (fills.length >= FILL_HISTORY_LIMIT && oldest !== undefined) {
    const before = ledger.length;
    ledger = ledger.filter((entry) => !FROM_A_FILL.includes(entry.kind) || entry.ts >= oldest);
    notes.push(`the venue no longer serves fills before ${new Date(oldest).toISOString()}; ${before - ledger.length} older entries could not be checked`);
  }

  const diff = diffEntries(ledger, rebuilt, () => ON_VENUE);
  if (!isClean(diff)) {
    const summary = `${diff.missing.length} on the venue but not in the ledger, ${diff.unexpected.length} in the ledger but not on the venue, ${diff.changed.length} that differ`;
    return fail('hyperliquid', `account ${account}: ${summary}`, firstFew(describeDiff(diff, 'Hyperliquid')));
  }

  const matched = `account ${account}: all ${diff.matched} entries match ${fills.length} fills and ${funding.length} funding payments`;
  const snapshot = published.journal.findLast((entry) => entry.snapshot.hl !== null)?.snapshot.hl;
  if (snapshot === null || snapshot === undefined) {
    return pass('hyperliquid', matched, [...notes, 'the journal holds no venue reading; the position was not compared']);
  }
  const then = shortLotsAt(snapshot.asOf, shortNow, fills);
  if (then !== snapshot.shortLots) {
    return fail('hyperliquid', `the journal's latest snapshot records a short of ${snapshot.shortLots} lot(s); the venue's position and fills give ${then} at that moment`, notes);
  }
  return pass('hyperliquid', `${matched}, and the short of ${snapshot.shortLots} lot(s) in the latest journal snapshot`, notes);
}
