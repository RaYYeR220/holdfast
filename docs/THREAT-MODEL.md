# Threat model

What Holdfast holds, what each key could do at worst in the wrong hands, what a compromised server could do, what is taken on trust, and what stays the treasurer's job. Where a statement has only been reasoned about and not exercised, it says so.

The short version. The limits on the keys are enforced by the chains, so they hold even when the service itself is taken over. They bound the damage; they do not make it zero. A compromised service can read every treasury it serves, trade each Hyperliquid account badly, and pay out up to each remaining limit.

## What the service holds

| Held | Where | Scope |
|---|---|---|
| Viewing key of each treasury | Postgres, encrypted with AES-256-GCM under the master key | Reads the treasury. Cannot spend |
| Hyperliquid agent key of each organisation | Postgres, encrypted the same way | Orders on the team's account. Cannot withdraw |
| Tempo access key of each organisation | Postgres, encrypted the same way | `transferWithMemo` on one token, within a limit, a scope and an expiry |
| Solana delegate key of each organisation | Postgres, encrypted the same way | Transfers out of one token account, up to an allowance. Also pays fees and rent in SOL |
| Attester key of each organisation | Postgres, encrypted the same way | Records snapshots on `HedgeAttestor` for the account that named it. Pays its own gas. Moves no money of the organisation |
| Tempo fee sponsor key | A setting of the deployment, `TEMPO_SPONSOR_PRIVATE_KEY` | Pays fees. Holds fee tokens of the service's own |
| Master key | A setting, `HOLDFAST_MASTER_KEY` | Decrypts every stored key |
| Session secret | A setting, `SESSION_SECRET` | Signs the session cookie |
| Tick secret | A setting, `TICK_SECRET` | Lets the scheduler call `POST /api/tick` |
| The records | Postgres, not encrypted | Journal, scanned notes with their amounts and memos, payout runs with payee names and addresses, swaps, refusals, auditor links (as hashes of their tokens), and the balance behind each attestation's commitment (its salt is encrypted) |

The service keys are made by the service when an organisation is registered. Until the treasurer authorizes one on its chain it can do nothing.

The service has no place to put a root key: not the Zcash spending key, the owner key of the Hyperliquid account, the root of the Tempo account or the Solana wallet's key. A Zcash spending key or a seed phrase pasted where the viewing key belongs is refused by its shape.

## Each key, stolen

### The viewing key

It reveals the treasury's history: every payment in, every amount and memo, the balance, and what the treasury sent, for the past and for as long as the treasury keeps using that account. It cannot spend.

A viewing key cannot be revoked. The remedy is a new account: the treasurer moves the funds and gives the service the new viewing key.

### The Hyperliquid agent key

It can place and cancel orders on the team's account. A thief can therefore trade the account badly within the exchange's rules: close the hedge, enlarge it, open positions in other markets, pay fees, and lose money on purpose to an account of their own in a thin market. The whole balance of the Hyperliquid account, which is the margin, is at risk until the agent is replaced. The adapter notes that an approved agent can also switch the account between standard and unified mode.

It cannot withdraw or transfer: Hyperliquid applies those actions to the account of whoever signed, and the agent's own account is empty. That refusal is on record in [PROOF 3](PROOF.md#3-hyperliquid-the-lock-and-the-agent-key-failing-to-withdraw). The trading losses described above have not been exercised; they follow from what a trading key is.

Remedy: the owner approves a new agent under the same name, which replaces the old one. An approval can also carry an expiry.

### The Tempo access key

It can call `transferWithMemo` on the one stablecoin, up to what is left of the limit in the current period, and again in every later period until the key expires or is revoked.

- With a list of recipients, the thief can pay only the listed payees. The money goes to the team's own contractors at the wrong time, not to the thief.
- Without a list, the thief can pay anyone.
- The limit is per fixed window. The windows sit on a grid that starts when the key is provisioned, so a thief who acts at the end of one window and the start of the next can spend the limit twice within a short time.
- It cannot call anything else, and it cannot exceed the limit: both attempts are reverted transactions in [PROOF 4](PROOF.md#4-tempo-payroll-through-a-key-with-a-limit).

Remedy: the root of the account revokes the key, from the application with one passkey signature; the service's sponsor pays the fee. A revoked key cannot be authorized again, so the service then makes a new one, which can do nothing until the root authorizes it.

### The Tempo fee sponsor key

It holds the service's own fee tokens and can spend them. It cannot move any team's funds. An emptied sponsor stops payouts on Tempo: the rail checks the sponsor's balance and refuses before sending.

### The Solana delegate key

It can transfer out of the team's token account to any address, up to what is left of the allowance. There is no list of recipients and no period: the allowance is one fixed total, replaced whenever the wallet approves again.

It also holds the SOL the service put there for fees and rent, which a thief can take. And it can set the run marker of a run that was never paid, after which no payout under that run id can land.

It cannot exceed the allowance and cannot move anything once the wallet has revoked it: both attempts are failed transactions in [PROOF 5](PROOF.md#5-solana-contractor-payouts-through-a-delegate-with-an-allowance).

Remedy: the wallet signs `Revoke`. The allowance is then zero.

### The attester key

The attester is whichever key the team's account named with `setAttester`; the service makes one for each organisation. It can record snapshots in the team's current series, and spend the HYPE it holds for gas. The position, the prices and the HyperCore block in a snapshot are read by the contract from HyperCore and cannot be forged. The journal root, the number of entries and the treasury commitment are the attester's statements, so a thief can write false ones. One snapshot with a count that is too high also stops the series, because every honest attestation after it is refused with `JournalShrank`.

Remedy, which only the team's account has: name a new attester with `setAttester`, then call `startSeries`. The old series stays readable with the time it was closed. Nothing is deleted.

### The master key, the database, the other settings

- The database without the master key gives ciphertext for the keys and plain text for the rest: the journal, the scanned notes with their amounts and memos, payees and payout history. A leaked database is a leak of the treasury's history.
- The database with the master key is every key above, for every organisation.
- The session secret lets its holder forge a session for any address and act as the owner of any organisation in the application: change the policy, switch the lock, create and execute payout runs, make auditor links, export the books. All of it stays inside the limits of the service keys.
- The tick secret lets its holder trigger ticks. A tick does only what the controller decides, and a second tick of the same organisation is turned away while the first holds its lease.

## A compromised server

Someone who runs code as the service has every service key and writes the journal. For every organisation served they can:

- Read the treasury.
- Trade the Hyperliquid account badly, as above.
- Pay out up to the remaining Tempo limit, to the listed recipients if a list is set, and up to the remaining Solana allowance, to anyone.
- Write a false journal. The hash chain shows that a journal was not altered after it was written; it does not show that what was written is true. A root already stored on HyperEVM lets anyone notice a later rewrite of the entries under it. It does nothing for entries written after it, and a compromised server holds the attester key as well, so it can record the root of a false journal.
- Hand the treasurer false requests to sign. This is the part the key limits do not cover. A payment request for a swap names a one-time deposit address that nobody can recognise by eye; a compromised server can name its own. The same goes for an agent approval that names another agent, a Tempo authorization with wider terms, a Solana approval for a larger amount or another delegate. Nothing moves without the treasurer's signature, so each signature is the checkpoint: the amount at risk is what that one signature covers.

They cannot withdraw from Hyperliquid, exceed a Tempo limit or a Solana allowance, or spend from the Zcash treasury.

## What is trusted

The verifier. `holdfast verify` prints what each passing step still rests on:

- The journal is the only journal. The chain of digests shows it was not altered; nothing in it shows that no other journal exists. A root stored on HyperEVM narrows this, and the tool does not read that root itself.
- Swap delivery. The swaps are held against the statement's own swap records. The swap service is not asked.
- Payout completeness. Payout runs are held against the transfers the statement itself lists. Tempo and Solana are not read by the tool. Inside the application the reconciliation does read both chains.
- Prices in snapshots. The dollar price applied to each ZEC entry is the ledger's own: the venue's mark as each tick read it, or the reference price where the venue was not read. The account value the journal recorded at each moment cannot be asked of the venue afterwards.
- That the address the key belongs to is the address the organisation is paid at, and that the treasury's first block is the one the statement gives, unless the reader names their own.

The sources the service reads.

- Zcash. The service runs no node. It scans through lightwalletd endpoints, the public zec.rocks ones unless others are set, and relies on them for the contents of blocks. It refuses a scan that does not cover every block asked for, an endpoint whose tip is behind what was already seen, and a tip that has not moved for 20 minutes. An endpoint that withheld a payment would make the balance read low; what is missing or old never adds exposure.
- Notes whose spends a viewing key cannot follow are counted as untracked and are not hedged.
- Hyperliquid. Position, prices, fills and funding are what its API reports. Before any order that adds exposure, the mark is held against the oracle and the oracle against an independent reference price.
- The reference price is the median of public sources. At least two must answer and agree within 1%.
- The swap service. A swap is the treasurer's payment to a deposit address against a quote that names a recipient and a least amount to receive. Holdfast asks for the quote and watches the status. Whether the swap is delivered rests on the swap service; an incomplete swap is refunded by it to a transparent address the treasurer gave.
- RPC endpoints of Tempo and Solana, public ones unless others are set. A read that fails is a reason not to send. The rules that stop a second payment are the chains' own: on Tempo a retry holds the same nonce on a dedicated lane and can only collide with the first; on Solana the run marker.

Tempo.

- Limits are fixed windows, as above.
- The keychain reports what is left and when the window ends, not the size of the limit.
- A run is found again through its memos in the token's event logs, over the last 1,000,000 blocks by default. A run paid longer ago is not found on chain; the service's own record of paid runs is then the only guard against paying it again.

Solana.

- `markersFrom` is the slot from which every payout of the deployment has set a run marker. Only the operator can know it. For a run created at or after that slot, a missing marker shows the service has not paid it, and the run is sent after a look at the latest ten transactions of the account.
- For a run from before that slot, and for every run while the setting is empty, a missing marker shows nothing. The run is sent only once the account's history proves it unpaid.
- What `markersFrom` leaves out is a payment the team made by hand under the same run id. The rail looks for one among the latest transactions and does not guard against it.
- A run marker is derived from the key that paid. After a key rotation the old key has to be listed, and listing it takes its word: whoever holds an old key can set the marker of a run that was never paid.
- On mainnet one run has set its marker. The chain failing a second payment of a run is shown on devnet only.
- The rail treats any JSON-RPC error answer to `sendTransaction` as proof that nothing was broadcast, and reports the run as refused. A node that answered with an error after passing the transaction on would make that report wrong: the run could be paid while the service says it was refused. The run marker keeps this from becoming a second payment, and reading the run from the chain corrects the record.

HedgeAttestor.

- A snapshot is one moment, and the attester chose it. It says nothing about the time before, after or between snapshots. The service sends one after a tick, no more often than a set interval, 60 minutes by default.
- `verifyEntry` accepts any node of the journal tree, inner nodes as well as leaves. A `true` is about an entry only when the leaf was computed from that entry by whoever is checking.
- The treasury commitment hides the balance only while its salt is random and secret. Balances are few enough to try one by one against a commitment whose salt is known.

The application.

- Sign-in is a signed EIP-4361 message from the wallet of the organisation's Hyperliquid account, written for the configured host, with a challenge that is used once and expires after ten minutes. `HOLDFAST_PUBLIC_HOST` is required in production; without it a development server takes the host each request names.
- The session is a cookie valid for twelve hours. A request that changes state has to carry an `Origin` that names the configured host.
- An auditor link and a payee receipt are bearer tokens: whoever has the link sees what it covers. An auditor link is limited to a date range and to modules, and can be revoked.

## Denial of service

Each of these stops something. None of them moves money.

- No ticks. If the scheduler stops, nothing is decided: no orders, no top-up requests, no buy-backs. The short stays as it is, and in a rally the exchange can liquidate it. Whoever runs the service has to watch that ticks happen.
- Hyperliquid unreachable. The controller does nothing while it cannot read the venue, buy-backs included. The scorecard grades an outage during a fall. An outage during a rally, when the short needs buy-backs, is not graded.
- Zcash endpoints unreachable, behind or stalled. The treasury is unread for that tick; no exposure is added.
- Reference prices missing or apart. No exposure is added. Buy-backs do not wait for them.
- Funding under the floor. No new short is opened.
- Dust on the Solana token account. Anyone can send small transfers to the team's token account. For a run that `markersFrom` does not cover, the rail has to read the account's history to rule the run out, gives up after 50 transactions, and refuses rather than risk paying twice. Such a run can be delayed by a stranger for as long as they keep it up. Setting `markersFrom` removes this for runs created after it. The treasurer can always pay by hand.
- Rent. Each Solana run costs the service key the rent of its marker, which is never recovered, the rent of at most three new payee token accounts, and a fee of 5,000 lamports. A run that names more new accounts is refused. A service key without SOL pays nothing.
- An empty Tempo sponsor stops Tempo payouts.
- An attester key without HYPE for gas, or a HyperEVM endpoint that cannot be reached, stops new snapshots. The attestation step runs after a tick and cannot change what the tick did.
- Many organisations. One call to the tick endpoint works for at most 240 seconds, four organisations at a time, and reports the ones it did not reach as skipped.
- A long Hyperliquid history. The exchange serves the latest 10,000 fills of an account. Past that, `holdfast verify` fails its Hyperliquid step, because the beginning can no longer be shown.
- Public pages. The demo pages and the public demo routes read chains, a venue and the journal for anyone who asks, and a proof of a journal entry reads the journal up to the snapshot. Answers are kept for ten to sixty seconds so that a burst costs one read, and nothing in the application limits the rate of requests. A deployment that is open to the public needs a limit in front of it.
- The fee sponsor is shared. Every organisation on a deployment can have its sponsor pay for the authorization and the revocation of its Tempo keys. One address registers at most three organisations and the service makes at most four access keys for each, but addresses are free, so the bound is per address and not on the sponsor. The sponsor of this deployment holds a few dollars of fee tokens, and when it runs out Tempo payouts stop for everybody until it is topped up. An open deployment needs a spending cap on it.

## What the treasurer has to do

- Keep the root keys, and give none of them to the service.
- Read what the wallet shows before signing: the address and amount of a payment request, the agent in an approval, the limit, period, expiry and recipients of a Tempo authorization, the delegate and amount of a Solana approval. Before paying a swap's deposit address for a large amount, ask the swap service about that address directly.
- Answer top-up requests. The service cannot add margin. Requests appear in the application and in the journal; the service sends no message of its own. A lock left unanswered through a rally ends worse than no lock: scenario 4 of the scorecard.
- Choose the limits: a Tempo limit and period no larger than a payroll needs, a list of recipients, an expiry; a Solana allowance no larger than the next runs need.
- Revoke when in doubt, and when the service is no longer used: replace the agent on Hyperliquid, revoke the access key on Tempo, sign `Revoke` on Solana, name a new attester and start a new series, delete auditor links. Move the treasury to a new account if the viewing key may have leaked.
- When self-hosting: back up the master key apart from the database, keep the scheduler running, and set `SOLANA_MARKERS_FROM`.

## What a public demo publishes

An organisation is a public demo only if its owner made it one. For such an organisation anyone can read: the treasury's address, its balance, its payments in and out with their memos, its swaps, the hedge and the journal, both payout rails, every paid run with the receipt of each line (the address that was paid and the payee's reference), the books, and each key's address and scope. Nothing of an organisation that is not a demo is served by these pages or routes.

## Not covered

- No audit of the code or of the contract.
- Nothing here has been run with more than a few dollars.
- The exchange, the swap service and the four chains are taken as they are. Their own failures are outside this document.
