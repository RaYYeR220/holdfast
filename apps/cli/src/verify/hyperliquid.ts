import { buildLedger, type FundingPayment, type HedgeFill, type LedgerEntry, type PublishedStatement } from '@holdfast/books';
import { ZAT_PER_LOT } from '@holdfast/core';
import type { Sources } from '../env';
import { describeDiff, diffEntries, type EntryField, isClean } from './compare';
import { describeError, fail, firstFew, pass, skipped, type StepResult } from './report';

export interface HyperliquidOptions {
  offline: boolean;
  /** The account the reader expects the statement to be about, when they know it themselves. */
  account: string | null;
}

/** Hyperliquid serves only the most recent fills of an account. A history this long may have lost its beginning. */
const FILL_HISTORY_LIMIT = 10_000;
const COIN = 'ZEC';
const HEDGE_ASSET = `${COIN}-PERP`;
const LOTS_PER_COIN = 100;
const ACCOUNT = /^0x[0-9a-fA-F]{40}$/;

/** The transaction hash is left out: the venue's fill history is read here without one. */
const ON_VENUE: readonly EntryField[] = ['ts', 'kind', 'asset', 'decimals', 'amount', 'usd', 'usdPrice', 'usdPriceAt', 'ref', 'counterparty'];

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

/** The short the ledger's own fills add up to, in lots; null when they do not come to whole lots. */
function shortLotsBooked(ledger: readonly LedgerEntry[]): number | null {
  const net = ledger.filter((entry) => entry.asset === HEDGE_ASSET && (entry.kind === 'hedge_open' || entry.kind === 'hedge_close')).reduce((sum, entry) => sum - entry.amount, 0n);
  return net % ZAT_PER_LOT === 0n ? Number(net / ZAT_PER_LOT) : null;
}

/**
 * Read the account's whole history from Hyperliquid and hold the ledger's
 * entries against it.
 *
 * The statement says which stretch of time its ledger covers, and that claim
 * is checked rather than followed: the history is read from the beginning,
 * and anything the venue shows before the stretch begins fails the step, as
 * does a history too long for the venue to serve in full. Inside the stretch
 * every fill and funding payment must be in the ledger and the other way
 * round. What came after it is used only to work the position back.
 *
 * The position is checked twice: the ledger's fills must add up to the short
 * the venue shows for the end of the stretch, and the journal's latest
 * snapshot, which is taken before that entry's own order trades, must record
 * the short the venue shows for that moment.
 */
export async function checkHyperliquid(published: PublishedStatement, options: HyperliquidOptions, sources: Sources): Promise<StepResult> {
  const { account, since, through } = published.org.hyperliquid;
  const asOf = published.statement.asOf;

  if (!ACCOUNT.test(account)) return fail('hyperliquid', 'the statement names no Hyperliquid account');
  if (options.account !== null && options.account.toLowerCase() !== account.toLowerCase()) {
    return fail('hyperliquid', `the statement is about account ${account}, not ${options.account}, the one expected`);
  }
  if (!(since <= through && through <= asOf)) {
    return fail('hyperliquid', 'the stretch of history the statement claims does not run from a start to an end no later than the statement itself');
  }
  if (options.offline) return skipped('hyperliquid', 'not run: --offline');

  let fills: HedgeFill[];
  let funding: FundingPayment[];
  let shortNow: number;
  try {
    const venue = await sources.hyperliquid();
    const [allFills, allFunding, state] = await Promise.all([venue.userFills(account, 0), venue.userFunding(account, 0), venue.state(account)]);
    fills = allFills;
    funding = allFunding;
    shortNow = state.shortLots;
  } catch (e) {
    return skipped('hyperliquid', `the venue could not be read: ${describeError(e)}`);
  }

  if (fills.length >= FILL_HISTORY_LIMIT) {
    const oldest = Math.min(...fills.map((fill) => fill.time));
    return fail('hyperliquid', `the venue serves only the latest ${FILL_HISTORY_LIMIT} fills of account ${account}, back to ${new Date(oldest).toISOString()}; what came before cannot be shown to be in the ledger`);
  }
  const before = fills.filter((f) => f.time < since).length + funding.filter((p) => p.time < since).length;
  if (before > 0) {
    return fail('hyperliquid', `account ${account} has ${before} fills and funding payments from before ${new Date(since).toISOString()}, where the statement's history begins`);
  }

  const covered = (time: number) => time >= since && time <= through;
  const rebuilt = buildLedger({ fills: fills.filter((f) => covered(f.time)), funding: funding.filter((p) => covered(p.time)) });
  const ledger = published.ledger.filter((entry) => entry.source === 'hyperliquid');
  const diff = diffEntries(ledger, rebuilt, () => ON_VENUE);
  if (!isClean(diff)) {
    const summary = `${diff.missing.length} on the venue but not in the ledger, ${diff.unexpected.length} in the ledger but not on the venue, ${diff.changed.length} that differ`;
    return fail('hyperliquid', `account ${account}: ${summary}`, firstFew(describeDiff(diff, 'Hyperliquid')));
  }

  const booked = shortLotsBooked(ledger);
  const atEnd = shortLotsAt(through, shortNow, fills);
  if (booked !== atEnd) {
    return fail('hyperliquid', `the fills in the ledger leave a short of ${booked ?? 'a fraction of a lot'} lot(s); the venue's position and later fills give ${atEnd} at the end of the statement's history`);
  }
  const snapshot = published.journal.findLast((entry) => entry.snapshot.hl !== null)?.snapshot.hl ?? null;
  if (snapshot !== null) {
    const then = shortLotsAt(snapshot.asOf, shortNow, fills);
    if (then !== snapshot.shortLots) {
      return fail('hyperliquid', `the journal's latest snapshot records a short of ${snapshot.shortLots} lot(s); the venue's position and fills give ${then} at that moment`);
    }
  }

  const later = fills.filter((f) => f.time > through).length;
  return pass('hyperliquid', `account ${account}: all ${diff.matched} entries match ${fills.length - later} fills and ${funding.filter((p) => covered(p.time)).length} funding payments, and the short of ${atEnd} lot(s) they leave`, [
    options.account === null ? 'the account is the one the statement names; name the one you expect with --hyperliquid-account' : 'the account is the one asked for',
    ...(snapshot === null ? ['the journal holds no venue reading to compare a position with'] : []),
    ...(later === 0 ? [] : [`the account has made ${later} fills since the statement`]),
    'the account value the journal recorded at each moment is not something the venue can be asked for afterwards',
  ]);
}
