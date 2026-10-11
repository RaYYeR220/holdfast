import { type AssetDirectory, resolveAsset, ZEC } from '../assets';
import type { LedgerEntry } from '../entry';
import { uniqueBy } from '../ids';
import { priceBook } from '../prices';
import { type Findings, swapRef } from '../problems';
import { isSwapFinal, type SwapRecord, SWAP_SUCCESS, swapSawDeposit } from '../records';
import { swapEntries } from '../sources/swaps';
import { BLOCK_CLOCK_ALLOWANCE_MS } from '../swap-funding';
import { differsIn } from './same';

function groupByRef(entries: readonly LedgerEntry[], kind: LedgerEntry['kind']): Map<string, LedgerEntry[]> {
  const groups = new Map<string, LedgerEntry[]>();
  for (const entry of entries) {
    if (entry.kind === kind) groups.set(entry.ref, [...(groups.get(entry.ref) ?? []), entry]);
  }
  return groups;
}

/** A ZEC price is not something a swap record fixes; a stablecoin's par value, or the absence of any value, is. */
const valueIsFixed = (entry: LedgerEntry) => entry.asset !== ZEC.symbol;

/**
 * The input of a swap paid in ZEC: the treasury payment the ledger says
 * funded it. Whether a swap was paid in ZEC is read from the swap record, not
 * from how the ledger labels its legs. Returns the payment when it holds up.
 */
function checkDeposit(swap: SwapRecord, legs: readonly LedgerEntry[], out: Findings): LedgerEntry | null {
  const ref = swapRef(swap.id);
  const fromTreasury = legs.filter((leg) => leg.source === 'zcash');
  const fromRecord = legs.filter((leg) => leg.source !== 'zcash');
  const [funding] = fromTreasury;

  if (funding === undefined) {
    const [recorded] = fromRecord;
    if (recorded !== undefined) {
      out.error('unfunded_swap', `swap ${swap.id} took ${swap.amountIn} zat, and no transparent payment of that amount left the treasury for it`, ref, recorded.id);
    } else if (swapSawDeposit(swap)) {
      out.error('swap_funding_mismatch', `swap ${swap.id} received a deposit of ${swap.amountIn} but the ledger has no input leg for it`, ref);
    }
    return null;
  }

  const ids = legs.map((leg) => leg.id);
  if (legs.length > 1) {
    out.error('swap_funding_mismatch', `swap ${swap.id} has ${legs.length} input legs in the ledger; a swap has one deposit`, ref, ...ids);
    return null;
  }
  if (funding.amount !== -swap.amountIn) {
    out.error('swap_funding_mismatch', `swap ${swap.id} took ${swap.amountIn} zat but the payment booked as its deposit is ${-funding.amount} zat`, ref, funding.id);
    return null;
  }
  const tooEarly = funding.ts < swap.createdAt - BLOCK_CLOCK_ALLOWANCE_MS;
  const tooLate = isSwapFinal(swap) && funding.ts > swap.updatedAt + BLOCK_CLOCK_ALLOWANCE_MS;
  if (tooEarly || tooLate) {
    const when = tooEarly ? 'before the swap was created' : 'after the swap had ended';
    out.error('swap_funding_mismatch', `the payment booked as the deposit of swap ${swap.id} was made ${when}`, ref, funding.id);
    return null;
  }
  if (funding.counterparty?.address !== swap.depositAddress) {
    out.error('swap_ledger_mismatch', `the payment booked as the deposit of swap ${swap.id} does not name the swap's deposit address`, ref, funding.id);
    return null;
  }
  return funding;
}

/** The input of a swap paid in anything else: the one leg its own record gives, and no treasury payment. */
function checkOwnLeg(swap: SwapRecord, legs: readonly LedgerEntry[], expected: LedgerEntry | undefined, out: Findings): LedgerEntry | null {
  const ref = swapRef(swap.id);
  const [leg] = legs;
  if (expected === undefined) {
    if (leg !== undefined) out.error('swap_ledger_mismatch', `the ledger books an input for swap ${swap.id}, which has seen no deposit`, ref, leg.id);
    return null;
  }
  if (leg === undefined) {
    out.error('swap_funding_mismatch', `swap ${swap.id} received a deposit of ${swap.amountIn} but the ledger has no input leg for it`, ref);
    return null;
  }
  if (legs.length > 1) {
    out.error('swap_funding_mismatch', `swap ${swap.id} has ${legs.length} input legs in the ledger; a swap has one deposit`, ref, ...legs.map((l) => l.id));
    return null;
  }
  const field = differsIn(leg, expected, valueIsFixed(expected));
  if (field !== null) {
    out.error('swap_ledger_mismatch', `the input booked for swap ${swap.id} differs from the swap record in its ${field}`, ref, leg.id);
    return null;
  }
  return leg;
}

/** The output leg: what the swap record says was delivered against what the ledger booked. Returns the arrival when it holds up. */
function checkArrival(swap: SwapRecord, arrivals: readonly LedgerEntry[], expected: LedgerEntry | undefined, out: Findings): LedgerEntry | null {
  const ref = swapRef(swap.id);
  const [arrival] = arrivals;

  if (swap.state !== SWAP_SUCCESS) {
    if (arrival !== undefined) {
      out.error('swap_arrival_mismatch', `the ledger books an arrival for swap ${swap.id}, which is "${swap.state}"`, ref, arrival.id);
    }
    return null;
  }
  if (swap.amountOut === null || swap.destinationTxs.length === 0 || expected === undefined) {
    const missing = swap.amountOut === null ? 'no amount delivered' : 'no destination transaction';
    out.error('swap_arrival_missing', `swap ${swap.id} is complete but records ${missing}`, ref);
    return null;
  }
  if (swap.amountOut < swap.minAmountOut) {
    out.error('swap_below_minimum', `swap ${swap.id} delivered ${swap.amountOut}, under the ${swap.minAmountOut} its quote guaranteed`, ref);
  }
  if (arrival === undefined) {
    out.error('swap_arrival_missing', `swap ${swap.id} delivered ${swap.amountOut} but the ledger has no arrival for it`, ref);
    return null;
  }
  if (arrivals.length > 1) {
    out.error('swap_arrival_mismatch', `the ledger books ${arrivals.length} arrivals for swap ${swap.id}`, ref, ...arrivals.map((a) => a.id));
    return null;
  }
  const field = differsIn(arrival, expected, valueIsFixed(expected));
  if (field !== null) {
    out.error('swap_arrival_mismatch', `the arrival booked for swap ${swap.id} differs from what the swap record says was delivered in its ${field}`, ref, arrival.id);
    return null;
  }
  return arrival;
}

/**
 * Each swap against the treasury payment that funded it and against what
 * arrived. Which payment funded which swap is decided when the ledger is
 * built; here that pairing is held against the swap records, every leg is
 * held against the entry its record gives, and every swap leg in the ledger
 * must belong to a swap.
 */
export function checkSwaps(swaps: readonly SwapRecord[], ledger: readonly LedgerEntry[], assets: AssetDirectory, out: Findings): void {
  const inputs = groupByRef(ledger, 'swap_out');
  const outputs = groupByRef(ledger, 'swap_in');
  const noPrices = priceBook([]);

  for (const swap of uniqueBy(swaps, (s) => s.id)) {
    const legs = inputs.get(swap.id) ?? [];
    const arrivals = outputs.get(swap.id) ?? [];
    inputs.delete(swap.id);
    outputs.delete(swap.id);

    // What the record alone gives: its own input leg, as if no treasury payment funded it, and its arrival.
    const fromRecord = swapEntries({ swaps: [swap], fundedBy: new Map(), assets, prices: noPrices, explorers: {} });
    const expectedInput = fromRecord.find((entry) => entry.kind === 'swap_out');
    const expectedArrival = fromRecord.find((entry) => entry.kind === 'swap_in');
    const paidInZec = resolveAsset(swap.originAsset, assets, 'unknown').chain === ZEC.chain;

    const funding = paidInZec ? checkDeposit(swap, legs, out) : checkOwnLeg(swap, legs, expectedInput, out);
    const arrival = checkArrival(swap, arrivals, expectedArrival, out);
    if (funding === null) continue;

    if (swap.state !== SWAP_SUCCESS) {
      const fate = isSwapFinal(swap) ? `ended as "${swap.state}" and delivered nothing` : `is "${swap.state}" and has not delivered yet`;
      out.warn('swap_unsettled', `the deposit for swap ${swap.id} was made, and the swap ${fate}`, swapRef(swap.id), funding.id);
    } else if (arrival !== null) {
      out.match('swap', swapRef(swap.id), funding.id, arrival.id);
    }
  }

  for (const entry of [...inputs.values(), ...outputs.values()].flat()) {
    out.error('swap_entry_without_swap', `ledger entry ${entry.id} is a swap leg, but no swap ${entry.ref} is on record`, entry.id);
  }
}
