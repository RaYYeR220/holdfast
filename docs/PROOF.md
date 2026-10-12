# Proof

Everything below happened on mainnet with a small real treasury, and every line can be checked without trusting this repository. Amounts are tiny on purpose; the mechanisms are the ones a team would use.

Sections 1 to 6 were recorded on 10 and 11 October 2026, section 7 on 12 October 2026.

## The demo organisation

| What | Address |
|---|---|
| Zcash treasury (unified address) | `u1ltf2tfqjfe4d86lcu89w0hu7wg9qpvlpux59g3rxkj7fas0eav549szluszwuslugxn4sl80x79yxlfhju4xah7gazwedzekpe68shu7w5kh279qx5r3h3r8w9vxq34t82aak42z2ds3nghhsa84pl29m6j8jng0rvn43lvfapmmnhf5nw557jzy068vlk9e0ftnulq85ske6kwwdfj` |
| Zcash viewing key | [`demo/treasury.ufvk`](../demo/treasury.ufvk), published so the books can be derived again by anyone; wallet birthday 3,512,987 |
| Hyperliquid account (the team's) | [`0xC7e7BAAFb0C822d0A934BbB2268F15A7eD8485bc`](https://app.hyperliquid.xyz/explorer/address/0xC7e7BAAFb0C822d0A934BbB2268F15A7eD8485bc) |
| Hyperliquid agent key (the service's) | `0x677811d01c4250C2e3677A85B430A82f078c5928` |
| Tempo account (the team's) | [`0x43E69cd36fbf1Bbe73E03Dd5d06c8ff9f81Be4c8`](https://explore.tempo.xyz/address/0x43E69cd36fbf1Bbe73E03Dd5d06c8ff9f81Be4c8) |
| Tempo access key (the service's) | `0x4527180245A3a804CeD5F7f5Dffd6B516a1366cd` |
| Tempo fee sponsor (the service's) | `0x2b673538B5214D06d8E56A59eFFC67853453d4e3` |
| Solana wallet (the team's) | [`B1zTmCPofZo7TZET5k7jL43FzVG5TFcbQPijYi7mFV97`](https://solscan.io/account/B1zTmCPofZo7TZET5k7jL43FzVG5TFcbQPijYi7mFV97), USDC account `A8VB3LCer26TftTWTnjqgnzrHYFGk72tHvN78yCNfgEw` |
| Solana delegate (the service's) | `HBy3fT36LiCgfBuf1mymsxRwv2DDKQd5MB8z8DJghnu3` |
| HedgeAttestor contract (HyperEVM, chain 999) | [`0xa6aFA5c68146BbD4C49510987847C7C38837824E`](https://hyperevmscan.io/address/0xa6afa5c68146bbd4c49510987847c7c38837824e) |
| Attester (named by the team's account) | `0xaB529b0Da6e787Ff23092D00e98db6C1160b33A5` |

The payees in the payout runs are addresses of our own, standing in for contractors.

## 1. Zcash: a shielded payment read with a viewing key

A second wallet played the grant payer. It received ZEC on a transparent address, shielded it, and paid the treasury from the shielded pool with a memo.

| Step | Transaction |
|---|---|
| ZEC arrives at the payer's transparent address | [`f71374d1…92920f`](https://mainnet.zcashexplorer.app/transactions/f71374d1198a43e5b3e7696f27b5b9277ff614a6ac4dbde6c7a459a9c392920f) |
| The payer shields it | [`c590944c…552ad7`](https://mainnet.zcashexplorer.app/transactions/c590944c4bc89d7656cad80769c5818e1b16ff16d704bc83fb6ffc555b552ad7) |
| Shielded payment to the treasury: 0.01975 ZEC, memo "ZCG grant, milestone 2 of 4. Paid to the Holdfast demo treasury." | [`27472243…e6ff84`](https://mainnet.zcashexplorer.app/transactions/27472243738462004e72b46b2b2f3ba20318d36d3ee1f0fbcb93ef5aa2e6ff84), block 3,513,140 |

An explorer shows only that the last transaction exists. The amount and the memo are visible to the holder of the viewing key and to nobody else. Holdfast read them with that key; the key cannot spend.

Check it yourself: scan from the birthday with the published viewing key in any wallet that imports one, or run `holdfast verify` on the published statement (see the README).

Two spellings of one address. The unified address in the table above is the treasury as its wallet shows it, with several receivers. `holdfast verify` names the treasury by the address it derives from the viewing key alone, which carries the Orchard receiver only and begins `u1dafv4je7`. What ties them together is the scan: the published key decrypts the payment that was sent to the first.

## 2. Margin: ZEC becomes dollars on the team's own Hyperliquid account

The treasurer approved one payment request (ZIP-321) in their own wallet. It paid 0.0093 ZEC to the deposit address of a NEAR Intents swap whose recipient was the team's own Hyperliquid account.

| Step | Transaction |
|---|---|
| Treasury pays 0.0093 ZEC to the swap's deposit address | [`2b3865fb…c00a7e`](https://mainnet.zcashexplorer.app/transactions/2b3865fbbd334d4db4d1da760d2d8be30c72a89368e3bb6fbf7f2c9b42c00a7e) |
| 11.020977 USDC arrives on the team's Hyperliquid account | [`0xa5294456…745e10`](https://app.hyperliquid.xyz/explorer/tx/0xa52944568cd2b32e48f277ee1c8728746036fc0b6f264fb009ab68e595745e10) |

The swap accepts transparent ZEC only, so this payment and its amount are public. Holdfast held nothing at any point: the money went from the treasurer's wallet to the solver to the team's account.

## 3. Hyperliquid: the lock, and the agent key failing to withdraw

The team's account approved the agent key once. From then on the controller trades with it.

- The controller's second decision sold 0.01 ZEC of the perpetual: order `570748779376`, client order id `0xd5ce6801a6783b879b84d9c8a4be53ab`, filled at 1,226.40, fee 0.005518 USDC. The treasury then held 0.0103 ZEC against a short of 0.01, with a margin ratio near 90%.
- The position, the fill and the funding are on the [account page](https://app.hyperliquid.xyz/explorer/address/0xC7e7BAAFb0C822d0A934BbB2268F15A7eD8485bc).

The refusal. The agent key signed a withdrawal of 5 USDC and a transfer of 5 USDC. Hyperliquid answered both with:

```
Must deposit before performing actions. User: 0x677811d01c4250c2e3677a85b430a82f078c5928
```

The address in the answer is the agent's, not the team's. A withdrawal or transfer acts on the account of whoever signed it; signed by the agent it reaches for the agent's own account, which is empty, and never for the team's. The agent key can place and cancel orders on the team's account and switch its account mode; it cannot take funds out of it. `probeWithdrawRefusal` in `packages/hyperliquid` repeats the attempt.

The same two attempts were made again on 12 October from the application's Safety page, by the owner. The exchange gave the same answer to both, and the page keeps them word for word under "What the keys were refused".

## 4. Tempo: payroll through a key with a limit

The team's account authorized an access key for the service: 2.00 USDC per 30 days, `transferWithMemo` on USDC.e only, two recipients, expiry in 30 days. A separate sponsor key pays the fees, so the fee never touches the limit.

| Step | Result | Transaction |
|---|---|---|
| The account signs the key authorization; the service submits it | key live, 2.00 remaining | [`0x81f9baee…650f3bee`](https://explore.tempo.xyz/tx/0x81f9baee53e61777d4b532e16e61726755263c2112e387bbb2e65f62650f3bee) |
| Payout run `HF-2026-10-0001`: 0.40 and 0.35 in one transaction, memos `HF-2026-10-0001/1` and `/2` | paid, 1.25 remaining | [`0x379f560f…c3fe53e9`](https://explore.tempo.xyz/tx/0x379f560f0c9a053e2a1b117fab40ac5d84371c68d188c2583be015eac3fe53e9) |
| The same run again | nothing sent: the run was found on chain | |
| A payment above the limit, sent without simulation | included and reverted: `SpendingLimitExceeded` | [`0x2246d81e…acb9bce9`](https://explore.tempo.xyz/tx/0x2246d81e18fa8269c799855079e7e9ec3cabec80430b62aedd040ab9acb9bce9) |
| A call outside the key's scope (a plain `transfer`), sent without simulation | included and reverted: `CallNotAllowed` | [`0x80b065d2…7d587d11`](https://explore.tempo.xyz/tx/0x80b065d23f17bc54495e2d92eb9e15980f68d50e39f6e83ae142f2ed7d587d11) |
| A second key is authorized, then revoked by the account | revoked | [`0xeb1fbb1b…d217b6f7`](https://explore.tempo.xyz/tx/0xeb1fbb1b3aa233c9cd24806704cf53a465484e06a0516ac2e2c335d8d217b6f7), [`0x32e9a47b…6ebe353c`](https://explore.tempo.xyz/tx/0x32e9a47b2b1997cc21aac5a842d4ba92c2636623d3730dae9b0cd9bb6ebe353c) |
| A payout with the revoked key | refused before sending | |

After both refusals the remaining limit was still 1.25 and the outside address had received nothing.

A second run was paid from the application by its owner on 12 October: `HF-2026-10-0005`, 0.20 and 0.15 USDC.e to the two listed recipients, in [`0xfe4caef4…b7fd1850`](https://explore.tempo.xyz/tx/0xfe4caef4b0b56838e32056a74d9330334d8e7c9a6d20fc95b6d4ce4bb7fd1850). The key then had 0.90 USDC.e left in its period.

## 5. Solana: contractor payouts through a delegate with an allowance

The team's wallet approved the service key as delegate for 1.50 USDC on its token account. The service key pays the fees and the rent of new payee accounts; it holds no USDC.

| Step | Result | Transaction |
|---|---|---|
| The wallet approves the delegate for 1.50 USDC | allowance 1.50 | [`2F3FFe43…ZQQGJNu`](https://solscan.io/tx/2F3FFe43v2yBMA3M5DEyRfE7wDpatryTqjZnhaS4ndWHif5JuoGtvRSAsT7vfsskxDsGWFhgbAesZ1wQ6ZQQGJNu) |
| Payout run `HF-2026-10-0003`: 0.40 "INV-1041 design retainer" and 0.35 "INV-1042 audit milestone 2" | paid, allowance 0.75 | [`4kLtT81s…fdauYc8`](https://solscan.io/tx/4kLtT81sjyhGt53HsN3YZXAuX5XYLnsXy4Eu3LiaV9PCXFsNkwDxmpovUY3Ww9KHubDtzdyewnCBo8DerfdauYc8) |
| The same run again | nothing sent: the run was found on chain | |
| A transfer one unit above the allowance, preflight skipped | failed on chain: Token program error `0x1` | [`5UpRY36z…wQiZq99`](https://solscan.io/tx/5UpRY36zNFBVJo6VwRsCUJmnEQbvxs2R1xCZzmSU2RNGBLSUALwWeHPPSH3MKK8ZroXEY3MsuiSaquoZjwQiZq99) |
| The wallet revokes the delegate | allowance 0 | [`2naSHkBj…aMtkW5Su`](https://solscan.io/tx/2naSHkBjJeyd8bxKqFMoHEQBQMYwyk2rc37uRiwWRjPK8eV86X2t4LLworyKrMNgtEekU5sjr3PaqWZhaMtkW5Su) |
| The former delegate tries to move one base unit | failed on chain: Token program error `0x4` | [`FjduxHjy…xrsrYVg`](https://solscan.io/tx/FjduxHjy1bqB1Nc4i6QbKkyUgEwEXMVsVmM4z3CFpYiJFfY8gsSaQ3t5azzDrB8czwHamboSwirDqN37xrsrYVg) |
| The wallet approves the delegate again, for 0.75 USDC, so the demo treasury can go on paying | allowance 0.75 | [`9X2xYNdb…UgHHA3Jw`](https://solscan.io/tx/9X2xYNdbPvmi1KvKPrsH8k8fsCGN7LQyDD6bS12aQH9seM7a355LYpVZfCvgkkdtGZTPuLXXdVYjeUpUgHHA3Jw) |

Run `HF-2026-10-0003` was paid before payout runs carried a marker. The next one was paid from the application, by its owner, on 12 October, and set one:

| Step | Result | Transaction |
|---|---|---|
| The owner drafts run `HF-2026-10-0004` in the application (0.10 and 0.15 USDC) and pays it from the run's page | paid in one transaction, which also allocates the run's marker, the System account [`Dpx4fw29…72vnjSG`](https://solscan.io/account/Dpx4fw29aqHdyvfMLAsNJ46zp3jxKUozqUiAc72vnjSG); allowance 0.50 left | [`bw7ag5Pw…rfXs6d2H`](https://solscan.io/tx/bw7ag5PwuhKxPHWXKUS4khouTrtVbPBzXi8rW5svaYg4uxxKudaqqoMG1DPeAgr34Sr5BkwnBmpzczYrfXs6d2H), slot 456,182,009 |
| The owner executes the paid run again from the same page | nothing sent: the application answers "This run was already paid; nothing was sent" with the first transaction | |

The marker is a System account that makes the chain itself refuse a second payment of the same run. No second payment was sent on mainnet; the chain failing one is shown on devnet in [PROOF-solana-devnet.md](PROOF-solana-devnet.md) with a transaction for each property, including two payments of one run sent at the same moment.

## 6. The controller's journal

Each decision is an entry whose digest covers its inputs, the decision and the entry before it. The first entries of the demo organisation:

| Entry | Decision |
|---|---|
| 1 | hold, in the journal's words "short matches the treasury": the lock was off, so the target was no short, and there was none |
| 2 | rebalance: sell 0.01 ZEC of the perpetual (the order in section 3) |
| 3 | hold: the short matches the treasury |
| 4 | hold: the short matches the treasury; margin ratio 89.9% |

`holdfast verify` checks the chain of digests, scans Zcash with the viewing key, reads the Hyperliquid history and derives the statement again. It says beside each step what that step still rests on.

## 7. Hyperliquid, HyperEVM: the hedge attested on chain

`HedgeAttestor` is one contract on HyperEVM. The team's account deployed it and named an attester. For each attestation the contract reads the team's position and the prices from HyperCore through the read precompiles, in the same transaction, and stores them beside the Merkle root of the controller's journal.

| Step | Result | Transaction |
|---|---|---|
| The team's account deploys the contract | at [`0xa6aFA5c6…37824E`](https://hyperevmscan.io/address/0xa6afa5c68146bbd4c49510987847c7c38837824e), the address a contract created by that account's first HyperEVM transaction gets; the source is on [Sourcify](https://sourcify.dev/server/v2/contract/999/0xa6aFA5c68146BbD4C49510987847C7C38837824E) as an exact match | |
| The team's account names the attester | `attesterOf` answers `0xaB529b0D…160b33A5` | [`0x95820bd3…cf3f684e`](https://hyperevmscan.io/tx/0x95820bd326fcda3c4161dca33de852a29241cca640376b1b2ff6e817cf3f684e) |
| The attester records the first snapshot | series 0, snapshot 0 | [`0xfeaf1ab2…8a47a5e7`](https://hyperevmscan.io/tx/0xfeaf1ab22f67efe059397765f55afaa109c04e35368d323903411a768a47a5e7) |
| The deployed service records the second one by itself, after a tick | series 0, snapshot 1: 123 journal entries, a short of 0.01 ZEC, oracle price 1,238.9464, at 17:59:08 UTC | [`0x19acc318…f7050470`](https://hyperevmscan.io/tx/0x19acc31877082eee471e77371cb40a2190aad416e7f731042eb3c59ff7050470) |

What the first snapshot holds, read back with `snapshot(team, 0, 0)`:

| Field | Value |
|---|---|
| Perpetual | index 214, ZEC |
| Position (`szi`) | -1: a short of 0.01 ZEC |
| Oracle price | 12724000, which is 1,272.40 |
| Mark price | 12720000, which is 1,272.00 |
| HyperCore block | 1,181,263,717 |
| Time of the HyperEVM block | 12 October 2026, 16:06:54 UTC |
| Journal entries under the root | 10 |
| Journal root | `0xe0d1ea42d2011100ee8f893c050ab609393467382eafd5042e00d9ff7a8ad844` |
| Treasury commitment | `0x0f911df42c9fe0a00ea0a9bf2d4c6201dfd3b6d01bfa1271540c659f053f26cc`, a salted hash of the balance; the balance itself is not on chain |

The position, the prices and the HyperCore block are what the precompiles reported for the account and the perpetual named in the call; the attester cannot supply them. The root, the count and the commitment are the attester's statements, and the contract cannot check them.

The journal can be held against the root. The first ten entries of the public journal (`/api/demo/demo/journal?limit=10&beforeSeq=11`) give this root through `attestationFor` in `packages/attest`. Entry 2, the one that sold the first lot in section 3, has the leaf `0x1071afec…9c564c62`, which is its digest, and the contract confirms it is under the root. This call answers `true`:

```
cast call 0xa6aFA5c68146BbD4C49510987847C7C38837824E \
  "verifyEntry(address,uint256,uint256,bytes32,bytes32[])(bool)" \
  0xC7e7BAAFb0C822d0A934BbB2268F15A7eD8485bc 0 0 \
  0x1071afec6513bb629db9e62c7731e26ed6c534d2eb61d911a9dcf2499c564c62 \
  "[0x487c9a6e27ed7bc508e85b4b63e59c5574ee23f96401733b01c4983c1ffcca3a,0x4b18004aa3960ac22e1b163b59fa457e86836d01a7bb0911e9b9014afad31b11,0x73cc647ee81617b12b7b054c5223304e7cfc40448d4c8b70fbc18ef7cd6fbabf,0x996a98ed4c015fc25cd1738d8dfa8ee56157ad493e752fad1bdd39acc35b3be9]" \
  --rpc-url https://rpc.hyperliquid.xyz/evm
```

Two limits. A snapshot is one moment, and the attester chose it. `verifyEntry` accepts any node of the journal tree, inner nodes as well as leaves, so a `true` is about an entry only when the leaf was computed from that entry by whoever is checking; `journalLeaf` in `packages/attest` does that.

## What this does not show

- No users other than us, no revenue, no audit, no token.
- The amounts are a few dollars. Nothing here says how the system behaves with size; the backtest in the README covers price paths, not liquidity.
- The hedge on Hyperliquid and the payouts on Tempo and Solana are public. Privacy covers what arrives in the treasury, its memos and its balance, and ends where money leaves the shielded pool.
- A lock needs margin top-ups in a strong rally. The graded scenario in which every top-up is ignored while ZEC doubles ends worse than doing nothing; it is in the scorecard.
- The attestation in section 7 is a single snapshot. Nothing on chain says what the hedge was before it or between snapshots.
