# Holdfast payout rail on Tempo Moderato

Run started 2026-10-10T21:04:37.192Z against tempo/v1.16.0-023f1d0/x86_64-unknown-linux-gnu, chain 42431. Testnet only: funds are from the faucet and every key is throwaway.

- Account (root): `0x8F9CA43e48A7099859698a4c35AB36e5Af35d11f`
- Fee sponsor: `0x9d40211e424B61287a9F2111bAD82988C1c5fB04`
- Access key: `0x2A72e12086C0c6BF4918fC0c78878c4e195c06E2`, second access key: `0x6Abee4C2e7d07F2fB66240Fc76F085b53BEaD9C5`
- Payout token: AlphaUSD `0x20c0000000000000000000000000000000000001`

| # | Step | Result | Gas used | Transaction |
|---|---|---|---|---|
| 1 | Root signs the key authorization (10.00 per 3600 s, transferWithMemo only, 3 recipients, expiry +24 h); the service submits it, the sponsor pays | key provisioned | 4585486 | [0x0d8922164739c4e61774643111b04d1c0826c687e896f5335cca41b607c255de](https://explore.testnet.tempo.xyz/tx/0x0d8922164739c4e61774643111b04d1c0826c687e896f5335cca41b607c255de) |
| 2 | keyStatus | authorized, remaining 10.00, window ends 2026-10-10T22:04:41.000Z, expires 2026-10-11T21:04:40.000Z, scope: selector 0x95777d59 to 3 recipients |  |  |
| 3 | preflight for run HF-2026-10-0001 (1.00 / 2.50 / 0.75) | ok |  |  |
| 4 | pay run HF-2026-10-0001: 3 lines to first-time payees, fee paid by the sponsor | paid, one TransferWithMemo per line verified in the receipt | 859566 | [0x4a968a4db5bfd6c23e44f5bb77e7873343e4e25763f91e889bc0de56910e77cd](https://explore.testnet.tempo.xyz/tx/0x4a968a4db5bfd6c23e44f5bb77e7873343e4e25763f91e889bc0de56910e77cd) |
| 5 | remaining | 5.75 of 10.00: the run cost the key exactly 4.25 and no fee |  |  |
| 6 | findRun HF-2026-10-0001, from chain logs alone | HF-2026-10-0001/1 1.00 -> 0x1b5f83Bb91f50606c4Bb266b863f400f1854A60F (log 11); HF-2026-10-0001/2 2.50 -> 0x4acAF0D8227e8d1dFD08955235EE4E924e435b7C (log 14); HF-2026-10-0001/3 0.75 -> 0xfd7abe5d7A06F3bdD408e1BF2514C2E2f7a9aF27 (log 17) |  | [0x4a968a4db5bfd6c23e44f5bb77e7873343e4e25763f91e889bc0de56910e77cd](https://explore.testnet.tempo.xyz/tx/0x4a968a4db5bfd6c23e44f5bb77e7873343e4e25763f91e889bc0de56910e77cd) |
| 7 | pay run HF-2026-10-0001 again | nothing sent: the run was found on chain and its transaction returned; remaining still 5.75 |  | [0x4a968a4db5bfd6c23e44f5bb77e7873343e4e25763f91e889bc0de56910e77cd](https://explore.testnet.tempo.xyz/tx/0x4a968a4db5bfd6c23e44f5bb77e7873343e4e25763f91e889bc0de56910e77cd) |
| 8 | pay run HF-2026-10-0002: 6 lines of 0.25 to known payees | paid | 151732 | [0xd381ef262c16e74460372855b8ca6f8890f2f82f8609d0354caf43e78a10b056](https://explore.testnet.tempo.xyz/tx/0xd381ef262c16e74460372855b8ca6f8890f2f82f8609d0354caf43e78a10b056) |
| 9 | pay run HF-2026-10-0003: 32 lines of 0.01, the most one transaction carries | paid | 464196 | [0xc52adf6a98ad7d8fe339fdcac0b05b268bca854fb21a55c219d9ccbedc0de7f9](https://explore.testnet.tempo.xyz/tx/0xc52adf6a98ad7d8fe339fdcac0b05b268bca854fb21a55c219d9ccbedc0de7f9) |
| 10 | preflight for 33 lines | refused: 33 lines exceed the 32 calls one Tempo transaction may carry |  |  |
| 11 | probeOverLimit: transferWithMemo of the largest amount there is, with 3.93 left, sent without simulation | included and reverted: SpendingLimitExceeded (0x8a9e71ea) | 53020 | [0x197a3cb80b7ac7107a93f29536045b56aa39c3f7d21ea77e9e784fb974e8ad86](https://explore.testnet.tempo.xyz/tx/0x197a3cb80b7ac7107a93f29536045b56aa39c3f7d21ea77e9e784fb974e8ad86) |
| 12 | probeOutOfScope: plain transfer(address,uint256) of 0.000001, sent without simulation | included and reverted: CallNotAllowed (0x576b38b4) | 43172 | [0x78e891aa86cc922285e12658baded63d7f378623b785d8fec5033a7ff8706811](https://explore.testnet.tempo.xyz/tx/0x78e891aa86cc922285e12658baded63d7f378623b785d8fec5033a7ff8706811) |
| 13 | pay run HF-2026-10-0005: 6.00 with 3.93 left | refused by preflight, nothing sent: the run totals 6.00 but the key may only spend 3.93 more until 2026-10-10T22:04:41.000Z |  |  |
| 14 | Root revokes the key (the call from buildRevoke, signed and paid by the root) | revoked | 278192 | [0x59d68d1a97dd16f0f3163711cb2c985ee30f176f5ddf25d8282969f577328256](https://explore.testnet.tempo.xyz/tx/0x59d68d1a97dd16f0f3163711cb2c985ee30f176f5ddf25d8282969f577328256) |
| 15 | pay run HF-2026-10-0006 with the revoked key | refused, nothing sent: access key 0x2A72e12086C0c6BF4918fC0c78878c4e195c06E2 was revoked |  |  |
| 16 | A second key: root-signed authorization and run HF-2026-10-0007 (2 lines) in one transaction | key provisioned and run paid; remaining 9.00 | 4365144 | [0x2cc53dede648e8f9b73fb3bd019253c51afaca8713ebf4259008c2238152aef3](https://explore.testnet.tempo.xyz/tx/0x2cc53dede648e8f9b73fb3bd019253c51afaca8713ebf4259008c2238152aef3) |
| 17 | Recipient balances | 0x1b5f83Bb91f50606c4Bb266b863f400f1854A60F 2.11; 0x4acAF0D8227e8d1dFD08955235EE4E924e435b7C 3.61; 0xfd7abe5d7A06F3bdD408e1BF2514C2E2f7a9aF27 1.35: each equals the sum of its lines |  |  |

## Gas

- 3 lines to first-time payees: 859566 (286522 per line)
- 6 lines to known payees: 151732 (25288 per line)
- 32 lines to known payees: 464196 (14506 per line)
- each further line to a known payee: 12017

## Faucet funding

- https://explore.testnet.tempo.xyz/tx/0x3f586828cc4eaf48bbaa62e16460b2c0574e98627a994e7d26f1cd40b4252f66
- https://explore.testnet.tempo.xyz/tx/0x9a0d1e3e235065ffca43db02b492c4b39675b633dfefca4221df3ed45a38838c
- https://explore.testnet.tempo.xyz/tx/0xf2042ae159944b60f7813601936da4821c14c2019efb65374f58424514102233
- https://explore.testnet.tempo.xyz/tx/0xbf3a69c359aae8509eeb6e91b67e6fc666216719239510b5f5af1ed49a3dcf0e
- https://explore.testnet.tempo.xyz/tx/0x5c59adb6bda6128ea808bc45f2afdaffbc6ae23bfbfb4f69e4a4cb8df3d999b7
- https://explore.testnet.tempo.xyz/tx/0x53912890c845546d50ddaf6d3a37e56e171582735c703ac441e641d06fafb549
- https://explore.testnet.tempo.xyz/tx/0xa32638e046b861b37e8b9c697d09932bf592ad0d8292bc0d6ba5f33cd0036cf6
- https://explore.testnet.tempo.xyz/tx/0x475eeca01e92947a7ef166c857fcd9c0cf78d8f2d5836d9724b0c053c05b6f80
- https://explore.testnet.tempo.xyz/tx/0xf838aa2f7b671244076188a4d560e41c28c6e1f266c85f02025f03966bd17640
- https://explore.testnet.tempo.xyz/tx/0xd9206421f5b040470f2a98908f94a5f20f800d1c1834d2c559446eac7c1d9c79
