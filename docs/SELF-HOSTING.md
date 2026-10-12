# Self-hosting

Holdfast reads a treasury with its viewing key, so whoever runs the server sees that treasury. Running it yourself removes that. There are two ways: Docker Compose, or Node and Postgres by hand.

Read [THREAT-MODEL.md](THREAT-MODEL.md) first. The person who runs the service is responsible for the master key, the scheduler and the backups.

## With Docker Compose

Needs Docker with Compose. It was run on x64; the native Zcash module also ships for arm64. Four containers come up:

| Service | Image | What it does |
|---|---|---|
| `db` | `postgres:17` | The database, in the volume `db-data` |
| `migrate` | built from the `Dockerfile` | Applies the migrations that are not applied yet and exits. The application starts only after it has exited with success |
| `web` | the same image | The application: API, pages and `POST /api/tick`, on port 3000 |
| `scheduler` | `busybox:1.36` | Calls `POST /api/tick` with the bearer secret, waits for the answer, sleeps 60 seconds, and starts again |

### Steps

1. Write the settings.

   ```
   cp .env.compose.example .env
   ```

   Fill in the seven required values. The file says how to make each: `openssl rand -hex 32` for the master key and the two secrets, a password of letters and digits for Postgres, the host name browsers will use, the network, and a new private key for the Tempo fee sponsor. `DATABASE_URL` is not set by hand; the compose file builds it from `POSTGRES_PASSWORD`.

2. Build and start.

   ```
   docker compose up --build -d
   ```

   The first build installs the workspace and builds the application. It takes a few minutes.

3. Check it.

   ```
   docker compose ps
   docker compose logs migrate
   curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/backtest/scorecard
   curl -s -X POST -H "Authorization: Bearer <TICK_SECRET>" http://localhost:3000/api/tick
   docker compose logs scheduler
   ```

   Expect `migrate` to have exited with code 0 after printing the migrations it applied, `200` from the scorecard, and from the tick a report such as `{"startedAt":1791824349651,"finishedAt":1791824349654,"orgs":[],"swaps":[],"attestations":[]}` while there is no organisation yet. Without the secret the tick endpoint answers 401. The scheduler logs one line a minute, `tick answered` or `tick failed`.

4. Open the application at the host you set, sign in with the wallet of your Hyperliquid account, and register an organisation with the treasury's viewing key.

### What was checked

On 12 October 2026, with Docker 29.5.2 and Compose 5.1.4 on x64: the image built; `migrate` applied the migrations and exited 0, and said `the database is up to date` when run a second time; `GET /api/backtest/scorecard` answered 200 with the nine scenarios; `GET /api/demo` answered 200 with an empty list; the landing page and `/demo` answered 200; `POST /api/tick` answered 401 without the secret and with a wrong one, and 200 with it; the scheduler logged `tick answered` once a minute; inside the `web` container the native Zcash module loaded and read the chain tip from `zec.rocks`; `pg_dump` of the database ran. Not run in this stack: a tick of an organisation with a funded treasury, a sign-in, a payout, an attestation.

### Signing in needs HTTPS

The session cookie is `Secure` and carries the `__Host-` prefix, and a request that changes state has to come from the host named in `HOLDFAST_PUBLIC_HOST`. For anything other than a trial on one machine, put a reverse proxy that terminates TLS in front of port 3000 and set `HOLDFAST_PUBLIC_HOST` to the name it serves, for example `holdfast.example`. The application is published on `127.0.0.1` only unless `HOLDFAST_BIND` says otherwise. Browsers differ on whether they keep a `Secure` cookie over plain `http://localhost`.

### Settings

`.env.compose.example` lists every setting, and [`apps/web/.env.example`](../apps/web/.env.example) says what each one means. Four need care.

- `HOLDFAST_MASTER_KEY` encrypts every stored viewing key and service key. Losing it loses them all. Back it up apart from the database.
- `TEMPO_SPONSOR_PRIVATE_KEY` is an account of your own that pays the fees of Tempo payouts. Make a new key for it and send its address fee tokens only.
- `SOLANA_MARKERS_FROM` is the slot from which every Solana payout of this deployment has set a run marker. Every payout made by this code sets one, so a deployment that has only ever run this code can use a finalized slot taken before its first payout run was created, and must never move it earlier. Left empty, the service still pays, but only after it has proved from the account's history that a run is unpaid, which a stranger can delay by sending dust to the account. To read the current finalized slot:

  ```
  curl -s https://api.mainnet-beta.solana.com -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getSlot","params":[{"commitment":"finalized"}]}'
  ```

- `HEDGE_ATTESTOR_ADDRESS` switches attestations on, on mainnet only. Set it to the address of a `HedgeAttestor` contract on HyperEVM; the one in [PROOF.md](PROOF.md) keeps a separate record for every account, or deploy your own from `contracts`. Nothing is recorded for an organisation until its owner has named the organisation's attester key on the contract, from the organisation's Hyperliquid account on HyperEVM; `GET /api/orgs/<id>/attestor` gives the key and the call. That account needs a little HYPE on HyperEVM for the call, and the attester key needs HYPE for the gas of every snapshot. `ATTEST_EVERY_MINUTES` sets the least time between two snapshots: 60 when empty, at least 5.

The public RPC endpoints of Tempo, Solana and HyperEVM and the public lightwalletd endpoints are the defaults. Set your own with `TEMPO_RPC_URL`, `SOLANA_RPC_URL`, `HYPEREVM_RPC_URL` and `ZCASH_ENDPOINTS`.

With `HOLDFAST_NETWORK=testnet` the payout rails use Tempo Moderato and Solana devnet, and `ZCASH_ENDPOINTS` has to be set. The ZEC perpetual is delisted on Hyperliquid's testnet, so the lock can be exercised on mainnet only.

### Upgrading, backups, removal

- Upgrade: fetch the new code and run `docker compose up --build -d` again. The `migrate` step applies whatever is new before the application restarts. Migrations are recorded by name and hash in `holdfast.migrations`; one that was changed after it was applied is refused.
- Back up the volume `db-data`, for example with `docker compose exec db pg_dump -U holdfast holdfast`, and the master key, each in its own place. The dump holds the journal and the treasury's scanned history in plain text.
- `docker compose down` stops everything and keeps the data. `docker compose down -v` also deletes the database.

### About the image

The base is `node:24-bookworm-slim`. It has to be a glibc system: the Zcash scanner, `@ledgerhq/zcash-utils`, is a native module that ships prebuilt for Linux on x64 and arm64 with glibc only, so Alpine does not work. The image keeps the whole workspace with its development dependencies, because the packages are used from their TypeScript sources and the migration step runs with `tsx`. It measured about 2 GB. The application runs as the user `node`.

Nothing from the working directory enters the image except `apps`, `packages` and the four workspace files at the root; `.dockerignore` names them. Files named `.env`, and folders named `out`, are left out wherever they are.

## Without Docker

Needs Node 24 or later, pnpm 9.15 and a Postgres database; 17 is what it was run on.

```
pnpm install
cp apps/web/.env.example apps/web/.env.local       # fill it in; Next.js reads this file
DATABASE_URL=postgres://user:password@host:5432/dbname pnpm --filter @holdfast/db exec tsx scripts/migrate.ts
pnpm --filter @holdfast/web build
pnpm --filter @holdfast/web start
```

`packages/db/scripts/migrate.ts` is the same script the compose file runs. It applies what is missing, prints what it applied, and exits 1 if the database could not be brought up to date. It is safe to run again.

Then have something call the tick endpoint once a minute. With cron:

```
* * * * * curl -fsS -X POST -H "Authorization: Bearer <TICK_SECRET>" http://127.0.0.1:3000/api/tick > /dev/null
```

`HOLDFAST_PUBLIC_HOST` is required once the application runs in production mode, which `start` does. The store keeps no session state and uses no named prepared statements, so it also works behind a transaction-mode pooler.

Of this path, the migration script was run from a workstation against Postgres 17. The build and the start were run inside the image above, on Linux.

## What a tick needs

A tick with nothing to do needs only the database. A tick of an organisation reaches out to a lightwalletd endpoint over gRPC, to `api.hyperliquid.xyz`, and to the price sources (Coinbase, Kraken and the swap service). Payouts reach the Tempo and Solana RPC endpoints, swaps reach `1click.chaindefuser.com`, and attestations reach the HyperEVM RPC endpoint. The server needs outbound HTTPS to all of them.

If ticks stop, nothing is decided: no orders, no top-up requests, no buy-backs. Watch the scheduler's log, or the age of the latest journal entry.
