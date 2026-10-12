# HedgeAttestor

One contract for HyperEVM. A team names an attester from its own Hyperliquid account address; the
attester records snapshots; for each snapshot the contract reads the team's perpetual position and
the oracle and mark prices from HyperCore itself. An auditor can then check, against chain state
alone, what hedge the account carried and that a journal entry belongs to the journal committed at
that moment.

Snapshots are kept in series. Inside a series they are numbered, never rewritten, and the journal
count never goes down. Only the team can close a series and start the next one; the closed series
stays readable under its number together with the time it was closed.

No owner, no upgrades, no funds, no calls except the HyperCore read precompiles.

## What a snapshot does not prove

- **It is one moment, and the attester chose it.** A snapshot shows the position and prices at one
  HyperCore block. It says nothing about the time before, after or between snapshots.
- **`verifyEntry` accepts any node of the journal tree**, inner nodes as well as leaves. A true
  answer is about an entry only if the leaf was computed from that entry by whoever is checking;
  `journalLeaf` in `packages/attest` does that. A leaf handed over by someone else proves nothing.
- The journal root, the entry count and the treasury commitment are the attester's statements. The
  contract stores them and cannot check them.

## Layout

- `src/HedgeAttestor.sol` is the contract.
- `script/Deploy.s.sol` deploys it.
- `test/` holds the unit tests (precompiles stubbed), the vectors shared with `packages/attest`
  and a read-only fork test against HyperEVM mainnet.

## What it reads from HyperCore

| Read | Address | Input | Output |
| --- | --- | --- | --- |
| position | `0x…0813` | `abi.encode(address user, uint32 perp)` | `int64 szi, uint64 entryNtl, int64 isolatedRawUsd, uint32 leverage, bool isIsolated` |
| mark price | `0x…0806` | `abi.encode(uint32 perp)` | `uint64` |
| oracle price | `0x…0807` | `abi.encode(uint32 perp)` | `uint64` |
| L1 block number | `0x…0809` | none | `uint64` |

Input is the bare ABI encoding with no function selector. The addresses hold no code, so they are
called with a plain `staticcall`. An unknown perpetual makes the precompile fail and burn the gas
it was given; the contract then reverts with `PrecompileReadFailed`.

With `szDecimals` the size precision of the perpetual:

    size in coins   = szi / 10^szDecimals
    price in USD    = px / 10^(6 - szDecimals)
    notional in USD = szi * px / 10^6

ZEC is perpetual `214` on mainnet with `szDecimals` 2, so `szi = -1` is a short of 0.01 ZEC and
`oraclePx = 12339050` is $1233.9050. On testnet ZEC is index `193`, has `szDecimals` 0 and is
delisted. Indices differ per network, so look the index up:

    curl -s https://api.hyperliquid.xyz/info -H 'Content-Type: application/json' -d '{"type":"meta"}'

and confirm it on chain (prints `("ZEC", 52, 2, 10, false)`: name, margin table, szDecimals, max
leverage, only-isolated):

    cast abi-decode "f()((string,uint32,uint8,uint8,bool))" \
      $(cast call 0x000000000000000000000000000000000000080a $(cast abi-encode "f(uint32)" 214) --rpc-url $RPC)

Sources: the HyperEVM pages of the Hyperliquid docs ("Interacting with HyperCore" and the
`L1Read.sol` attached to it, "Dual-block architecture", "JSON-RPC"), `hyperliquid-dev/hyper-evm-lib`
at commit `4eb7ab0`, and reads of mainnet on 2026-10-11.

## Build and test

Foundry 1.8.3, solc 0.8.35, EVM version `cancun` (HyperEVM runs Cancun without blobs).

    forge fmt --check
    forge build
    forge test

The fork test is skipped unless a HyperEVM mainnet RPC is given. It sends nothing:

    HYPEREVM_FORK_URL=https://rpc.hyperliquid.xyz/evm forge test --match-contract HyperEvmForkTest -vv

A chain forked into forge has no HyperCore behind it, so the test passes each precompile call on to
the node as an `eth_call`. One of its checks has the node run a deployment, a registration, two
attestations, a new series and an attestation in it inside a single `eth_call` with the gas of one
small block, which is the contract's own bytecode against the real precompiles.

`packages/attest` carries the ABI and the proof helpers. After changing the contract:

    forge build
    pnpm --filter @holdfast/attest abi       # rewrites packages/attest/src/abi.ts
    pnpm --filter @holdfast/attest vectors   # rewrites test/fixtures/vectors.json
    pnpm --filter @holdfast/attest test

## Deploy

    export DEPLOYER_PRIVATE_KEY=0x…

    # mainnet, chain 999
    forge script script/Deploy.s.sol --rpc-url https://rpc.hyperliquid.xyz/evm --broadcast

    # testnet, chain 998
    forge script script/Deploy.s.sol --rpc-url https://rpc.hyperliquid-testnet.xyz/evm --broadcast

Without `--broadcast` the script simulates and sends nothing. It refuses any other chain.

**Block type.** HyperEVM has small blocks (every second, 3M gas) and big blocks (every minute, 30M
gas). A mainnet node estimates this deployment at about 1.17M gas, so it fits a small block and the
deployer needs no special setting. An attestation takes about 0.17M gas, a little less after a
team's first; a registration about 0.05M; starting a series about 0.07M.

If a later version outgrows 3M, the deployer has to opt in to big blocks on HyperCore first. The
deployer must be a Core user (an address that has received any Core asset, USDC for one). It signs
the L1 action `{"type":"evmUserModify","usingBigBlocks":true}`; with `@nktkas/hyperliquid` that is
`exchangeClient.evmUserModify({ usingBigBlocks: true })`. Then:

    cast rpc eth_usingBigBlocks $DEPLOYER --rpc-url $RPC    # true
    cast rpc eth_bigBlockGasPrice --rpc-url $RPC            # base fee of the next big block

deploy, and send the same action with `false`, because the flag applies to every transaction of
that address until it is unset.

**Gas.** HYPE pays for gas. Fees are EIP-1559; base fee and priority fee are both burned and
`eth_maxPriorityFeePerGas` answers zero. The small-block base fee was between 0.1 and 0.3 gwei when
this was written, which puts the deployment at 0.0001 to 0.0003 HYPE. forge estimates the fee from
the node; to cap what can be paid add `--with-gas-price 2gwei`.

## Verify

Sourcify covers both networks and needs no key:

    forge verify-contract $ATTESTOR src/HedgeAttestor.sol:HedgeAttestor --chain 999 --verifier sourcify --watch
    forge verify-contract $ATTESTOR src/HedgeAttestor.sol:HedgeAttestor --chain 998 --verifier sourcify --watch

Mainnet can also be verified on HyperEVMScan with an Etherscan API key:

    forge verify-contract $ATTESTOR src/HedgeAttestor.sol:HedgeAttestor --chain 999 \
      --verifier etherscan --etherscan-api-key $ETHERSCAN_API_KEY --watch

## Register an attester and attest

`$TEAM` is the team's Hyperliquid account address. Registration is sent from that same address on
HyperEVM, so it needs a little HYPE there (send HYPE from the Core spot balance to
`0x2222222222222222222222222222222222222222` to move it across). The attester needs HYPE for
every attestation. A keystore (`--account`) or a hardware wallet (`--ledger`) can stand in for
`--private-key`.

    export RPC=https://rpc.hyperliquid.xyz/evm

    # the team names its attester
    cast send $ATTESTOR "setAttester(address)" $ATTESTER --rpc-url $RPC --private-key $TEAM_PRIVATE_KEY
    cast call $ATTESTOR "attesterOf(address)(address)" $TEAM --rpc-url $RPC

    # commitment to the treasury balance: computed locally, the salt stays secret
    SALT=0x$(openssl rand -hex 32)
    COMMITMENT=$(cast keccak $(cast abi-encode "f(uint64,bytes32)" $BALANCE_ZAT $SALT))

    # first attestation; an empty journal is the zero root with count 0
    cast send $ATTESTOR "attest(address,uint32,bytes32,uint64,bytes32)" \
      $TEAM 214 $JOURNAL_ROOT $JOURNAL_COUNT $COMMITMENT --rpc-url $RPC --private-key $ATTESTER_PRIVATE_KEY

    # read it back: the current series, then its latest snapshot (number, then the snapshot)
    SERIES=$(cast call $ATTESTOR "currentSeries(address)(uint256)" $TEAM --rpc-url $RPC)
    cast call $ATTESTOR \
      "latestSnapshot(address,uint256)(uint256,(uint32,int64,uint64,uint64,uint64,uint64,uint64,bytes32,bytes32))" \
      $TEAM $SERIES --rpc-url $RPC

The first series is number 0 and needs no call to start it. The snapshot fields are, in order:
`perpIndex, szi, oraclePx, markPx, l1BlockNumber, timestamp, journalCount, journalRoot,
treasuryCommitment`.

`attestationFor` in `packages/attest` gives `JOURNAL_ROOT` and `JOURNAL_COUNT` for a journal, and
`proofFor` the proof `verifyEntry` takes. To check an entry against snapshot `$NUMBER` of a series:

    cast call $ATTESTOR "verifyEntry(address,uint256,uint256,bytes32,bytes32[])(bool)" \
      $TEAM $SERIES $NUMBER $LEAF "[$PROOF_1,$PROOF_2]" --rpc-url $RPC

`cast send` works because the node that estimates the gas has the precompiles. `forge script`
simulates locally, where they are missing, so an `attest` sent from a script reverts in simulation.

To withdraw the attester: `cast send $ATTESTOR "removeAttester()"` from the team's address.

## When a series can no longer be continued

Inside a series the journal count never goes down. One attestation with a count that is too high,
from a fault or from a stolen attester key, therefore stops that series: every honest attestation
after it is refused with `JournalShrank`. The team, and only the team, gets out of this by starting
the next series. If the attester's key is in doubt, replace the attester first.

    cast send $ATTESTOR "setAttester(address)" $NEW_ATTESTER --rpc-url $RPC --private-key $TEAM_PRIVATE_KEY
    cast send $ATTESTOR "startSeries()" --rpc-url $RPC --private-key $TEAM_PRIVATE_KEY

The new series starts empty, with its snapshots numbered from 0 again. Nothing is deleted or
renumbered: the old series keeps its snapshots, they still verify, and the chain shows that the
series was abandoned and when.

    cast call $ATTESTOR "currentSeries(address)(uint256)" $TEAM --rpc-url $RPC
    cast call $ATTESTOR "snapshotCount(address,uint256)(uint256)" $TEAM 0 --rpc-url $RPC
    cast call $ATTESTOR "seriesEndedAt(address,uint256)(uint64)" $TEAM 0 --rpc-url $RPC   # 0 while open
    cast call $ATTESTOR \
      "snapshot(address,uint256,uint256)((uint32,int64,uint64,uint64,uint64,uint64,uint64,bytes32,bytes32))" \
      $TEAM 0 0 --rpc-url $RPC

A series that holds no snapshot cannot be abandoned; `startSeries` reverts with `SeriesUnused`.

## Vendored dependencies

`lib/forge-std` is forge-std v1.16.2 (commit `bf647bd`, https://github.com/foundry-rs/forge-std,
MIT or Apache-2.0): its `src/` directory, licences and `package.json`, copied from the release
archive without git metadata. Nothing else is needed; the contract itself imports nothing.
