import type { Bar } from '@holdfast/core';
import { PgStore, connect } from '@holdfast/db';
import { createOneClick, createReferencePrice } from '@holdfast/intents';
import { checkUfvk, createTreasuryScanner } from '@holdfast/zcash';
import { hyperliquidPort } from './adapters/hyperliquid';
import { solanaPort } from './adapters/solana';
import { tempoPort } from './adapters/tempo';
import { type Env, readConfig } from './config';
import type { Deps } from './deps';
import { createRedactor } from './redact';

function once<T>(make: () => T): () => T {
  let made: { value: T } | undefined;
  return () => {
    made ??= { value: make() };
    return made.value;
  };
}

/**
 * The real dependencies, from the environment. Nothing is built or read until
 * it is first used: a route that needs no database works without
 * DATABASE_URL, and one that does fails with a message naming the variable.
 */
export function createRuntime(env: Env): Deps {
  const config = readConfig(env);

  const store = once(() => new PgStore(connect(config.databaseUrl()).db, { masterKey: config.masterKey() }));
  const scanner = once(() => createTreasuryScanner({ network: config.network(), endpoints: config.zcashEndpoints() }));
  const zcash = once(() => {
    const network = config.network();
    return { network, check: (ufvk: string) => checkUfvk(ufvk, network), scanner };
  });
  const hyperliquid = once(() => hyperliquidPort(config.network()));
  const reference = once(() => createReferencePrice());
  const oneClick = once(() => {
    const apiKey = config.oneClickApiKey();
    return createOneClick(apiKey === undefined ? {} : { apiKey });
  });
  const tempo = once(() => tempoPort(config.tempo(), config.tempoSponsorPrivateKey));
  const solana = once(() => solanaPort(config.solana()));
  // The market data ships inside the core package, beside its sources.
  const bars = once(async () => (await import('../../../../packages/core/data/zec-1h.json')).default.bars as Bar[]);

  return {
    now: Date.now,
    redact: createRedactor(config.secrets),
    knownSecrets: config.secrets,
    report: (message) => console.error(`[holdfast] ${message}`),
    get network() {
      return config.network();
    },
    secrets: {
      get session() {
        return config.sessionSecret();
      },
      get tick() {
        return config.tickSecret();
      },
    },
    get publicHost() {
      return config.publicHost();
    },
    get store() {
      return store();
    },
    get zcash() {
      return zcash();
    },
    get hyperliquid() {
      return hyperliquid();
    },
    get reference() {
      return reference();
    },
    get oneClick() {
      return oneClick();
    },
    get tempo() {
      return tempo();
    },
    get solana() {
      return solana();
    },
    bars,
  };
}

let shared: Deps | undefined;

/** The one set of dependencies this process serves requests with. */
export function runtime(): Deps {
  shared ??= createRuntime(process.env);
  return shared;
}
