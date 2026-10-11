import { ZEC } from '../assets';
import type { LedgerEntry } from '../entry';
import { uniqueBy } from '../ids';
import { type Findings, swapRef } from '../problems';
import { isSwapFinal, type SwapRecord, SWAP_SUCCESS, swapSawDeposit } from '../records';
import { BLOCK_CLOCK_ALLOWANCE_MS } from '../swap-funding';

function groupByRef(entries: readonly LedgerEntry[], kind: LedgerEntry['kind']): Map<string, LedgerEntry[]> {
  const groups = new Map<string, LedgerEntry[]>();
  for (const entry of entries) {
    if (entry.kind === kind) groups.set(entry.ref, [...(groups.get(entry.ref) ?? []), entry]);
  }
  return groups;
}

/**
 * The input leg: the swap against the treasury payment the ledger says funded
 * it. Returns the leg when it holds up. A swap paid in something other than
 * ZEC has only the leg booked from its own record, which there is nothing to
 * hold against.
 */
function checkFunding(swap: SwapRecord, legs: readonly LedgerEntry[], out: Findings): LedgerEntry | null {
  const ref = swapRef(swap.id);
  const fromTreasury = legs.filter((leg) => leg.source === 'zcash');
  const [funding] = fromTreasury;

  if (funding === undefined) {
    const [recorded] = legs;
    if (recorded === undefined) {
      if (swapSawDeposit(swap)) {
        out.error('swap_funding_mismatch', `swap ${swap.id} received a deposit of ${swap.amountIn} but the ledger has no input leg for it`, ref);
      }
      return null;
    }
    if (recorded.asset !== ZEC.symbol) return recorded;
    out.error('unfunded_swap', `swap ${swap.id} took ${swap.amountIn} zat, and no transparent payment of that amount left the treasury for it`, ref, recorded.id);
    return null;
  }

  const ids = fromTreasury.map((leg) => leg.id);
  if (fromTreasury.length > 1) {
    out.error('swap_funding_mismatch', `swap ${swap.id} is funded by ${fromTreasury.length} treasury payments; a swap has one deposit`, ref, ...ids);
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
  return funding;
}

/** The output leg: what the swap service reports against what the ledger booked. Returns the arrival when it holds up. */
function checkArrival(swap: SwapRecord, arrivals: readonly LedgerEntry[], out: Findings): LedgerEntry | null {
  const ref = swapRef(swap.id);
  const [arrival] = arrivals;

  if (swap.state !== SWAP_SUCCESS) {
    if (arrival !== undefined) {
      out.error('swap_arrival_mismatch', `the ledger books an arrival for swap ${swap.id}, which is "${swap.state}"`, ref, arrival.id);
    }
    return null;
  }
  if (swap.amountOut === null || swap.destinationTxs.length === 0) {
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
  if (arrival.amount !== swap.amountOut) {
    out.error('swap_arrival_mismatch', `swap ${swap.id} delivered ${swap.amountOut} but the ledger books ${arrival.amount}`, ref, arrival.id);
    return null;
  }
  if (arrival.proof.tx === null || !swap.destinationTxs.includes(arrival.proof.tx)) {
    out.error('swap_arrival_mismatch', `the arrival booked for swap ${swap.id} does not point at one of its destination transactions`, ref, arrival.id);
    return null;
  }
  return arrival;
}

/**
 * Each swap against the treasury payment that funded it and against what
 * arrived. Which payment funded which swap is decided when the ledger is
 * built; here that pairing is held against the swap records, and every swap
 * leg in the ledger must belong to a swap.
 */
export function checkSwaps(swaps: readonly SwapRecord[], ledger: readonly LedgerEntry[], out: Findings): void {
  const inputs = groupByRef(ledger, 'swap_out');
  const outputs = groupByRef(ledger, 'swap_in');

  for (const swap of uniqueBy(swaps, (s) => s.id)) {
    const legs = inputs.get(swap.id) ?? [];
    const arrivals = outputs.get(swap.id) ?? [];
    inputs.delete(swap.id);
    outputs.delete(swap.id);

    const funding = checkFunding(swap, legs, out);
    const arrival = checkArrival(swap, arrivals, out);
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
