# For judges: five minutes

Holdfast is a treasury autopilot for teams paid in ZEC. The claim to check is narrow: the service never holds a key that can move the team's money past a limit the chain enforces, and the record shows each key that can sign failing when it tries.

## What to open, in order

A three-minute video of the live product: https://youtu.be/QaSax6chlrE

1. The live demo, one minute. https://holdfast-iota.vercel.app/demo is the demo organisation: a real treasury of a few dollars on mainnet. The same data as JSON: [overview](https://holdfast-iota.vercel.app/api/demo/demo/overview), [keys and refusals](https://holdfast-iota.vercel.app/api/demo/demo/safety), [journal](https://holdfast-iota.vercel.app/api/demo/demo/journal). The journal gains one entry a minute.
2. Three refusals, one minute.
   - Tempo, a payment above the key's limit, included and reverted with `SpendingLimitExceeded`: [`0x2246d81e…acb9bce9`](https://explore.tempo.xyz/tx/0x2246d81e18fa8269c799855079e7e9ec3cabec80430b62aedd040ab9acb9bce9)
   - Solana, a transfer one unit above the allowance, failed with Token program error `0x1`: [`5UpRY36z…wQiZq99`](https://solscan.io/tx/5UpRY36zNFBVJo6VwRsCUJmnEQbvxs2R1xCZzmSU2RNGBLSUALwWeHPPSH3MKK8ZroXEY3MsuiSaquoZjwQiZq99)
   - Hyperliquid, a withdrawal signed by the agent key. There is no transaction to open: the exchange answered `Must deposit before performing actions. User: 0x677811d01c4250c2e3677a85b430a82f078c5928`, naming the agent's own empty account. See [PROOF 3](docs/PROOF.md#3-hyperliquid-the-lock-and-the-agent-key-failing-to-withdraw).
3. The hedge on HyperEVM, one minute. [`HedgeAttestor`](https://hyperevmscan.io/address/0xa6afa5c68146bbd4c49510987847c7c38837824e) stores what HyperCore reported for the team's account, a short of 0.01 ZEC, beside the root of the controller's journal. One `cast call` in [PROOF 7](docs/PROOF.md#7-hyperliquid-hyperevm-the-hedge-attested-on-chain) confirms that the journal entry which opened the short is under that root.
4. The scorecard, one minute. The table in the [README](README.md#backtest-scorecard), including scenario 4, the control in which the lock fails.
5. Everything else is in [docs/PROOF.md](docs/PROOF.md): every transaction, in the order it happened.

## What was built on each chain

### Zcash

| Built on the chain's own primitives | Code | Mainnet |
|---|---|---|
| A shielded treasury read with a unified full viewing key over lightwalletd: Sapling, Orchard and Ironwood notes, memos, spends followed by nullifier, the last 20 blocks re-read on every pass | `packages/zcash/src/scanner.ts`, `packages/engine/src/tick.ts` | A shielded payment of 0.01975 ZEC with a memo: [`27472243…e6ff84`](https://mainnet.zcashexplorer.app/transactions/27472243738462004e72b46b2b2f3ba20318d36d3ee1f0fbcb93ef5aa2e6ff84) |
| The only Zcash key the service accepts is a viewing key; a spending key or a seed phrase is refused by its shape, and viewing keys are redacted from the scanner's error messages | `packages/zcash/src/ufvk.ts`, `packages/zcash/src/scanner.ts` | |
| Every movement of ZEC is a ZIP-321 payment request for the treasurer's wallet; the service builds no Zcash transaction | `packages/zcash/src/zip321.ts`, `apps/web/src/server/funding/service.ts` | The treasurer's payment of 0.0093 ZEC into a swap: [`2b3865fb…c00a7e`](https://mainnet.zcashexplorer.app/transactions/2b3865fbbd334d4db4d1da760d2d8be30c72a89368e3bb6fbf7f2c9b42c00a7e) |
| Books derived from what the viewing key shows, and a tool that scans again to check them | `packages/books/src/sources/zcash.ts`, `apps/cli/src/verify/zcash.ts` | The published key: [`demo/treasury.ufvk`](demo/treasury.ufvk) |

### Hyperliquid, HyperCore and HyperEVM

| Built on the chain's own primitives | Code | Mainnet |
|---|---|---|
| HyperCore: an agent wallet the owner approves once (`approveAgent`), trading a short ZEC perpetual on the team's own account | `packages/hyperliquid/src/signing.ts`, `packages/hyperliquid/src/venue.ts` | Order `570748779376`, 0.01 ZEC sold at 1,226.40, on the [account page](https://app.hyperliquid.xyz/explorer/address/0xC7e7BAAFb0C822d0A934BbB2268F15A7eD8485bc) |
| HyperCore: immediate-or-cancel orders with a client order id derived from the journal entry; the id is looked up before anything is sent, so a retried tick cannot trade twice | `packages/hyperliquid/src/orders.ts`, `packages/engine/src/tick.ts` | Client order id `0xd5ce6801a6783b879b84d9c8a4be53ab` |
| HyperCore: the agent key signs a withdrawal and a transfer, and both refusals are kept as received | `packages/hyperliquid/src/probe.ts` | [PROOF 3](docs/PROOF.md#3-hyperliquid-the-lock-and-the-agent-key-failing-to-withdraw) |
| HyperCore: margin arrives as USDC on the team's account from a NEAR Intents swap the treasurer pays in ZEC | `packages/intents/src/oneclick.ts` | 11.020977 USDC: [`0xa5294456…745e10`](https://app.hyperliquid.xyz/explorer/tx/0xa52944568cd2b32e48f277ee1c8728746036fc0b6f264fb009ab68e595745e10) |
| HyperEVM: `HedgeAttestor` reads the position, the mark price, the oracle price and the HyperCore block through the read precompiles (`0x…0813`, `0x…0806`, `0x…0807`, `0x…0809`) and stores them with the journal's Merkle root. No owner, no upgrades, no funds | `contracts/src/HedgeAttestor.sol`, `packages/attest/src`, `apps/web/src/server/attestations/service.ts` | Contract [`0xa6aFA5c6…37824E`](https://hyperevmscan.io/address/0xa6afa5c68146bbd4c49510987847c7c38837824e), attester named in [`0x95820bd3…cf3f684e`](https://hyperevmscan.io/tx/0x95820bd326fcda3c4161dca33de852a29241cca640376b1b2ff6e817cf3f684e), first snapshot in [`0xfeaf1ab2…8a47a5e7`](https://hyperevmscan.io/tx/0xfeaf1ab22f67efe059397765f55afaa109c04e35368d323903411a768a47a5e7) |

### Tempo

| Built on the chain's own primitives | Code | Mainnet |
|---|---|---|
| An Account Keychain access key: the root signs an authorization with an expiry, a spending limit per period, a call scope of `transferWithMemo` on one stablecoin and a list of recipients. The authorization is checked against the terms the treasurer was shown before it is submitted | `packages/tempo/src/authorization.ts`, `packages/tempo/src/key-status.ts` | 2.00 USDC per 30 days, two recipients: [`0x81f9baee…650f3bee`](https://explore.tempo.xyz/tx/0x81f9baee53e61777d4b532e16e61726755263c2112e387bbb2e65f62650f3bee) |
| A payout run is one transaction of up to 32 `transferWithMemo` calls, signed by the access key on its own nonce lane, valid for 60 seconds, with the fee paid by a separate sponsor | `packages/tempo/src/rail.ts`, `packages/tempo/src/preflight.ts` | Run `HF-2026-10-0001`, two lines: [`0x379f560f…c3fe53e9`](https://explore.tempo.xyz/tx/0x379f560f0c9a053e2a1b117fab40ac5d84371c68d188c2583be015eac3fe53e9) |
| The run id is on chain in the memos, which the token emits as indexed event topics. Paying the same run again finds it and sends nothing | `packages/tempo/src/memo.ts`, `packages/tempo/src/log-search.ts`, `packages/tempo/src/receipt.ts` | "The same run again" in [PROOF 4](docs/PROOF.md#4-tempo-payroll-through-a-key-with-a-limit) |
| Two probes sent without simulation, so the chain records the refusal | `packages/tempo/src/rail.ts` (`probeOverLimit`, `probeOutOfScope`) | `SpendingLimitExceeded`: [`0x2246d81e…acb9bce9`](https://explore.tempo.xyz/tx/0x2246d81e18fa8269c799855079e7e9ec3cabec80430b62aedd040ab9acb9bce9). `CallNotAllowed`: [`0x80b065d2…7d587d11`](https://explore.tempo.xyz/tx/0x80b065d23f17bc54495e2d92eb9e15980f68d50e39f6e83ae142f2ed7d587d11) |
| Revocation by the account's root | `packages/tempo/src/authorization.ts` (`buildRevoke`) | A second key authorized and revoked: [`0xeb1fbb1b…d217b6f7`](https://explore.tempo.xyz/tx/0xeb1fbb1b3aa233c9cd24806704cf53a465484e06a0516ac2e2c335d8d217b6f7), [`0x32e9a47b…6ebe353c`](https://explore.tempo.xyz/tx/0x32e9a47b2b1997cc21aac5a842d4ba92c2636623d3730dae9b0cd9bb6ebe353c) |

### Solana

| Built on the chain's own primitives | Code | Mainnet |
|---|---|---|
| An SPL Token delegate: the team's wallet signs `ApproveChecked` for a fixed amount on its USDC account, and `Revoke` to take it back. Both transactions are built for the wallet; the service never asks for the wallet's key | `packages/solana/src/approval.ts` | Approval for 1.50 USDC: [`2F3FFe43…ZQQGJNu`](https://solscan.io/tx/2F3FFe43v2yBMA3M5DEyRfE7wDpatryTqjZnhaS4ndWHif5JuoGtvRSAsT7vfsskxDsGWFhgbAesZ1wQ6ZQQGJNu). Revocation: [`2naSHkBj…aMtkW5Su`](https://solscan.io/tx/2naSHkBjJeyd8bxKqFMoHEQBQMYwyk2rc37uRiwWRjPK8eV86X2t4LLworyKrMNgtEekU5sjr3PaqWZhaMtkW5Su) |
| A payout run is one transaction: a memo with the run id and each line's reference, one `TransferChecked` per line by the delegate, and token accounts created for new payees, at most three per run | `packages/solana/src/payout.ts`, `packages/solana/src/prepare.ts` | Run `HF-2026-10-0003`, two lines: [`4kLtT81s…fdauYc8`](https://solscan.io/tx/4kLtT81sjyhGt53HsN3YZXAuX5XYLnsXy4Eu3LiaV9PCXFsNkwDxmpovUY3Ww9KHubDtzdyewnCBo8DerfdauYc8) |
| A run marker: a one-byte System account at an address derived from the service key and the run, allocated in the payout transaction. The System program allocates an account once, so a second payout of the same run fails as a whole | `packages/solana/src/marker.ts`, `packages/solana/src/runs.ts` | Mainnet: run `HF-2026-10-0004`, paid from the application, set its marker in [`bw7ag5Pw…rfXs6d2H`](https://solscan.io/tx/bw7ag5PwuhKxPHWXKUS4khouTrtVbPBzXi8rW5svaYg4uxxKudaqqoMG1DPeAgr34Sr5BkwnBmpzczYrfXs6d2H). The chain failing a repeat, on devnet: paid with its marker [`3KRdVfrZ…b7pn9C7k`](https://explorer.solana.com/tx/3KRdVfrZHV62t6WQLvTcCzeE7Q9i4nY3yXGPiFU1vusm3czJSch9Vtoz3CbyioYfseH9VGNeWDQ8oajBb7pn9C7k?cluster=devnet), repeated and refused [`57dG5ufC…Q1M2ge7`](https://explorer.solana.com/tx/57dG5ufCgC4d44FvjCPUwPmJ4yKKPxWxTsWq1Y1CEr2bFoVk8YFYWkcG1dtc7QkPRkNtWRMPBHSppbrU3Q1M2ge7?cluster=devnet) |
| Two payouts of one run sent at the same moment: one lands, the other fails at its marker | `packages/solana/src/runs.ts` | Devnet: [`B8Rmuxnc…vpsjhco`](https://explorer.solana.com/tx/B8Rmuxncuv88PKmd1YzXRqyBqRDKkaJDWCk4CooNiTT7f5DsGyjsdog8x7E39JoCsHZ6c9ZTRETa9qHhvpsjhco?cluster=devnet) landed in slot 509,746,829, [`2fVzejdi…DvHZTd8M`](https://explorer.solana.com/tx/2fVzejdiioLd4MpeJDdMhb3PsYMH4jFytsNtdbQ6bq47cbasG58qWVurt42Kz5GdUVwmjSG58XQapFf1DvHZTd8M?cluster=devnet) failed in slot 509,746,833 |
| Two probes sent with preflight skipped, so the chain records the refusal | `packages/solana/src/probe.ts` | Over the allowance, error `0x1`: [`5UpRY36z…wQiZq99`](https://solscan.io/tx/5UpRY36zNFBVJo6VwRsCUJmnEQbvxs2R1xCZzmSU2RNGBLSUALwWeHPPSH3MKK8ZroXEY3MsuiSaquoZjwQiZq99). After revocation, error `0x4`: [`FjduxHjy…xrsrYVg`](https://solscan.io/tx/FjduxHjy1bqB1Nc4i6QbKkyUgEwEXMVsVmM4z3CFpYiJFfY8gsSaQ3t5azzDrB8czwHamboSwirDqN37xrsrYVg) |

## What is new here

Holdfast hedges and pays out of a treasury without taking custody of it. It holds a viewing key that cannot spend, an agent key that cannot withdraw, an access key and a delegate that can pay up to a limit and no further, and each limit is enforced by the chain the key lives on, not by Holdfast's own code. The second half of the claim is the record: each key was made to try to exceed its authority on mainnet, and the result is public. On Tempo and Solana the attempt is a transaction that the chain included and failed. On Hyperliquid it is the exchange's refusal of a signed action, which creates no transaction. On Zcash there is nothing to attempt: a viewing key has nothing to sign with. The controller that decides when to trade is a pure function with a hash-chained journal, and the journal's root is stored on HyperEVM beside the position HyperCore itself reported.

## Three commands

```
pnpm install && pnpm test
pnpm --filter @holdfast/cli holdfast backtest
pnpm --filter @holdfast/cli holdfast verify "$PWD/demo/statement.json" --ufvk-file "$PWD/demo/treasury.ufvk"
```

- `pnpm test` runs the tests of all twelve packages; the count for each is in the README's repository map. Tests that need a live network or a real Postgres are skipped unless switched on. `forge test` in `contracts` runs 67, and 6 read-only fork tests with `HYPEREVM_FORK_URL=https://rpc.hyperliquid.xyz/evm`.
- `holdfast backtest` grades the default policy on the nine scenarios and exits 1 if a graded one fails. `--policy file.json` grades another policy.
- `holdfast verify` derives a statement export again from the journal, a Zcash scan with the viewing key and the Hyperliquid history, and exits 0 only when every step ran and passed. [`demo/statement.json`](demo/statement.json) is the demo organisation's export and [`demo/treasury.ufvk`](demo/treasury.ufvk) its viewing key; the command above reads mainnet and answers `VERIFIED: all 5 steps passed`. The tool's own tests, 98 of them in `apps/cli`, include statements that were tampered with and must fail.

## Known limits

- No users besides our own demo organisation, no revenue, no audit, no token. The demo moves a few dollars.
- A lock whose top-up requests are ignored through a rally ends worse than doing nothing: -40.89% against -7.64% in scenario 4.
- The backtest covers price paths on recorded hourly data. It says nothing about liquidity at size.
- The hedge and the payouts are public. Privacy covers what arrives in the treasury, its memos and its balance.
- A Solana run marker is set on mainnet, and asking the application to pay that run again sends nothing. The chain itself failing a second payment is shown on devnet.
- A snapshot on HyperEVM is one moment the attester chose. `verifyEntry` accepts any node of the journal tree, so the leaf has to be computed from the entry by whoever checks.
- `holdfast verify` takes on trust what it says it does: that the journal is the only journal, the swap records, the payout transfers on Tempo and Solana, and the dollar prices in the ledger.
- The Hyperliquid refusal is an answer of the exchange's API, not a transaction with a hash.
- The full list is [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md), and every claim with its evidence is in [docs/CLAIMS.md](docs/CLAIMS.md).
