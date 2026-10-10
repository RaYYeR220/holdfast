import { fundingAprBps } from '@holdfast/core';
import { encodeAbiParameters, keccak256, sliceHex } from 'viem';
import { FractionalLotError, HyperliquidError } from './errors';

/** Hyperliquid's `szDecimals` for ZEC: sizes move in steps of 0.01, and one step is one lot. */
export const LOT_DECIMALS = 2;

const LOTS_PER_COIN = 10 ** LOT_DECIMALS;
const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;
const CLOID_DOMAIN = 'holdfast/cloid/1';
const CLOID_BYTES = 16;

function requireCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HyperliquidError('INVALID_ARGUMENT', `${name} must be a non-negative integer, got ${value}`);
  }
}

/** Lots to an order size with exactly two decimals: 1 -> "0.01", 250 -> "2.50". */
export function lotsToSize(lots: number): string {
  requireCount(lots, 'lots');
  const whole = Math.floor(lots / LOTS_PER_COIN);
  const fraction = String(lots % LOTS_PER_COIN).padStart(LOT_DECIMALS, '0');
  return `${whole}.${fraction}`;
}

/**
 * A signed size as Hyperliquid prints it ("-1.24", "0.5", "3") to signed whole
 * lots. Works on the digits, so no float rounding can hide a fractional lot.
 */
export function sizeToLots(szi: string): number {
  const match = DECIMAL.exec(szi);
  if (match === null) throw new HyperliquidError('INVALID_ARGUMENT', `"${szi}" is not a decimal size`);
  const sign = match[1] ?? '';
  const whole = match[2] ?? '0';
  const fraction = match[3] ?? '';

  if (/[1-9]/.test(fraction.slice(LOT_DECIMALS))) throw new FractionalLotError(szi);

  const lots = Number(whole) * LOTS_PER_COIN + Number(fraction.slice(0, LOT_DECIMALS).padEnd(LOT_DECIMALS, '0'));
  if (!Number.isSafeInteger(lots)) throw new HyperliquidError('INVALID_ARGUMENT', `size ${szi} is out of range`);
  return sign === '-' && lots !== 0 ? -lots : lots;
}

/**
 * Client order id for the `index`-th order of an organisation's `tick`. The
 * same inputs always give the same 16 bytes, which is what lets a retry be
 * recognised as the order it repeats.
 */
export function cloidFor(orgId: string, tick: number, index: number): `0x${string}` {
  if (orgId.length === 0) throw new HyperliquidError('INVALID_ARGUMENT', 'orgId must not be empty');
  requireCount(tick, 'tick');
  requireCount(index, 'index');
  // ABI encoding length-prefixes the strings, so two different triples never share a preimage.
  const preimage = encodeAbiParameters(
    [{ type: 'string' }, { type: 'string' }, { type: 'uint256' }, { type: 'uint256' }],
    [CLOID_DOMAIN, orgId, BigInt(tick), BigInt(index)],
  );
  return sliceHex(keccak256(preimage), 0, CLOID_BYTES);
}

/**
 * Annualised funding in bps from hourly rates as Hyperliquid reports them
 * (a positive rate is paid by longs to shorts). An empty history is an error
 * rather than zero: "no data" must not read as "funding is flat".
 */
export function fundingAprFromHistory(rates: readonly number[]): number {
  if (rates.length === 0) throw new HyperliquidError('INVALID_ARGUMENT', 'funding history is empty');
  if (!rates.every((rate) => Number.isFinite(rate))) {
    throw new HyperliquidError('INVALID_ARGUMENT', 'funding history contains a non-numeric rate');
  }
  return fundingAprBps([...rates]);
}
