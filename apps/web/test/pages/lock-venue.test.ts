import { describe, expect, it } from 'vitest';
import { parseAgents, parsePosition, readAgents, readPosition } from '../../src/server/pages/lock-venue';

const ACCOUNT = '0xC7e7BAAFb0C822d0A934BbB2268F15A7eD8485bc';
const AGENT = '0x677811d01c4250c2e3677a85b430a82f078c5928';

/** A `clearinghouseState` answer as Hyperliquid gives it for an account with one short. */
const STATE = {
  marginSummary: { accountValue: '10.900689' },
  assetPositions: [
    { type: 'oneWay', position: { coin: 'BTC', szi: '0.5', entryPx: '100000.0', positionValue: '50000.0', unrealizedPnl: '12.5', liquidationPx: null } },
    { type: 'oneWay', position: { coin: 'ZEC', szi: '-0.01', entryPx: '1226.4', positionValue: '12.386', unrealizedPnl: '-0.122', liquidationPx: '2217.7799047619' } },
  ],
  time: 1_791_828_976_469,
};

function venue(answers: Record<string, unknown>, seen: { url: string; body: unknown }[] = []): typeof fetch {
  return async (input, init) => {
    const body = JSON.parse(String(init?.body)) as { type: string };
    seen.push({ url: String(input), body });
    const answer = answers[body.type];
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

describe('the position as the venue states it', () => {
  it('picks the ZEC position out of the account’s positions', () => {
    expect(parsePosition(STATE)).toEqual({ szi: '-0.01', entryPx: 1226.4, positionValueUsd: 12.386, unrealizedPnlUsd: -0.122, liquidationPx: 2217.7799047619 });
  });

  it('answers null for an account with no ZEC position, and for one the venue has never seen', () => {
    expect(parsePosition({ assetPositions: [STATE.assetPositions[0]] })).toBeNull();
    expect(parsePosition({ assetPositions: [] })).toBeNull();
  });

  it('answers null for a position of size zero', () => {
    expect(parsePosition({ assetPositions: [{ position: { coin: 'ZEC', szi: '0.0', entryPx: '1.0', positionValue: '0.0', unrealizedPnl: '0.0' } }] })).toBeNull();
  });

  it('keeps a liquidation price the venue does not name as null', () => {
    const position = { coin: 'ZEC', szi: '-1.5', entryPx: '1000', positionValue: '1500', unrealizedPnl: '0', liquidationPx: null };
    expect(parsePosition({ assetPositions: [{ position }] })?.liquidationPx).toBeNull();
  });

  it('refuses an answer it cannot read instead of guessing a figure', () => {
    expect(() => parsePosition({})).toThrow(/without a list of positions/);
    expect(() => parsePosition({ assetPositions: [{ position: { coin: 'ZEC', szi: '-0.01', entryPx: 'a lot', positionValue: '1', unrealizedPnl: '0' } }] })).toThrow(/entry price/);
    expect(() => parsePosition({ assetPositions: ['nonsense'] })).toThrow(/cannot be read/);
  });

  it('asks the info endpoint of the deployment’s network for the account in lower case', async () => {
    const seen: { url: string; body: unknown }[] = [];
    const position = await readPosition({ network: 'testnet', fetch: venue({ clearinghouseState: STATE }, seen) }, ACCOUNT);
    expect(position?.entryPx).toBe(1226.4);
    expect(seen).toEqual([{ url: 'https://api.hyperliquid-testnet.xyz/info', body: { type: 'clearinghouseState', user: ACCOUNT.toLowerCase() } }]);
  });

  it('fails with the venue’s status when the venue does not answer 200', async () => {
    const down = venue({ clearinghouseState: new Response('rate limited', { status: 429 }) });
    await expect(readPosition({ network: 'mainnet', fetch: down }, ACCOUNT)).rejects.toThrow('Hyperliquid answered HTTP 429 to clearinghouseState');
  });

  it('fails without quoting anything when the venue cannot be reached', async () => {
    const unreachable: typeof fetch = async () => {
      throw new Error('getaddrinfo ENOTFOUND https://user:secret@rpc.example');
    };
    await expect(readPosition({ network: 'mainnet', fetch: unreachable }, ACCOUNT)).rejects.toThrow('Hyperliquid could not be reached');
  });

  it('asks nothing for something that is not an account address', async () => {
    const seen: { url: string; body: unknown }[] = [];
    await expect(readPosition({ network: 'mainnet', fetch: venue({}, seen) }, 'not-an-address')).rejects.toThrow('not an address');
    expect(seen).toEqual([]);
  });
});

describe('the agents an account has approved', () => {
  it('reads each agent with its name, its address in lower case and its expiry', () => {
    expect(parseAgents([{ name: 'holdfast', address: '0x677811D01C4250C2E3677A85B430A82F078C5928', validUntil: 1_799_441_536_338 }])).toEqual([{ name: 'holdfast', address: AGENT, validUntil: 1_799_441_536_338 }]);
  });

  it('keeps an approval with no expiry as one with none', () => {
    expect(parseAgents([{ name: 'bot', address: AGENT }])).toEqual([{ name: 'bot', address: AGENT, validUntil: null }]);
  });

  it('reads an account with no agents as an empty list', async () => {
    expect(await readAgents({ network: 'mainnet', fetch: venue({ extraAgents: [] }) }, ACCOUNT)).toEqual([]);
  });

  it('refuses an answer that is not a list of agents', () => {
    expect(() => parseAgents({ agents: [] })).toThrow(/other than a list/);
    expect(() => parseAgents([{ name: 'holdfast', address: 'somewhere' }])).toThrow(/cannot be read/);
  });
});
