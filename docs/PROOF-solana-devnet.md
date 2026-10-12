# Solana payout rail: devnet proof

Run at 2026-10-11T02:10:05.285Z against https://api.devnet.solana.com (devnet, node 4.4.0-beta.0).

| Role | Address |
| --- | --- |
| Owner (team wallet) | `EYg7ZxrQhpyTDcNWiAk6ZwePuLsQrTQ6qkHEfCcyFAU8` |
| Delegate (service key, fee payer) | `Euj1imcfo9mV1jbW6PZLVPUPbhksdEY8dzGwVTbPpLBj` |
| Test mint (6 decimals) | `CXDAjgCTxwPJQ9eFSz5v7bxzUL6nYYFXALkJUeULnzmQ` |
| Owner token account | `2Y2CneKho9UxWtzuNRKuHLkHxd3ZmSKG9CyFd8CFrUPj` |
| Recipient 1 | `CdYw69pU2RRVsRVkr9GwcXU9LfnPf2Xr43bpZiQ8PS29` |
| Recipient 2 | `6gpCx9dDNatmW2a45pZQcw3ybiDTNfodjBDQ9gocSdNy` |
| Recipient 3 | `CVV5EgG3v8yWu1uvZHQJy2Sm2ZAaKqytRWh6DZ9S52E1` |

## Steps

1. **Fund owner with SOL: already funded**

2. **Fund delegate with SOL: already funded**

3. **Create a 6-decimal test mint standing in for USDC and mint 100.00 to the owner**
   - [`115pKwDuVzcxQzpddzM4FAjCMmvgdFSNgcbKwuoT9KgycvAVwL91tKY9ECenHzy83qSTJMBcQct6AQuAzD1AhpY`](https://explorer.solana.com/tx/115pKwDuVzcxQzpddzM4FAjCMmvgdFSNgcbKwuoT9KgycvAVwL91tKY9ECenHzy83qSTJMBcQct6AQuAzD1AhpY?cluster=devnet)
   - mint CXDAjgCTxwPJQ9eFSz5v7bxzUL6nYYFXALkJUeULnzmQ
   - owner token account 2Y2CneKho9UxWtzuNRKuHLkHxd3ZmSKG9CyFd8CFrUPj

4. **Owner signs the approval built by buildDelegateApproval: delegate may move 10.00**
   - [`4abveDcjmmReNoeE3z6GS9WAtjfss41e9Vj3Kgsrgv3NFj6kgdcmFw7jDHxka6jEQCvcWhgUiWHL67WkiquzDYKj`](https://explorer.solana.com/tx/4abveDcjmmReNoeE3z6GS9WAtjfss41e9Vj3Kgsrgv3NFj6kgdcmFw7jDHxka6jEQCvcWhgUiWHL67WkiquzDYKj?cluster=devnet)
   - summary shown to the owner: {"owner":"EYg7ZxrQhpyTDcNWiAk6ZwePuLsQrTQ6qkHEfCcyFAU8","tokenAccount":"2Y2CneKho9UxWtzuNRKuHLkHxd3ZmSKG9CyFd8CFrUPj","mint":"CXDAjgCTxwPJQ9eFSz5v7bxzUL6nYYFXALkJUeULnzmQ","delegate":"Euj1imcfo9mV1jbW6PZLVPUPbhksdEY8dzGwVTbPpLBj","amount":"10"}
   - remaining() = 10

5. **preview() prices the run before anything is sent**
   - the run is bounded below by slot 509746701, taken from checkpoint() when it was created
   - 3 payee token accounts to create: 4465320 lamports of rent from the delegate, 655320 lamports for the run marker, and a fee of 5000 lamports
   - run marker 5YSiM4QZn4Yb2YoX2jgNMhjHXytXDLd52pnk6ZtU3WZB (seed G7VQDgu2eANbR25QnBUEvSTUwqx65Gig): no account at this address

6. **pay() refuses a run that would create four token accounts; the limit per run is three**
   - error: run would create 4 payee token accounts at the service key's expense (5953760 lamports of rent), the limit is 3 per run

7. **Another key sends lamports to the address of the run marker before the run is paid**
   - [`4MgJ3oTNw17zTqs7V47bk8P99GkX5yPVca5Xe4X363wedNoFowUn5e8P3cdg27iQzMDbxc1PQ8vRso3mP2SYvzf`](https://explorer.solana.com/tx/4MgJ3oTNw17zTqs7V47bk8P99GkX5yPVca5Xe4X363wedNoFowUn5e8P3cdg27iQzMDbxc1PQ8vRso3mP2SYvzf?cluster=devnet)
   - sent 650240 lamports, the least an empty account may hold
   - run marker: 650240 lamports, 0 bytes of data, owner 11111111111111111111111111111111

8. **That key cannot set the marker: allocating it takes the signature of the service key**
   - [`2GVTWPXxHEvF267ydhsjDnsGJ8M8bw46pVuu8AmiTEeyfZjxmf321Gr6AGL3hTELqQuw9f3coAyJf1VUhUG672j1`](https://explorer.solana.com/tx/2GVTWPXxHEvF267ydhsjDnsGJ8M8bw46pVuu8AmiTEeyfZjxmf321Gr6AGL3hTELqQuw9f3coAyJf1VUhUG672j1?cluster=devnet)
   - reported: instruction 0 failed: MissingRequiredSignature
   - slot 509746720, meta.err: `{"InstructionError":[0,"MissingRequiredSignature"]}`
   - 353 bytes, fee 5000 lamports, 150 compute units
   - log: `Program 11111111111111111111111111111111 failed: missing required signature for instruction`

9. **Nor can it allocate that address as the base itself: its own key derives a different address**
   - [`3ZfKQx6kctkX1nYdJknmo82cvpidFihVdGu1xuYNBniuJ8qbNdaLDHEN4xDFERvFukcX4RP55kgwMUfrnrS4jzpx`](https://explorer.solana.com/tx/3ZfKQx6kctkX1nYdJknmo82cvpidFihVdGu1xuYNBniuJ8qbNdaLDHEN4xDFERvFukcX4RP55kgwMUfrnrS4jzpx?cluster=devnet)
   - reported: instruction 0 failed: custom program error 0x5 (System program: AddressWithSeedMismatch)
   - slot 509746740, meta.err: `{"InstructionError":[0,{"Custom":5}]}`
   - 321 bytes, fee 5000 lamports, 150 compute units
   - log: `Program 11111111111111111111111111111111 failed: custom program error: 0x5`

10. **preview() still sees an unpaid run, and now charges the marker only what its address lacks**
   - already paid: false
   - 5080 lamports for the run marker, down from 655320

11. **Delegate pays run HF-2026-10-0001: 1.00 + 2.50 + 0.75 to three new recipients, one transaction**
   - [`3KRdVfrZHV62t6WQLvTcCzeE7Q9i4nY3yXGPiFU1vusm3czJSch9Vtoz3CbyioYfseH9VGNeWDQ8oajBb7pn9C7k`](https://explorer.solana.com/tx/3KRdVfrZHV62t6WQLvTcCzeE7Q9i4nY3yXGPiFU1vusm3czJSch9Vtoz3CbyioYfseH9VGNeWDQ8oajBb7pn9C7k?cluster=devnet)
   - slot 509746761, meta.err: `null`
   - 868 bytes, fee 5000 lamports, 77704 compute units
   - outcome paid, line memos on chain: true
   - remaining() = 5.75
   - cost reported by pay(): 4465320 rent + 5080 marker + 5000 fee = 4475400 lamports; the delegate's balance fell by 4475400 lamports in this transaction
   - run marker: 655320 lamports, 1 bytes of data, owner 11111111111111111111111111111111

12. **findRun rebuilds the run from chain data alone**
   - getSignaturesForAddress memo field: `[15] HF-2026-10-0001; [24] INV-1041 design retainer; [26] INV-1042 audit milestone 2; [20] INV-1043 translation`
   - 1 to CdYw69pU2RRVsRVkr9GwcXU9LfnPf2Xr43bpZiQ8PS29 "INV-1041 design retainer"
   - 2.5 to 6gpCx9dDNatmW2a45pZQcw3ybiDTNfodjBDQ9gocSdNy "INV-1042 audit milestone 2"
   - 0.75 to CVV5EgG3v8yWu1uvZHQJy2Sm2ZAaKqytRWh6DZ9S52E1 "INV-1043 translation"
   - total 4.25

13. **pay() called again with the same run returns the first transaction and sends nothing**
   - same rail: outcome paid, replayed true, tx 3KRdVfrZHV62t6WQLvTcCzeE7Q9i4nY3yXGPiFU1vusm3czJSch9Vtoz3CbyioYfseH9VGNeWDQ8oajBb7pn9C7k
   - a new rail on the same key, going by the marker: replayed true, tx 3KRdVfrZHV62t6WQLvTcCzeE7Q9i4nY3yXGPiFU1vusm3czJSch9Vtoz3CbyioYfseH9VGNeWDQ8oajBb7pn9C7k
   - remaining() = 5.75

14. **pay() refuses the same run id with different lines**
   - error: run HF-2026-10-0001 was already paid by 3KRdVfrZHV62t6WQLvTcCzeE7Q9i4nY3yXGPiFU1vusm3czJSch9Vtoz3CbyioYfseH9VGNeWDQ8oajBb7pn9C7k with different lines; nothing was sent

15. **probeRepeatRun sends run HF-2026-10-0001 a second time with preflight skipped; the System program refuses its marker**
   - [`57dG5ufCgC4d44FvjCPUwPmJ4yKKPxWxTsWq1Y1CEr2bFoVk8YFYWkcG1dtc7QkPRkNtWRMPBHSppbrU3Q1M2ge7`](https://explorer.solana.com/tx/57dG5ufCgC4d44FvjCPUwPmJ4yKKPxWxTsWq1Y1CEr2bFoVk8YFYWkcG1dtc7QkPRkNtWRMPBHSppbrU3Q1M2ge7?cluster=devnet)
   - reported: instruction 2 failed: custom program error 0x0 (System program: AccountAlreadyInUse)
   - slot 509746773, meta.err: `{"InstructionError":[2,{"Custom":0}]}`
   - 631 bytes, fee 5000 lamports, 7323 compute units
   - log: `Allocate: account Address { address: 5YSiM4QZn4Yb2YoX2jgNMhjHXytXDLd52pnk6ZtU3WZB, base: Some(Euj1imcfo9mV1jbW6PZLVPUPbhksdEY8dzGwVTbPpLBj) } already in use`
   - log: `Program 11111111111111111111111111111111 failed: custom program error: 0x0`
   - remaining() = 5.75

16. **The same repeat offered with preflight on is stopped by the node, with the error pay() reads as already paid**
   - reported: simulation failed: instruction 2 failed: custom program error 0x0 (System program: AccountAlreadyInUse)

17. **Another key cannot make the marker a nonce account, which it could then withdraw from**
   - [`2Tnyy6NCMF7p9Yn1wwhmgsa2RT9o6Biy2LkjXDEhg88gtcYHDx43KTmxcFSH6k2oU7FP4TE6EYdwid5FfvN4Nbno`](https://explorer.solana.com/tx/2Tnyy6NCMF7p9Yn1wwhmgsa2RT9o6Biy2LkjXDEhg88gtcYHDx43KTmxcFSH6k2oU7FP4TE6EYdwid5FfvN4Nbno?cluster=devnet)
   - reported: instruction 0 failed: InvalidAccountData
   - slot 509746789, meta.err: `{"InstructionError":[0,"InvalidAccountData"]}`
   - 306 bytes, fee 5000 lamports, 150 compute units
   - log: `Program 11111111111111111111111111111111 failed: invalid account data for instruction`

18. **The service key cannot take lamports back out of the marker it set**
   - [`5WHCyLudzakMrow7fSu7fv6St8S5Le7KkqJZHa9K5kq2psxWnLxpRVdbWeKXCCU2BVFgptD9hBSLSQ2QPdgnyTsT`](https://explorer.solana.com/tx/5WHCyLudzakMrow7fSu7fv6St8S5Le7KkqJZHa9K5kq2psxWnLxpRVdbWeKXCCU2BVFgptD9hBSLSQ2QPdgnyTsT?cluster=devnet)
   - reported: instruction 0 failed: InvalidArgument
   - slot 509746794, meta.err: `{"InstructionError":[0,"InvalidArgument"]}`
   - 290 bytes, fee 5000 lamports, 150 compute units
   - log: `Transfer: `from` must not carry data`
   - log: `Program 11111111111111111111111111111111 failed: invalid program argument`

19. **The service key cannot hand the marker to another program either**
   - [`5ZjaNHuwSs94D3k5VunJ43yRMMbaZi18mfMFKFhaPrChYsvvMqtXsv9VNG1CVpSiq3pAei2J21CtuUv318c3j3o9`](https://explorer.solana.com/tx/5ZjaNHuwSs94D3k5VunJ43yRMMbaZi18mfMFKFhaPrChYsvvMqtXsv9VNG1CVpSiq3pAei2J21CtuUv318c3j3o9?cluster=devnet)
   - reported: instruction 0 failed: custom program error 0x5 (System program: AddressWithSeedMismatch)
   - slot 509746799, meta.err: `{"InstructionError":[0,{"Custom":5}]}`
   - 313 bytes, fee 5000 lamports, 150 compute units
   - log: `Program 11111111111111111111111111111111 failed: custom program error: 0x5`

20. **An allocation with no lamports behind it goes through and leaves no account, so it marks nothing**
   - [`3L9eUaqcsPsWeDCbB7Mu35jnWnGcxr3sy56om4dAnM1yzmJ98CSYg5U7QrKJV9EykT8bPCd5gTUJKbZfaFLkxdpd`](https://explorer.solana.com/tx/3L9eUaqcsPsWeDCbB7Mu35jnWnGcxr3sy56om4dAnM1yzmJ98CSYg5U7QrKJV9EykT8bPCd5gTUJKbZfaFLkxdpd?cluster=devnet)
   - slot 509746809, meta.err: `null`
   - 321 bytes, fee 5000 lamports, 150 compute units
   - address DEKyWyVCZgx6o7dARzkXfe1uuh6u4uGxUA4fKEQPvPnj afterwards: no account at this address

21. **With one lamport less than the rent of 655320 behind it, the transaction fails as a whole**
   - [`3DdRo6ZVhn1gncfuDXnPP138HPdVXqgCBxiy56ESQ14rmmCwzqHCpMScSPjAaZZarmsdsPNqRMNoXKvvP9679XES`](https://explorer.solana.com/tx/3DdRo6ZVhn1gncfuDXnPP138HPdVXqgCBxiy56ESQ14rmmCwzqHCpMScSPjAaZZarmsdsPNqRMNoXKvvP9679XES?cluster=devnet)
   - reported: {"InsufficientFundsForRent":{"account_index":1}}
   - slot 509746814, meta.err: `{"InsufficientFundsForRent":{"account_index":1}}`
   - 338 bytes, fee 5000 lamports, 300 compute units

22. **Two payouts of run HF-2026-10-0004 (0.25 + 0.50) are sent at the same moment; this one lands**
   - [`B8Rmuxncuv88PKmd1YzXRqyBqRDKkaJDWCk4CooNiTT7f5DsGyjsdog8x7E39JoCsHZ6c9ZTRETa9qHhvpsjhco`](https://explorer.solana.com/tx/B8Rmuxncuv88PKmd1YzXRqyBqRDKkaJDWCk4CooNiTT7f5DsGyjsdog8x7E39JoCsHZ6c9ZTRETa9qHhvpsjhco?cluster=devnet)
   - slot 509746829, meta.err: `null`
   - 619 bytes, fee 5000 lamports, 21770 compute units
   - remaining() = 5

23. **The other one fails as a whole at its marker and moves nothing**
   - [`2fVzejdiioLd4MpeJDdMhb3PsYMH4jFytsNtdbQ6bq47cbasG58qWVurt42Kz5GdUVwmjSG58XQapFf1DvHZTd8M`](https://explorer.solana.com/tx/2fVzejdiioLd4MpeJDdMhb3PsYMH4jFytsNtdbQ6bq47cbasG58qWVurt42Kz5GdUVwmjSG58XQapFf1DvHZTd8M?cluster=devnet)
   - reported: instruction 2 failed: custom program error 0x0 (System program: AccountAlreadyInUse)
   - slot 509746833, meta.err: `{"InstructionError":[2,{"Custom":0}]}`
   - 619 bytes, fee 5000 lamports, 7323 compute units
   - log: `Allocate: account Address { address: 63xrrsWqpyB6K7vfigfKC7CAE26XVWuzozJhk9trSuDU, base: Some(Euj1imcfo9mV1jbW6PZLVPUPbhksdEY8dzGwVTbPpLBj) } already in use`
   - log: `Program 11111111111111111111111111111111 failed: custom program error: 0x0`

24. **pay() asked for that run afterwards answers with the payout that landed and sends nothing**
   - outcome paid, replayed true, tx B8Rmuxncuv88PKmd1YzXRqyBqRDKkaJDWCk4CooNiTT7f5DsGyjsdog8x7E39JoCsHZ6c9ZTRETa9qHhvpsjhco

25. **pay() refuses a run above the allowance without sending anything**
   - error: exceeds delegated allowance: run needs 5.000001, 5 remaining

26. **probeOverAllowance sends 5.000001 with preflight skipped; the Token program refuses it**
   - [`Mu4xMee2VPC4yeLXmpPeFmMGiiXkjYwu8R1A7zdrjAEJGT7CKjF1orVicXN1DzV8BBUMA4FfwnLTtUbhQewDFz7`](https://explorer.solana.com/tx/Mu4xMee2VPC4yeLXmpPeFmMGiiXkjYwu8R1A7zdrjAEJGT7CKjF1orVicXN1DzV8BBUMA4FfwnLTtUbhQewDFz7?cluster=devnet)
   - reported: instruction 1 failed: custom program error 0x1 (Token program: InsufficientFunds)
   - slot 509746856, meta.err: `{"InstructionError":[1,{"Custom":1}]}`
   - 340 bytes, fee 5000 lamports, 10296 compute units
   - log: `Program log: Error: insufficient funds`
   - log: `Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA failed: custom program error: 0x1`

27. **probeOverAllowance sends nothing at an address without a token account**
   - reported: FYucYotoyhdnPuQS742TKhW8MumNWvpZ356nGJfMcpHN has no token account for this mint and the probe never creates one; aim it at a payee that has been paid before or at the team wallet itself

28. **The same probe aimed at the owner itself, which could not move tokens even if it passed**
   - [`28en2sdc2AD8tPc2ov32FDY3N18S9FQnyzdmr67sCckxvkVg5qoM9Pfa7De2CPSsqs4kvK6uLf822wqh3LHSTJ6g`](https://explorer.solana.com/tx/28en2sdc2AD8tPc2ov32FDY3N18S9FQnyzdmr67sCckxvkVg5qoM9Pfa7De2CPSsqs4kvK6uLf822wqh3LHSTJ6g?cluster=devnet)
   - reported: instruction 1 failed: custom program error 0x1 (Token program: InsufficientFunds)
   - slot 509746877, meta.err: `{"InstructionError":[1,{"Custom":1}]}`
   - 308 bytes, fee 5000 lamports, 10355 compute units
   - log: `Program log: Error: insufficient funds`
   - log: `Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA failed: custom program error: 0x1`

29. **Owner signs the revoke built by buildDelegateRevoke**
   - [`4HZ9dfDzMDwX9DVLkAzarKoqSPZYserJQmahFdKSvKqbtTUJ9oehiqJbA16AtpZLoQ6pHdxcXLo4xQyugFWjY6yA`](https://explorer.solana.com/tx/4HZ9dfDzMDwX9DVLkAzarKoqSPZYserJQmahFdKSvKqbtTUJ9oehiqJbA16AtpZLoQ6pHdxcXLo4xQyugFWjY6yA?cluster=devnet)
   - remaining() = 0

30. **pay() is refused after the revoke**
   - error: exceeds delegated allowance: run needs 0.01, 0 remaining

31. **A transfer of one base unit by the former delegate is refused on chain too**
   - [`jyLM4m1krkSHKQnZZsK8ubADxg8NeCSkS66kurUbvCumDmvGrEZrf9Muau4zriV6bDBHUbUzV1x11pb5zDRj9Tv`](https://explorer.solana.com/tx/jyLM4m1krkSHKQnZZsK8ubADxg8NeCSkS66kurUbvCumDmvGrEZrf9Muau4zriV6bDBHUbUzV1x11pb5zDRj9Tv?cluster=devnet)
   - reported: instruction 1 failed: custom program error 0x4 (Token program: OwnerMismatch)
   - slot 509746891, meta.err: `{"InstructionError":[1,{"Custom":4}]}`
   - 340 bytes, fee 5000 lamports, 10282 compute units
   - log: `Program log: Error: owner does not match`
   - log: `Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA failed: custom program error: 0x4`

32. **The marker of run HF-2026-10-0001 after all of the above is as the payout left it**
   - run marker 5YSiM4QZn4Yb2YoX2jgNMhjHXytXDLd52pnk6ZtU3WZB: 655320 lamports, 1 bytes of data, owner 11111111111111111111111111111111

