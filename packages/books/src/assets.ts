export interface AssetInfo {
  symbol: string;
  decimals: number;
  /** Chain the asset lives on, under the name the ledger uses for it. */
  chain: string;
  /** Dollar stablecoins are carried at one dollar a unit. */
  usdPegged: boolean;
}

/** Asset details by the identifier a record names the asset with: a 1Click asset id, a token contract, a mint. */
export type AssetDirectory = Readonly<Record<string, AssetInfo>>;

export const ZEC: AssetInfo = { symbol: 'ZEC', decimals: 8, chain: 'zcash', usdPegged: false };

/** USDC as Hyperliquid holds it. HyperCore keeps eight decimals, two more than USDC has elsewhere. */
export const HYPERLIQUID_USDC: AssetInfo = { symbol: 'USDC', decimals: 8, chain: 'hyperliquid', usdPegged: true };

/** Perp sizes are booked with ZEC's own precision, so one lot of 0.01 ZEC is 1 000 000 units, as it is in zatoshi. */
export const PERP_DECIMALS = 8;

const dollar = (symbol: string, chain: string): AssetInfo => ({ symbol, decimals: 6, chain, usdPegged: true });

/**
 * The assets Holdfast moves, by the identifier a record names them with:
 * 1Click ids for what swaps go between, and the mainnet contract or mint of
 * each stablecoin payouts are made in. Decimals and the dollar peg are facts
 * of the chain, so they are fixed here and never taken from a record.
 */
export const KNOWN_ASSETS: AssetDirectory = {
  'nep141:zec.omft.near': ZEC,
  '1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054': HYPERLIQUID_USDC,
  'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near': dollar('USDC', 'solana'),
  'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near': dollar('USDC', 'base'),
  'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near': dollar('USDC', 'arbitrum'),
  '0x20c0000000000000000000000000000000000000': dollar('pathUSD', 'tempo'),
  '0x20c000000000000000000000b9537d11c60e8b50': dollar('USDC.e', 'tempo'),
  '0x20c0000000000000000000006a37da5c996874be': dollar('OUSD', 'tempo'),
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: dollar('USDC', 'solana'),
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: dollar('USDT', 'solana'),
};

/** Hex identifiers are the same whatever their case; everything else is taken as written. */
function lookUp(id: string, directory: AssetDirectory): AssetInfo | undefined {
  if (Object.hasOwn(directory, id)) return directory[id];
  const lower = id.toLowerCase();
  return /^0x[0-9a-f]+$/.test(lower) && Object.hasOwn(directory, lower) ? directory[lower] : undefined;
}

export function isKnownAsset(id: string, directory: AssetDirectory): boolean {
  return lookUp(id, directory) !== undefined;
}

/**
 * An asset the directory does not know is booked under its raw identifier in
 * whole base units and is never given a dollar value: nothing is assumed
 * about its decimals or its price.
 */
export function resolveAsset(id: string, directory: AssetDirectory, chain: string): AssetInfo {
  return lookUp(id, directory) ?? { symbol: id, decimals: 0, chain, usdPegged: false };
}

export function unitsToNumber(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}

export function numberToUnits(value: number, decimals: number): bigint {
  if (!Number.isFinite(value)) throw new RangeError(`cannot book the amount ${value}`);
  return BigInt(Math.round(value * 10 ** decimals));
}

/** Base units as a plain decimal: 930000 at eight decimals is "0.0093". */
export function formatUnits(amount: bigint, decimals: number): string {
  const sign = amount < 0n ? '-' : '';
  const digits = (amount < 0n ? -amount : amount).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? '' : digits.slice(-decimals).replace(/0+$/, '');
  return fraction === '' ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;
}
