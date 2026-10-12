# Claims and their evidence

Every claim the README and the landing page make, one row each, with the strongest evidence there is for it. Five tiers, strongest first:

| Tier | Meaning |
|---|---|
| Mainnet | A mainnet transaction, or a mainnet record anyone can read: a contract call, an account page, the exchange's answer as it was received |
| Testnet | A transaction on Solana devnet or Tempo Moderato |
| Test | A test in this repository |
| Backtest | A replay of the controller on recorded market data |
| Statement | A design statement. Nothing in the record or the tests exercises it |

A claim with a lower tier is not weaker in what it says; it is weaker in how it was checked. Where a claim has only "Statement", that is written out.

The devnet and Moderato transactions below come from the proof scripts in `packages/solana/scripts` and `packages/tempo/scripts`; what each run printed is kept in [PROOF-solana-devnet.md](PROOF-solana-devnet.md) and [PROOF-tempo-moderato.md](PROOF-tempo-moderato.md). Test networks do not keep history for ever.

## The keys

| Claim | Tier | Evidence |
|---|---|---|
| The treasury's incoming payment, its amount and its memo were read with a viewing key | Mainnet | [PROOF 1](PROOF.md#1-zcash-a-shielded-payment-read-with-a-viewing-key). Repeat it with [`demo/treasury.ufvk`](../demo/treasury.ufvk) and the script in the README |
| A viewing key cannot spend | Statement | A property of the Zcash protocol. There is no transaction to show, because a viewing key has nothing to sign with |
| The service takes a viewing key and refuses a spending key or a seed phrase | Test | `packages/zcash/test/ufvk.test.ts` |
| The service builds no Zcash transaction; every ZEC movement is a ZIP-321 request the treasurer signs | Mainnet for the one movement made, Test for the requests | [PROOF 2](PROOF.md#2-margin-zec-becomes-dollars-on-the-teams-own-hyperliquid-account); `packages/zcash/test/zip321.test.ts`. No code in `apps` or `packages` calls the native library's transaction functions |
| The agent key trades a short ZEC perpetual on the team's own account | Mainnet | [PROOF 3](PROOF.md#3-hyperliquid-the-lock-and-the-agent-key-failing-to-withdraw), order `570748779376` |
| The agent key cannot withdraw or transfer the team's funds | Mainnet | [PROOF 3](PROOF.md#3-hyperliquid-the-lock-and-the-agent-key-failing-to-withdraw). The evidence is the exchange's answer to two signed actions, not a transaction. `packages/hyperliquid/test/probe.test.ts` covers the probe |
| An approved agent can switch the account between standard and unified mode | Statement | A note in `packages/hyperliquid/src/signing.ts`. Not exercised in the mainnet record |
| The Tempo access key pays through `transferWithMemo` within a limit per period | Mainnet | [PROOF 4](PROOF.md#4-tempo-payroll-through-a-key-with-a-limit): authorization `0x81f9baee…`, payout `0x379f560f…`, 1.25 of 2.00 left |
| A payment above the limit is refused by the chain | Mainnet | `SpendingLimitExceeded`: [`0x2246d81e…acb9bce9`](https://explore.tempo.xyz/tx/0x2246d81e18fa8269c799855079e7e9ec3cabec80430b62aedd040ab9acb9bce9) |
| A call outside the key's scope is refused by the chain | Mainnet | `CallNotAllowed`: [`0x80b065d2…7d587d11`](https://explore.tempo.xyz/tx/0x80b065d23f17bc54495e2d92eb9e15980f68d50e39f6e83ae142f2ed7d587d11) |
| A payment to an address outside the key's list of recipients is refused by the chain | Test | The key on mainnet lists two recipients, but no payment to a third was attempted there. The rail's own check before sending is in `packages/tempo/test/preflight.test.ts` |
| The account's root can revoke the key, and a revoked key pays nothing | Mainnet for the revocation, Test for the refusal | [`0x32e9a47b…6ebe353c`](https://explore.tempo.xyz/tx/0x32e9a47b2b1997cc21aac5a842d4ba92c2636623d3730dae9b0cd9bb6ebe353c). The payout after it was refused by the rail before sending, so there is no transaction; `packages/tempo/test/rail.test.ts` |
| Fees on Tempo are paid by a separate sponsor and do not count against the limit | Mainnet | [PROOF 4](PROOF.md#4-tempo-payroll-through-a-key-with-a-limit): 0.75 paid, the limit fell by 0.75 |
| Paying the same Tempo run again sends nothing | Mainnet | [PROOF 4](PROOF.md#4-tempo-payroll-through-a-key-with-a-limit). The evidence is that no second transaction exists; `packages/tempo/test/rail.test.ts` |
| One Tempo transaction carries up to 32 payout lines | Testnet | Moderato, 32 lines: [`0xc52adf6a…dc0de7f9`](https://explore.testnet.tempo.xyz/tx/0xc52adf6a98ad7d8fe339fdcac0b05b268bca854fb21a55c219d9ccbedc0de7f9) |
| The Solana delegate pays up to a fixed allowance from the team's USDC account | Mainnet | [PROOF 5](PROOF.md#5-solana-contractor-payouts-through-a-delegate-with-an-allowance): approval `2F3FFe43…`, payout `4kLtT81s…` |
| A transfer above the allowance is refused by the Token program | Mainnet | Error `0x1`: [`5UpRY36z…wQiZq99`](https://solscan.io/tx/5UpRY36zNFBVJo6VwRsCUJmnEQbvxs2R1xCZzmSU2RNGBLSUALwWeHPPSH3MKK8ZroXEY3MsuiSaquoZjwQiZq99) |
| After the team revokes, the delegate can move nothing | Mainnet | Error `0x4`: [`FjduxHjy…xrsrYVg`](https://solscan.io/tx/FjduxHjy1bqB1Nc4i6QbKkyUgEwEXMVsVmM4z3CFpYiJFfY8gsSaQ3t5azzDrB8czwHamboSwirDqN37xrsrYVg) |
| The chain refuses a second payout of the same Solana run | Testnet | Devnet: [`57dG5ufC…Q1M2ge7`](https://explorer.solana.com/tx/57dG5ufCgC4d44FvjCPUwPmJ4yKKPxWxTsWq1Y1CEr2bFoVk8YFYWkcG1dtc7QkPRkNtWRMPBHSppbrU3Q1M2ge7?cluster=devnet), System program error `0x0`. `packages/solana/test/rail-marker.test.ts`. Not on mainnet: the mainnet run predates the marker, and its repeat was stopped by reading the account's history |
| Of two payouts of one run sent at the same moment, one lands and the other fails | Testnet | Devnet: [`B8Rmuxnc…vpsjhco`](https://explorer.solana.com/tx/B8Rmuxncuv88PKmd1YzXRqyBqRDKkaJDWCk4CooNiTT7f5DsGyjsdog8x7E39JoCsHZ6c9ZTRETa9qHhvpsjhco?cluster=devnet) and [`2fVzejdi…DvHZTd8M`](https://explorer.solana.com/tx/2fVzejdiioLd4MpeJDdMhb3PsYMH4jFytsNtdbQ6bq47cbasG58qWVurt42Kz5GdUVwmjSG58XQapFf1DvHZTd8M?cluster=devnet) |
| A Solana run creates at most three new payee token accounts | Test | `packages/solana/test/rail-cost.test.ts` |
| The swap delivers to the team's own account, and the request has no field for another recipient | Mainnet for the one swap, Test for the rule | [PROOF 2](PROOF.md#2-margin-zec-becomes-dollars-on-the-teams-own-hyperliquid-account); `apps/web/test/funding.test.ts` |
| The limits are enforced by the chains, not by Holdfast | Mainnet | Each refusal above was sent past Holdfast's own checks on purpose: without simulation on Tempo, with preflight skipped on Solana |

## The hedge on HyperEVM

| Claim | Tier | Evidence |
|---|---|---|
| `HedgeAttestor` is deployed on HyperEVM mainnet by the team's account | Mainnet | [`0xa6aFA5c6…37824E`](https://hyperevmscan.io/address/0xa6afa5c68146bbd4c49510987847c7c38837824e); `cast compute-address 0xC7e7BAAFb0C822d0A934BbB2268F15A7eD8485bc --nonce 0` gives this address |
| Its source is the one in this repository | Mainnet | [Sourcify](https://sourcify.dev/server/v2/contract/999/0xa6aFA5c68146BbD4C49510987847C7C38837824E), exact match |
| The contract read the team's short of 0.01 ZEC and the prices from HyperCore | Mainnet | [PROOF 7](PROOF.md#7-hyperliquid-hyperevm-the-hedge-attested-on-chain), snapshot 0 of series 0 |
| A journal entry can be checked against the stored root | Mainnet | The `cast call` in [PROOF 7](PROOF.md#7-hyperliquid-hyperevm-the-hedge-attested-on-chain) answers `true` for entry 2 |
| The contract has no owner, no upgrades and holds no funds | Test | `contracts/src/HedgeAttestor.sol`, 67 Foundry tests, 6 more as read-only fork tests against mainnet |
| The service records a snapshot after a tick, no more often than a set interval, once the owner has named its attester key | Mainnet for one snapshot; Test for the rules | Snapshot 1 of series 0 was sent by the deployed service after a tick: [`0x19acc318…f7050470`](https://hyperevmscan.io/tx/0x19acc31877082eee471e77371cb40a2190aad416e7f731042eb3c59ff7050470). The interval, the refusals and the pending row are covered by `apps/web/test/attestations.test.ts` and `attestation-routes.test.ts` |
| The balance behind a commitment stays hidden | Test | `packages/attest/test/commitment.test.ts`. No commitment has been opened on chain |
| A snapshot proves more than one moment | Not claimed | It does not. See the limits in [PROOF 7](PROOF.md#7-hyperliquid-hyperevm-the-hedge-attested-on-chain) |

## The controller and the lock

| Claim | Tier | Evidence |
|---|---|---|
| `decide` is a pure function: no clock, no network, no randomness | Test | `packages/core/src/decide.ts`; `packages/core/test/decide.test.ts`, `properties.test.ts` |
| No AI in the decision path | Statement | Read `packages/core`: it has one dependency, a hash library, and `decide` calls nothing outside it |
| It fails closed: missing, old or future-dated data never adds exposure | Test | `packages/core/test/fail-closed.test.ts` |
| The journal is hash-chained, and a changed entry is detected | Test, and Mainnet for the demo's root | `packages/engine/test/tick.test.ts`, `apps/web/test/public.test.ts`; the root in [PROOF 7](PROOF.md#7-hyperliquid-hyperevm-the-hedge-attested-on-chain) |
| A retried tick cannot trade twice | Test | `packages/hyperliquid/test/orders.test.ts`. Not exercised on mainnet |
| The first order of the lock was placed by the controller's decision | Mainnet | [PROOF 3](PROOF.md#3-hyperliquid-the-lock-and-the-agent-key-failing-to-withdraw) and journal entry 2 in the [public journal](https://holdfast-iota.vercel.app/api/demo/demo/journal?limit=10&beforeSeq=11) |
| The demo is ticked once a minute | Mainnet | The public journal: since 12 October 2026, 16:00 UTC, consecutive entries are a minute apart |
| At the default policy a lock sells about 44.6% of the treasury for margin and hedges the rest | Test | `planLock` in `packages/core/src/plan-lock.ts` with an 80% margin target and a 0.5% swap cost; `packages/core/test/plan-advise.test.ts`. The demo paid 0.0093 of its 0.01975 ZEC for margin |
| Under 64% margin the treasurer is asked for a top-up; under 20% the controller buys back down to 30% | Backtest | `packages/core/test/decide.test.ts`, `plan-advise.test.ts`; scenarios 2 to 5 and 9. Neither has happened on mainnet: as of 12 October 2026 the demo's margin ratio has stayed above 80% |
| No new short is opened while funding over 72 hours is under -5% a year | Backtest | Scenario 7; `packages/core/test/decide.test.ts` |
| A 50% rise in ZEC takes a lock from 80% margin to the first buy-back | Test | `planLock`, `firstDeRiskUpMoveBps` |

## The backtest

| Claim | Tier | Evidence |
|---|---|---|
| The nine rows of the scorecard | Backtest | `pnpm --filter @holdfast/cli holdfast backtest --json`; the same figures at [/api/backtest/scorecard](https://holdfast-iota.vercel.app/api/backtest/scorecard); `packages/core/test/scenarios.test.ts` |
| In June 2026 the locked treasury's worst point was -0.87% against -47.38% unlocked | Backtest | Scenario 1 |
| A lock whose top-ups are ignored through a rally ends worse than no lock: -40.89% against -7.64% | Backtest | Scenario 4; a test asserts that the control's fall exceeds the unlocked one |
| The criteria were written before the first run | Statement | The comment at the top of `packages/core/src/scenarios.ts` and the order of this repository's commits. Nothing else shows it |
| The first default, 45% margin, failed four of nine; the default became 80% and the criteria stayed | Statement, with a Test for what can be repeated | The history is in the commits. What can be repeated: a 45% margin, 3x policy fails scenarios 3, 5, 8 and 9, asserted in `apps/cli/test/backtest.test.ts` |
| The replay is pessimistic: liquidation is checked before the controller reacts, and orders fill at their limit | Test | `packages/core/src/backtest.ts`, `packages/core/test/backtest.test.ts` |
| The backtest says anything about liquidity at size | Not claimed | It replays price paths only |

## Books and verification

| Claim | Tier | Evidence |
|---|---|---|
| One ledger across Zcash, Hyperliquid, swaps and payouts, reconciled | Test | `packages/books`, 310 tests; the demo's figures at [/api/demo/demo/books](https://holdfast-iota.vercel.app/api/demo/demo/books) |
| `holdfast verify` derives a statement again and exits 0 only when every step ran and passed | Test | `apps/cli/test/verify.test.ts` |
| The demo organisation's published statement verifies against mainnet | Mainnet | `holdfast verify` on [`demo/statement.json`](../demo/statement.json) with [`demo/treasury.ufvk`](../demo/treasury.ufvk): all five steps pass |
| A tampered statement fails | Test | `apps/cli/test/hostile.test.ts` |
| `holdfast verify` has been run on the demo by a reader | Not claimed | No export of the demo organisation is published |
| `holdfast verify` reads Tempo, Solana or the swap service | Not claimed | It does not, and its output says so |
| An auditor link shows only its date range and modules, and can be revoked | Test | `packages/books/test/audit.test.ts`, `scope-leaks.test.ts`; `apps/web/test/books.test.ts` |
| A payee's receipt shows one payment and nothing about the treasury | Test | `apps/web/src/server/payouts/receipt.ts`; a live one: [/api/receipts/CTpVTsWQ…](https://holdfast-iota.vercel.app/api/receipts/CTpVTsWQGwj9hKk6yQiGjZah3K7hqtRl3rEbh0X65e8) |

## The service

| Claim | Tier | Evidence |
|---|---|---|
| The viewing key and the service keys are encrypted at rest with AES-256-GCM | Test | `packages/db/src/crypto.ts`, `packages/db/test/crypto.test.ts` |
| Remaining limit, allowance and position are read from the chain at request time | Test | `apps/web/test/safety.test.ts`, `public.test.ts`; live at [/api/demo/demo/safety](https://holdfast-iota.vercel.app/api/demo/demo/safety), where each scope carries its source and the time it was read |
| Sign-in is bound to the configured host | Test | `apps/web/test/auth-orgs.test.ts`, `config.test.ts` |
| The tick endpoint needs the bearer secret | Test | `apps/web/test/tick.test.ts`; checked again in the compose stack, [SELF-HOSTING.md](SELF-HOSTING.md) |
| It can be self-hosted with Docker Compose | Run by hand | The checks listed in [SELF-HOSTING.md](SELF-HOSTING.md), on one machine, on 12 October 2026. Not part of the test suite |

## Privacy

| Claim | Tier | Evidence |
|---|---|---|
| Payments into the treasury, their memos and the balance are private | Mainnet | The explorer page of [`27472243…e6ff84`](https://mainnet.zcashexplorer.app/transactions/27472243738462004e72b46b2b2f3ba20318d36d3ee1f0fbcb93ef5aa2e6ff84) shows neither amount nor memo |
| The hedge and the payouts are public | Mainnet | The [account page](https://app.hyperliquid.xyz/explorer/address/0xC7e7BAAFb0C822d0A934BbB2268F15A7eD8485bc) and the payout transactions |
| A payment into a swap is public | Mainnet | [`2b3865fb…c00a7e`](https://mainnet.zcashexplorer.app/transactions/2b3865fbbd334d4db4d1da760d2d8be30c72a89368e3bb6fbf7f2c9b42c00a7e) |
| The demo treasury is private | Not claimed | Its viewing key is published on purpose |
| The operator of the server cannot see the treasury | Not claimed | The operator holds the viewing key |

## What is not claimed

| Statement | Evidence |
|---|---|
| No users besides our own demo organisation, no revenue, no audit, no token | Nothing to show; none exists |
| The amounts in the demo are a few dollars | [PROOF](PROOF.md): 0.01975 ZEC in, 11.02 USDC of margin, two payout runs of 0.75 USDC |
| Not a custodian | The four keys above, and the refusals |
| The Solana run marker has not been used on mainnet | [PROOF 5](PROOF.md#5-solana-contractor-payouts-through-a-delegate-with-an-allowance) |
| Top-up requests and the buy-back ladder have not fired on mainnet | The demo's journal as of 12 October 2026: one order, and every other decision a hold with no request to the treasurer |
| Funding the Tempo account from ZEC inside the application is not built | `apps/web/src/server/funding/service.ts`: swaps deliver to Hyperliquid and Solana |
| The safety view cannot read which agents a Hyperliquid account has approved | [/api/demo/demo/safety](https://holdfast-iota.vercel.app/api/demo/demo/safety) reports that scope as unavailable |
