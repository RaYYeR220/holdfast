# Revoking a Holdfast access key on Tempo Moderato

Run started 2026-10-12T19:01:31.739Z against tempo/v1.16.0-023f1d0/x86_64-unknown-linux-gnu, chain 42431. Testnet only: funds are from the faucet and every key is throwaway.

- Account (root, a passkey that was never funded): `0x8a6b91ac79Be2463a706d96D5eC46FAA3b623233`
- Fee sponsor: `0x3E25Fd8f20A4B3d6f5a16744723348FfdFC994ea`
- Access key: `0xb7392FD90fE3CAB4867B94A34736bB752eE1C668`, second access key: `0x743A42c0A53b119C7E23580862cA2cFdCBfA8C04`
- Fee token: AlphaUSD `0x20c0000000000000000000000000000000000001`

| # | Step | Result | Gas used | Transaction |
|---|---|---|---|---|
| 1 | Passkey root (holding no tokens) signs a key authorization; the rail submits it, the sponsor pays | key authorized: 1.00 per 3600 s, transferWithMemo only | 2828174 | [0x43694b516c31f970f95f9db509d09593c4e99fa839ce507d752c5337ad2d8956](https://explore.testnet.tempo.xyz/tx/0x43694b516c31f970f95f9db509d09593c4e99fa839ce507d752c5337ad2d8956) |
| 2 | prepareRevocation | revokeKey(0xb7392FD90fE3CAB4867B94A34736bB752eE1C668), nonce 0 of the account's own sequence, gas limit 600000, at most 1200000000 per gas, valid until 2026-10-12T19:03:39.000Z, fee payer 0x3E25Fd8f20A4B3d6f5a16744723348FfdFC994ea |  |  |
| 3 | The root signs the same revocation without the fee payer marker; submitRevocation | refused, nothing sent: the transaction is signed for the account to pay the fee itself, not for the fee sponsor to pay it |  |  |
| 4 | The sponsor's signature is attached to that transaction all the same and sent to the node directly | rejected by the node: invalid transaction signature |  |  |
| 5 | The root signs the revocation with the fee payer marker; submitRevocation checks it, adds the sponsor's signature and sends it | revoked; the receipt names the sponsor as fee payer, which paid 0.000172 AlphaUSD; the root still holds 0.00 | 285980 | [0x77bfd36b990af6cb8f9f6c3ba2c39fd4b290e5611950fbe6ba4cec317f082737](https://explore.testnet.tempo.xyz/tx/0x77bfd36b990af6cb8f9f6c3ba2c39fd4b290e5611950fbe6ba4cec317f082737) |
| 6 | keyStatus, prepareRevocation and pay with the revoked key | revoked; access key 0xb7392FD90fE3CAB4867B94A34736bB752eE1C668 is already revoked on this account; there is nothing to revoke; pay refused, nothing sent: access key 0xb7392FD90fE3CAB4867B94A34736bB752eE1C668 was revoked; the run totals 0.10 but the account holds 0.00 of the payout token |  |  |
| 7 | A second key is authorized on the same account | key authorized | 2583374 | [0x2154e81c9d06f67d1498a3ebc1ff8b631b299be39224c2e58870e362c19ad2f1](https://explore.testnet.tempo.xyz/tx/0x2154e81c9d06f67d1498a3ebc1ff8b631b299be39224c2e58870e362c19ad2f1) |
| 8 | The root revokes the second key the same way, at nonce 1 | revoked; the sponsor paid 0.000022 AlphaUSD | 35980 | [0x105058ec572562b2760727d79f9e8b347ab82b633ab603dce7246fb49b4279e8](https://explore.testnet.tempo.xyz/tx/0x105058ec572562b2760727d79f9e8b347ab82b633ab603dce7246fb49b4279e8) |

## Gas

- revocation as the account's first transaction of its own: 285980
- revocation as its second: 35980
- the sponsor paid 0.000194 AlphaUSD for both; the root paid nothing and held nothing throughout

## Faucet funding

- https://explore.testnet.tempo.xyz/tx/0x8f130a02bd6c2122314b70e87c569d788278369f554081f5942eb7a2a338b46c
- https://explore.testnet.tempo.xyz/tx/0x850e01c1f6c771fee3288ba20b07d536ec5ac2e1ebc9846857f7105e6fa11dcf
- https://explore.testnet.tempo.xyz/tx/0x828fb386bbfcb578484c18620e967eeebc795d0d57ea0f8e6aa0586676b6ddf9
- https://explore.testnet.tempo.xyz/tx/0x2b03029016eec2bb1747a2baab87783a48c1a9c34444073655c028e5ce50bd6b
- https://explore.testnet.tempo.xyz/tx/0x6b4575e22896a7f336f17c4c00bacdc951d180ccfe67bd4360bd9847498ac261
