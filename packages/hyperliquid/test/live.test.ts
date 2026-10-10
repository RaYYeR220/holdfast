import { describe, expect, it } from 'vitest';
import { createHedgeVenue } from '../src/index';

/**
 * Read-only checks against Hyperliquid mainnet. Off by default:
 *
 *   HL_LIVE=1 pnpm --filter @holdfast/hyperliquid test live
 *
 * HL_LIVE_STANDARD_USER and HL_LIVE_UNIFIED_USER replace the default accounts,
 * which are public addresses that were active on ZEC when this was written.
 */
const live = process.env.HL_LIVE === '1';
const STANDARD_USER = process.env.HL_LIVE_STANDARD_USER ?? '0xda22459d4776c240e9182be9e569f07617cef664';
const UNIFIED_USER = process.env.HL_LIVE_UNIFIED_USER ?? '0x675f8db17321f1b8371a575ea750f26034a84d69';
const MAX_CLOCK_GAP_MS = 60_000;

describe.runIf(live)('live mainnet, read only', { timeout: 30_000 }, () => {
  const venue = createHedgeVenue({ network: 'mainnet' });

  async function rawInfo(body: Record<string, unknown>): Promise<unknown> {
    const response = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.json();
  }

  it('reads the state of a standard account', async () => {
    const state = await venue.state(STANDARD_USER);
    console.log('standard account', STANDARD_USER, state);

    expect(state.coin).toBe('ZEC');
    expect(Number.isInteger(state.shortLots)).toBe(true);
    expect(state.markPx).toBeGreaterThan(0);
    expect(state.oraclePx).toBeGreaterThan(0);
    expect(Math.abs(state.markPx / state.oraclePx - 1)).toBeLessThan(0.05);
    expect(Number.isFinite(state.accountValueUsd)).toBe(true);
    expect(Math.abs(Date.now() - state.asOf)).toBeLessThan(MAX_CLOCK_GAP_MS);
  });

  it('reads a unified account from its spot balance', async () => {
    const [state, spot, perp] = await Promise.all([
      venue.state(UNIFIED_USER),
      rawInfo({ type: 'spotClearinghouseState', user: UNIFIED_USER }) as Promise<{
        balances: { coin: string; total: string }[];
      }>,
      rawInfo({ type: 'clearinghouseState', user: UNIFIED_USER }) as Promise<{
        marginSummary: { accountValue: string };
      }>,
    ]);
    const spotUsdc = Number(spot.balances.find((balance) => balance.coin === 'USDC')?.total ?? 0);
    console.log('unified account', UNIFIED_USER, state, {
      spotUsdcTotal: spotUsdc,
      perpAccountValue: Number(perp.marginSummary.accountValue),
    });

    expect(state.mode).toBe('unified');
    expect(Number.isInteger(state.shortLots)).toBe(true);
    // Two reads a moment apart: equal up to the PnL of that moment.
    expect(Math.abs(state.accountValueUsd - spotUsdc)).toBeLessThan(Math.max(1, Math.abs(spotUsdc) * 0.02));
  });

  it('reads the trailing 72 hour funding rate of ZEC', async () => {
    const aprBps = await venue.fundingAprBps(72);
    console.log('ZEC funding, trailing 72h:', aprBps, 'bps APR to shorts');

    expect(Number.isInteger(aprBps)).toBe(true);
    // Hyperliquid caps hourly funding at 4%, which bounds the annualised figure.
    expect(Math.abs(aprBps)).toBeLessThan(0.04 * 24 * 365 * 10_000);
  });

  it('reads funding payments and fills for the books', async () => {
    const since = Date.now() - 24 * 3_600_000;
    const [funding, fills] = await Promise.all([venue.userFunding(STANDARD_USER, since), venue.userFills(STANDARD_USER, since)]);
    console.log('last 24h:', funding.length, 'funding payments,', fills.length, 'fills');
    if (funding[0] !== undefined) console.log('first funding payment', funding[0]);
    if (fills[0] !== undefined) console.log('first fill', fills[0]);

    for (const payment of funding) expect(payment.time).toBeGreaterThanOrEqual(since);
    for (const fill of fills) {
      expect(fill.time).toBeGreaterThanOrEqual(since);
      expect(fill.size).toBeGreaterThan(0);
      expect(fill.px).toBeGreaterThan(0);
    }
  });
});
