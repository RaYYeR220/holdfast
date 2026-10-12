import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ZEC_PERP, readConfig } from '../src/server/config';
import { ConfigError } from '../src/server/errors';
import { createRedactor } from '../src/server/redact';
import { createRuntime } from '../src/server/runtime';
import { UFVK } from './support/world';

const MASTER_HEX = 'ab'.repeat(32);
const VALID = {
  DATABASE_URL: 'postgres://holdfast:db-password-that-must-not-leak@db.example.test:6543/postgres',
  HOLDFAST_MASTER_KEY: MASTER_HEX,
  TICK_SECRET: 'tick-secret-0123456789-0123456789-01',
  SESSION_SECRET: 'session-secret-0123456789-0123456789',
  HOLDFAST_NETWORK: 'mainnet',
  TEMPO_SPONSOR_PRIVATE_KEY: `0x${'5b'.repeat(32)}`,
};

const failure = (read: () => unknown): ConfigError => {
  try {
    read();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('nothing was thrown');
};

describe('configuration', () => {
  it('reads every required setting', () => {
    const config = readConfig(VALID);
    expect(config.network()).toBe('mainnet');
    expect(config.databaseUrl()).toBe(VALID.DATABASE_URL);
    expect(config.masterKey()).toEqual(new Uint8Array(32).fill(0xab));
    expect(config.tickSecret()).toBe(VALID.TICK_SECRET);
    expect(new TextDecoder().decode(config.sessionSecret())).toBe(VALID.SESSION_SECRET);
    expect(config.tempoSponsorPrivateKey()).toBe(VALID.TEMPO_SPONSOR_PRIVATE_KEY);
  });

  it('needs the public host in production and takes nothing else for it', () => {
    expect(readConfig(VALID).publicHost()).toBeNull();
    expect(readConfig({ ...VALID, HOLDFAST_PUBLIC_HOST: 'Holdfast.Example' }).publicHost()).toBe('holdfast.example');
    expect(readConfig({ ...VALID, HOLDFAST_PUBLIC_HOST: 'localhost:3000' }).publicHost()).toBe('localhost:3000');
    expect(failure(() => readConfig({ ...VALID, NODE_ENV: 'production' }).publicHost()).message).toContain('HOLDFAST_PUBLIC_HOST');
    for (const wrong of ['https://holdfast.example', 'holdfast.example/app', 'holdfast.example:', 'two hosts', '-.example']) {
      expect(failure(() => readConfig({ ...VALID, HOLDFAST_PUBLIC_HOST: wrong }).publicHost()).message).toContain('HOLDFAST_PUBLIC_HOST');
    }
  });

  it('takes the master key as base64 too', () => {
    const base64 = Buffer.from(MASTER_HEX, 'hex').toString('base64');
    expect(readConfig({ ...VALID, HOLDFAST_MASTER_KEY: base64 }).masterKey()).toEqual(new Uint8Array(32).fill(0xab));
  });

  it('fails only when a setting is first used, and names the variable that is missing', () => {
    const config = readConfig({ HOLDFAST_NETWORK: 'testnet' });
    expect(config.network()).toBe('testnet');
    for (const [read, variable] of [
      [config.databaseUrl, 'DATABASE_URL'],
      [config.masterKey, 'HOLDFAST_MASTER_KEY'],
      [config.tickSecret, 'TICK_SECRET'],
      [config.sessionSecret, 'SESSION_SECRET'],
      [config.tempoSponsorPrivateKey, 'TEMPO_SPONSOR_PRIVATE_KEY'],
    ] as const) {
      const error = failure(read);
      expect(error.variable).toBe(variable);
      expect(error.message).toBe(`${variable} is not set`);
    }
    expect(failure(readConfig({ HOLDFAST_NETWORK: '  ' }).network).message).toBe('HOLDFAST_NETWORK is not set');
  });

  it('names the variable that is malformed, and never repeats its value', () => {
    const cases: [Record<string, string>, (config: ReturnType<typeof readConfig>) => unknown, string][] = [
      [{ HOLDFAST_NETWORK: 'main' }, (c) => c.network(), 'HOLDFAST_NETWORK must be one of: mainnet, testnet'],
      [{ DATABASE_URL: 'db.example.test/secret-path' }, (c) => c.databaseUrl(), 'DATABASE_URL is not a URL'],
      [{ DATABASE_URL: 'https://db.example.test/secret-path' }, (c) => c.databaseUrl(), 'DATABASE_URL must be a postgres:// or postgresql:// URL'],
      [{ HOLDFAST_MASTER_KEY: 'too-short-to-be-a-key' }, (c) => c.masterKey(), 'HOLDFAST_MASTER_KEY must be 32 bytes, written as 64 hex characters or as base64'],
      [{ TICK_SECRET: 'short-tick-secret' }, (c) => c.tickSecret(), 'TICK_SECRET must be at least 32 characters'],
      [{ SESSION_SECRET: 'short-session-secret' }, (c) => c.sessionSecret(), 'SESSION_SECRET must be at least 32 characters'],
      [{ TEMPO_SPONSOR_PRIVATE_KEY: '0x1234secret' }, (c) => c.tempoSponsorPrivateKey(), 'TEMPO_SPONSOR_PRIVATE_KEY must be a 32-byte private key written as 0x and 64 hex characters'],
      [{ TEMPO_NETWORK: 'devnet' }, (c) => c.tempo(), 'TEMPO_NETWORK must be one of: mainnet, moderato'],
      [{ TEMPO_TOKEN: '0x20c0' }, (c) => c.tempo(), 'TEMPO_TOKEN is not a token address'],
      [{ TEMPO_RPC_URL: 'ftp://rpc.example.test/key' }, (c) => c.tempo(), 'TEMPO_RPC_URL must be a https:// or http:// URL'],
      [{ SOLANA_CLUSTER: 'testnet' }, (c) => c.solana(), 'SOLANA_CLUSTER must be one of: mainnet-beta, devnet'],
      [{ SOLANA_MINT: 'bogus-mint!' }, (c) => c.solana(), 'SOLANA_MINT is not a mint address'],
      [{ SOLANA_MINT_DECIMALS: '6.5' }, (c) => c.solana(), 'SOLANA_MINT_DECIMALS must be a whole number from 0 to 18'],
      [{ SOLANA_MARKERS_FROM: 'slot-412' }, (c) => c.solana(), 'SOLANA_MARKERS_FROM must be a slot number'],
      [{ ZCASH_ENDPOINTS: ' , ' }, (c) => c.zcashEndpoints(), 'ZCASH_ENDPOINTS lists no endpoint'],
    ];
    for (const [over, read, message] of cases) {
      const error = failure(() => read(readConfig({ ...VALID, ...over })));
      expect(error.message).toBe(message);
      for (const value of Object.values(over)) if (value.trim().length > 4) expect(error.message).not.toContain(value);
    }
  });

  it('follows the network for everything that was not set', () => {
    const mainnet = readConfig(VALID);
    expect(mainnet.zcashEndpoints()).toEqual(['https://zec.rocks:443', 'https://na.zec.rocks:443', 'https://eu.zec.rocks:443']);
    expect(mainnet.tempo()).toEqual({ network: 'mainnet', rpcUrl: undefined, token: '0x20C000000000000000000000b9537d11c60E8b50', tokenSymbol: 'USDC.e' });
    expect(mainnet.solana()).toEqual({ cluster: 'mainnet-beta', rpcUrl: 'https://api.mainnet-beta.solana.com', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, tokenSymbol: 'USDC' });
    expect(mainnet.oneClickApiKey()).toBeUndefined();

    const testnet = readConfig({ ...VALID, HOLDFAST_NETWORK: 'testnet' });
    expect(testnet.tempo()).toMatchObject({ network: 'moderato', tokenSymbol: 'AlphaUSD' });
    expect(testnet.solana()).toMatchObject({ cluster: 'devnet', rpcUrl: 'https://api.devnet.solana.com', mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' });
    expect(failure(testnet.zcashEndpoints).message).toBe('ZCASH_ENDPOINTS is not set, and no public lightwalletd endpoint is known for testnet');
  });

  it('lets the payout chains be pointed elsewhere than the treasury chain', () => {
    const config = readConfig({
      ...VALID,
      ZCASH_ENDPOINTS: 'https://lwd-1.example.test:443, https://lwd-2.example.test:443',
      TEMPO_NETWORK: 'moderato',
      TEMPO_RPC_URL: 'https://rpc.example.test/tempo',
      TEMPO_TOKEN: '0x20c0000000000000000000000000000000000002',
      SOLANA_CLUSTER: 'devnet',
      SOLANA_RPC_URL: 'https://rpc.example.test/solana',
      SOLANA_MINT: 'So11111111111111111111111111111111111111112',
      SOLANA_MINT_DECIMALS: '9',
      SOLANA_MARKERS_FROM: '412000111',
      ONECLICK_API_KEY: 'partner-key',
    });
    expect(config.zcashEndpoints()).toEqual(['https://lwd-1.example.test:443', 'https://lwd-2.example.test:443']);
    expect(config.tempo()).toEqual({ network: 'moderato', rpcUrl: 'https://rpc.example.test/tempo', token: '0x20C0000000000000000000000000000000000002', tokenSymbol: 'BetaUSD' });
    expect(config.solana()).toEqual({ cluster: 'devnet', rpcUrl: 'https://rpc.example.test/solana', mint: 'So11111111111111111111111111111111111111112', decimals: 9, tokenSymbol: 'So11111111111111111111111111111111111111112', markersFrom: 412_000_111n });
    expect(config.oneClickApiKey()).toBe('partner-key');
  });

  it('lists what must never be shown, whether or not it is well formed', () => {
    const config = readConfig({ ...VALID, TICK_SECRET: 'short', SOLANA_RPC_URL: 'https://rpc.example.test/v2/rpc-key', ONECLICK_API_KEY: 'partner-key', HYPEREVM_RPC_URL: 'https://rpc.example.test/evm/rpc-key' });
    expect(config.secrets().sort()).toEqual(
      [VALID.DATABASE_URL, VALID.HOLDFAST_MASTER_KEY, 'short', VALID.SESSION_SECRET, VALID.TEMPO_SPONSOR_PRIVATE_KEY, 'partner-key', 'https://rpc.example.test/v2/rpc-key', 'https://rpc.example.test/evm/rpc-key'].sort(),
    );
  });

  describe('of the attestations', () => {
    const CONTRACT = '0xa6afa5c68146bbd4c49510987847c7c38837824e';

    it('records none unless a contract is named, and then needs nothing else', () => {
      expect(readConfig(VALID).attestor()).toBeNull();
      expect(readConfig({ ...VALID, HEDGE_ATTESTOR_ADDRESS: '  ' }).attestor()).toBeNull();
      // Without a contract the other two are not even looked at, and neither is the network.
      expect(readConfig({ HYPEREVM_RPC_URL: 'not a url', ATTEST_EVERY_MINUTES: 'often' }).attestor()).toBeNull();

      expect(readConfig({ ...VALID, HEDGE_ATTESTOR_ADDRESS: CONTRACT }).attestor()).toEqual({
        chainId: 999,
        rpcUrl: 'https://rpc.hyperliquid.xyz/evm',
        contract: '0xa6aFA5c68146BbD4C49510987847C7C38837824E',
        perp: { index: 214, szDecimals: 2 },
        everyMinutes: 60,
      });
    });

    it('takes another endpoint and another interval', () => {
      const config = readConfig({ ...VALID, HEDGE_ATTESTOR_ADDRESS: CONTRACT, HYPEREVM_RPC_URL: 'https://rpc.example.test/evm', ATTEST_EVERY_MINUTES: '5' });
      expect(config.attestor()).toMatchObject({ rpcUrl: 'https://rpc.example.test/evm', everyMinutes: 5 });
    });

    it('records none on testnet, where the contract is not deployed', () => {
      expect(readConfig({ ...VALID, HOLDFAST_NETWORK: 'testnet', HEDGE_ATTESTOR_ADDRESS: CONTRACT }).attestor()).toBeNull();
      expect(ZEC_PERP).toEqual({ mainnet: { index: 214, szDecimals: 2 }, testnet: { index: 193, szDecimals: 0 } });
    });

    it('names the variable that is malformed, and never repeats its value', () => {
      const cases: [Record<string, string>, string][] = [
        [{ HEDGE_ATTESTOR_ADDRESS: '0xa6afa5c68146bbd4c49510987847c7c3883782' }, 'HEDGE_ATTESTOR_ADDRESS is not a contract address'],
        [{ HEDGE_ATTESTOR_ADDRESS: '0xA6AFA5c68146bbd4c49510987847c7c38837824e' }, 'HEDGE_ATTESTOR_ADDRESS is not a contract address'],
        [{ HEDGE_ATTESTOR_ADDRESS: CONTRACT, HYPEREVM_RPC_URL: 'wss://rpc.example.test/evm/rpc-key' }, 'HYPEREVM_RPC_URL must be a https:// or http:// URL'],
        [{ HEDGE_ATTESTOR_ADDRESS: CONTRACT, ATTEST_EVERY_MINUTES: '4' }, 'ATTEST_EVERY_MINUTES must be a whole number of minutes, at least 5'],
        [{ HEDGE_ATTESTOR_ADDRESS: CONTRACT, ATTEST_EVERY_MINUTES: '7.5' }, 'ATTEST_EVERY_MINUTES must be a whole number of minutes, at least 5'],
        [{ HEDGE_ATTESTOR_ADDRESS: CONTRACT, ATTEST_EVERY_MINUTES: 'hourly' }, 'ATTEST_EVERY_MINUTES must be a whole number of minutes, at least 5'],
      ];
      for (const [over, message] of cases) {
        const error = failure(() => readConfig({ ...VALID, ...over }).attestor());
        expect(error.message).toBe(message);
        for (const value of Object.values(over)) if (value.length > 6) expect(error.message).not.toContain(value);
      }
    });
  });

  it('has every variable it reads written down in .env.example, with no value', () => {
    const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    const assignments = example.split('\n').filter((line) => /^[A-Z_]+=/.test(line));
    expect(assignments.every((line) => line.endsWith('='))).toBe(true);
    expect(assignments.map((line) => line.slice(0, -1)).sort()).toEqual(
      [
        'ATTEST_EVERY_MINUTES',
        'DATABASE_URL',
        'HEDGE_ATTESTOR_ADDRESS',
        'HOLDFAST_MASTER_KEY',
        'HOLDFAST_NETWORK',
        'HOLDFAST_PUBLIC_HOST',
        'HYPEREVM_RPC_URL',
        'ONECLICK_API_KEY',
        'SESSION_SECRET',
        'SOLANA_CLUSTER',
        'SOLANA_MARKERS_FROM',
        'SOLANA_MINT',
        'SOLANA_MINT_DECIMALS',
        'SOLANA_RPC_URL',
        'TEMPO_NETWORK',
        'TEMPO_RPC_URL',
        'TEMPO_SPONSOR_PRIVATE_KEY',
        'TEMPO_TOKEN',
        'TICK_SECRET',
        'ZCASH_ENDPOINTS',
      ].sort(),
    );
  });
});

describe('the runtime', () => {
  it('builds nothing until it is used, and then says which variable it lacks', () => {
    const deps = createRuntime({ HOLDFAST_NETWORK: 'mainnet' });
    expect(deps.network).toBe('mainnet');
    expect(deps.hyperliquid.network).toBe('mainnet');
    expect(failure(() => deps.store).message).toBe('DATABASE_URL is not set');
    expect(failure(() => deps.secrets.session).message).toBe('SESSION_SECRET is not set');
    expect(failure(() => deps.secrets.tick).message).toBe('TICK_SECRET is not set');
    // The Tempo rail is described without the sponsor key; making one needs it.
    expect(deps.tempo.tokenSymbol).toBe('USDC.e');
    expect(failure(() => deps.tempo.rail(`0x${'11'.repeat(32)}`)).message).toBe('TEMPO_SPONSOR_PRIVATE_KEY is not set');
  });

  it('has no attestor unless a contract is named, and builds one without touching the network when it is', () => {
    expect(createRuntime({ HOLDFAST_NETWORK: 'mainnet' }).attestor).toBeNull();
    expect(createRuntime({}).attestor).toBeNull();
    const attestor = createRuntime({ HOLDFAST_NETWORK: 'mainnet', HEDGE_ATTESTOR_ADDRESS: '0xa6afa5c68146bbd4c49510987847c7c38837824e', ATTEST_EVERY_MINUTES: '15' }).attestor;
    expect(attestor).toMatchObject({ chainId: 999, contract: '0xa6aFA5c68146BbD4C49510987847C7C38837824E', perp: { index: 214, szDecimals: 2 }, everyMs: 15 * 60_000 });
    expect(failure(() => createRuntime({ HOLDFAST_NETWORK: 'mainnet', HEDGE_ATTESTOR_ADDRESS: 'nowhere' }).attestor).message).toBe('HEDGE_ATTESTOR_ADDRESS is not a contract address');
  });

  it('serves the market data without any setting at all', async () => {
    const bars = await createRuntime({}).bars();
    expect(bars.length).toBeGreaterThan(4_000);
    expect(bars[0]).toMatchObject({ t: 1_773_630_000_000, o: 229.37 });
  });
});

describe('redaction', () => {
  const redact = createRedactor(() => ['https://rpc.example.test/v2/rpc-key-1', 'rpc-key-1', 'tiny', VALID.TICK_SECRET]);

  it('removes viewing keys by their shape and configured secrets by their value', () => {
    const text = `scan of ${UFVK} failed at https://rpc.example.test/v2/rpc-key-1 with token ${VALID.TICK_SECRET}`;
    expect(redact(text)).toBe('scan of [viewing key] failed at [redacted] with token [redacted]');
  });

  it('replaces a secret that contains another one whole', () => {
    expect(redact('POST https://rpc.example.test/v2/rpc-key-1 and again rpc-key-1')).toBe('POST [redacted] and again [redacted]');
  });

  it('leaves alone a value too short to tell from an ordinary word', () => {
    expect(redact('a tiny problem')).toBe('a tiny problem');
  });
});
