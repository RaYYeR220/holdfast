import { HyperliquidResponseError } from './errors';

const DECIMAL = /^-?\d+(\.\d+)?$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) throw new HyperliquidResponseError(`${where}: expected an object`);
  return value;
}

export function asList(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new HyperliquidResponseError(`${where}: expected an array`);
  return value;
}

export function asText(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new HyperliquidResponseError(`${where}: expected a string`);
  return value;
}

export function asInteger(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new HyperliquidResponseError(`${where}: expected an integer`);
  }
  return value;
}

/** Hyperliquid sends every amount and price as a decimal string. */
export function asDecimalText(value: unknown, where: string): string {
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    throw new HyperliquidResponseError(`${where}: expected a decimal string`);
  }
  return value;
}

export function asDecimal(value: unknown, where: string): number {
  return Number(asDecimalText(value, where));
}

/** Short, single-line rendering of an unexpected payload for error messages. */
export function excerpt(value: unknown, limit = 300): string {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}...` : flat;
}
