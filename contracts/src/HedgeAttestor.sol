// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// @title HedgeAttestor
/// @notice A public record of the hedge a team carries on Hyperliquid, kept so that an auditor
/// needs nothing but chain state to check it.
///
/// A team is known by its Hyperliquid account address. From that same address on HyperEVM it names
/// one attester. The attester can then record snapshots for the team. For every snapshot this
/// contract itself reads the team's perpetual position and the oracle and mark prices from
/// HyperCore, so the attester cannot report a hedge that is not there. What the attester does
/// supply is a commitment to its decision journal (a Merkle root and the number of entries under
/// it) and a commitment to the shielded treasury balance.
///
/// Snapshots are kept in series. Inside a series they are numbered, never rewritten, and the
/// journal they commit to never loses entries. Only the team can close a series and start the
/// next one. It does so when the series can no longer be continued, for instance after a faulty
/// attestation claimed more journal entries than exist. The closed series stays readable under its
/// number, together with the time it was closed, so anyone can see that it was abandoned and when.
///
/// What a snapshot does not prove:
///
/// - It shows the position and prices at one HyperCore block. The attester chose that moment.
///   Nothing is said about the time before it, after it or between two snapshots.
/// - The journal root, the number of entries and the treasury commitment are the attester's own
///   statements. The contract stores them; it cannot check them.
/// - `verifyEntry` accepts any node of the journal tree, not only its leaves. Whoever checks an
///   entry has to compute the leaf from the entry itself and not take it from someone else.
///
/// The contract has no owner, cannot be upgraded, holds no funds and calls nothing except the
/// HyperCore read precompiles.
///
/// @dev Units are the ones HyperCore reports. With `szDecimals` the size precision of the
/// perpetual (2 for ZEC):
///
///   size in coins   = szi / 10^szDecimals
///   price in USD    = px / 10^(6 - szDecimals)
///   notional in USD = szi * px / 10^6, whatever szDecimals is
///
/// `szDecimals` is not stored here. The perpAssetInfo precompile at 0x…080a and the `meta` request
/// of the Hyperliquid info API both return it.
contract HedgeAttestor {
    /// @notice What was true about one team at one moment.
    /// @param perpIndex Index of the perpetual in HyperCore's universe that was read.
    /// @param szi Signed position size as HyperCore reports it: negative is short, zero is flat.
    /// @param oraclePx Oracle price of the perpetual as HyperCore reports it.
    /// @param markPx Mark price of the perpetual as HyperCore reports it.
    /// @param l1BlockNumber HyperCore block the position and prices were read at.
    /// @param timestamp Timestamp, in seconds, of the HyperEVM block that recorded the snapshot.
    /// @param journalCount Number of journal entries under `journalRoot`.
    /// @param journalRoot Merkle root over the digests of the first `journalCount` journal entries.
    /// @param treasuryCommitment Hash of the shielded treasury balance and a secret salt.
    struct Snapshot {
        uint32 perpIndex;
        int64 szi;
        uint64 oraclePx;
        uint64 markPx;
        uint64 l1BlockNumber;
        uint64 timestamp;
        uint64 journalCount;
        bytes32 journalRoot;
        bytes32 treasuryCommitment;
    }

    /// @dev Position of a user in one perpetual. Takes `abi.encode(address user, uint32 perp)` and
    /// returns five words: int64 szi, uint64 entryNtl, int64 isolatedRawUsd, uint32 leverage,
    /// bool isIsolated.
    address internal constant POSITION_PRECOMPILE = 0x0000000000000000000000000000000000000813;
    /// @dev Mark price of a perpetual. Takes `abi.encode(uint32 perp)` and returns one uint64.
    address internal constant MARK_PX_PRECOMPILE = 0x0000000000000000000000000000000000000806;
    /// @dev Oracle price of a perpetual. Takes `abi.encode(uint32 perp)` and returns one uint64.
    address internal constant ORACLE_PX_PRECOMPILE = 0x0000000000000000000000000000000000000807;
    /// @dev Number of the HyperCore block the reads reflect. Takes no input and returns one uint64.
    address internal constant L1_BLOCK_NUMBER_PRECOMPILE = 0x0000000000000000000000000000000000000809;

    uint256 private constant WORD = 32;
    uint256 private constant POSITION_LENGTH = 5 * WORD;

    /// @notice The attester a team has named, or the zero address when it has none.
    mapping(address user => address attester) public attesterOf;

    /// @notice Number of the series new snapshots of a team go into. Series are counted from zero
    /// and every series below this number is closed.
    mapping(address user => uint256 series) public currentSeries;

    mapping(address user => mapping(uint256 series => Snapshot[])) private _snapshots;
    mapping(address user => mapping(uint256 series => uint64)) private _endedAt;

    /// @notice A team named its attester, or replaced the one it had.
    /// @param user The team's Hyperliquid account.
    /// @param attester The address that may now record snapshots for `user`.
    /// @param previous The attester before this call; the zero address when there was none.
    event AttesterSet(address indexed user, address indexed attester, address indexed previous);

    /// @notice A team withdrew its attester. Nobody can record snapshots for it until it names one.
    /// @param user The team's Hyperliquid account.
    /// @param previous The attester that was removed.
    event AttesterRemoved(address indexed user, address indexed previous);

    /// @notice A team closed its current series and started the next one. The series before
    /// `series` is abandoned from this block on: it keeps its snapshots and takes no more.
    /// @param user The team's Hyperliquid account.
    /// @param series Number of the series that starts here.
    event SeriesStarted(address indexed user, uint256 indexed series);

    /// @notice A snapshot was recorded.
    /// @param user The team's Hyperliquid account.
    /// @param series Number of the series the snapshot belongs to.
    /// @param number Position of the snapshot in that series, counted from zero.
    /// @param attester The address that recorded it.
    /// @param snapshot The snapshot, exactly as stored.
    event Attested(
        address indexed user, uint256 indexed series, uint256 indexed number, address attester, Snapshot snapshot
    );

    /// @notice The zero address cannot be an attester. Use `removeAttester` to withdraw one.
    error ZeroAttester();
    /// @notice `user` has no attester to remove.
    error NoAttester(address user);
    /// @notice `caller` is not the attester `user` has named.
    error NotAttester(address user, address caller);
    /// @notice The current series of `user` holds no snapshot, so there is nothing to abandon.
    error SeriesUnused(address user, uint256 series);
    /// @notice An empty journal must carry the zero root, and a journal with entries must not.
    error JournalRootCountMismatch(bytes32 journalRoot, uint64 journalCount);
    /// @notice The journal cannot lose entries between two snapshots of a series.
    error JournalShrank(uint64 previousCount, uint64 journalCount);
    /// @notice A journal of the same length as in the previous snapshot must have the same root.
    error JournalRewritten(bytes32 previousRoot, bytes32 journalRoot);
    /// @notice A HyperCore read precompile refused the call.
    error PrecompileReadFailed(address precompile);
    /// @notice A HyperCore read precompile answered with something other than the expected values.
    error MalformedPrecompileData(address precompile);
    /// @notice A HyperCore price precompile answered zero, which is not a price.
    error ZeroPrice(address precompile);
    /// @notice `user` has not reached a series with this number.
    error UnknownSeries(address user, uint256 series);
    /// @notice This series of `user` has no snapshots.
    error NoSnapshots(address user, uint256 series);
    /// @notice This series of `user` has no snapshot with this number.
    error UnknownSnapshot(address user, uint256 series, uint256 number);

    /// @notice Name the address that may record snapshots for the caller, replacing any earlier one.
    /// @dev The caller is the team: its HyperEVM address is its Hyperliquid account address.
    /// @param attester The new attester.
    function setAttester(address attester) external {
        if (attester == address(0)) revert ZeroAttester();
        address previous = attesterOf[msg.sender];
        attesterOf[msg.sender] = attester;
        emit AttesterSet(msg.sender, attester, previous);
    }

    /// @notice Withdraw the caller's attester. Snapshots already recorded stay.
    function removeAttester() external {
        address previous = attesterOf[msg.sender];
        if (previous == address(0)) revert NoAttester(msg.sender);
        delete attesterOf[msg.sender];
        emit AttesterRemoved(msg.sender, previous);
    }

    /// @notice Close the caller's current series and start the next one.
    /// @dev Only the team can do this, for its own account; an attester cannot. The closed series
    /// keeps every snapshot under the same numbers and records when it was closed. The new series
    /// starts empty, so its first snapshot is not held to the journal count of the old one. If the
    /// attester's key is no longer trusted, replace the attester first: the new series accepts
    /// snapshots from whoever is the attester at the time.
    /// @return series Number of the series that starts here.
    function startSeries() external returns (uint256 series) {
        uint256 abandoned = currentSeries[msg.sender];
        if (_snapshots[msg.sender][abandoned].length == 0) revert SeriesUnused(msg.sender, abandoned);
        series = abandoned + 1;
        _endedAt[msg.sender][abandoned] = _now();
        currentSeries[msg.sender] = series;
        emit SeriesStarted(msg.sender, series);
    }

    /// @notice Record a snapshot in the current series of `user`. Only the attester `user` has
    /// named may call this.
    /// @dev The position, both prices and the HyperCore block number are read here, in this call,
    /// and are never taken from the caller. If any read fails or is malformed the call reverts and
    /// nothing is stored.
    /// @param user The team's Hyperliquid account.
    /// @param perpIndex Index of the perpetual in HyperCore's universe.
    /// @param journalRoot Merkle root over the digests of the first `journalCount` journal entries;
    /// the zero root when the journal is empty.
    /// @param journalCount Number of journal entries under `journalRoot`. Never less than in the
    /// previous snapshot of the series; when it is the same, the root has to be the same too.
    /// @param treasuryCommitment Hash of the shielded treasury balance and a secret salt; see
    /// `treasuryCommitmentOf`. Stored as given.
    /// @return series Number of the series the snapshot went into.
    /// @return number Position of the new snapshot in that series, counted from zero.
    function attest(
        address user,
        uint32 perpIndex,
        bytes32 journalRoot,
        uint64 journalCount,
        bytes32 treasuryCommitment
    ) external returns (uint256 series, uint256 number) {
        // An account without an attester maps to the zero address, which is never the caller.
        if (msg.sender != attesterOf[user]) revert NotAttester(user, msg.sender);
        if ((journalCount == 0) != (journalRoot == bytes32(0))) {
            revert JournalRootCountMismatch(journalRoot, journalCount);
        }

        series = currentSeries[user];
        Snapshot[] storage history = _snapshots[user][series];
        number = history.length;
        if (number != 0) {
            Snapshot storage previous = history[number - 1];
            if (journalCount < previous.journalCount) revert JournalShrank(previous.journalCount, journalCount);
            if (journalCount == previous.journalCount && journalRoot != previous.journalRoot) {
                revert JournalRewritten(previous.journalRoot, journalRoot);
            }
        }

        Snapshot memory snap = Snapshot({
            perpIndex: perpIndex,
            szi: _readPosition(user, perpIndex),
            oraclePx: _readPrice(ORACLE_PX_PRECOMPILE, perpIndex),
            markPx: _readPrice(MARK_PX_PRECOMPILE, perpIndex),
            l1BlockNumber: _readL1BlockNumber(),
            timestamp: _now(),
            journalCount: journalCount,
            journalRoot: journalRoot,
            treasuryCommitment: treasuryCommitment
        });
        history.push(snap);
        emit Attested(user, series, number, msg.sender, snap);
    }

    /// @notice How many snapshots a series of `user` holds.
    function snapshotCount(address user, uint256 series) external view returns (uint256) {
        return _historyOf(user, series).length;
    }

    /// @notice When `user` closed a series by starting the next one, as the timestamp in seconds
    /// of that HyperEVM block. Zero for the current series, which is still open.
    function seriesEndedAt(address user, uint256 series) external view returns (uint64) {
        if (series > currentSeries[user]) revert UnknownSeries(user, series);
        return _endedAt[user][series];
    }

    /// @notice The snapshot with the given number in a series of `user`, both counted from zero.
    function snapshot(address user, uint256 series, uint256 number) external view returns (Snapshot memory) {
        return _snapshotAt(user, series, number);
    }

    /// @notice The most recent snapshot in a series of `user`, and its number.
    function latestSnapshot(address user, uint256 series) external view returns (uint256 number, Snapshot memory snap) {
        Snapshot[] storage history = _historyOf(user, series);
        if (history.length == 0) revert NoSnapshots(user, series);
        number = history.length - 1;
        snap = history[number];
    }

    /// @notice Check that a journal entry is part of the journal a snapshot committed to.
    /// @dev The tree is the one `merkleRoot` builds in the journal code: a pair of nodes is hashed
    /// with the smaller one first, and a node left without a partner at the end of a level moves up
    /// unchanged. A proof is the partners met on the way from the leaf to the root, bottom first.
    ///
    /// This accepts any node of the tree, inner nodes as well as leaves, so a true answer says
    /// something about an entry only if `leaf` was computed from that entry by whoever is checking.
    /// @param user The team's Hyperliquid account.
    /// @param series Number of the series the snapshot is in.
    /// @param number Number of the snapshot in that series.
    /// @param leaf Digest of the journal entry.
    /// @param proof Partner nodes from the leaf up to the root.
    /// @return True when the leaf and the proof lead to the snapshot's journal root.
    function verifyEntry(address user, uint256 series, uint256 number, bytes32 leaf, bytes32[] calldata proof)
        external
        view
        returns (bool)
    {
        Snapshot storage snap = _snapshotAt(user, series, number);
        // Nothing belongs to an empty journal, not even the zero leaf its zero root would match.
        if (snap.journalCount == 0) return false;
        bytes32 node = leaf;
        for (uint256 i = 0; i < proof.length; ++i) {
            node = _hashPair(node, proof[i]);
        }
        return node == snap.journalRoot;
    }

    /// @notice The commitment to a treasury balance: the hash of the balance and a salt.
    /// @dev The salt is what hides the balance; it must be random and kept secret until the
    /// commitment is opened.
    /// @param balanceZat Shielded treasury balance in zatoshi.
    /// @param salt The secret salt.
    function treasuryCommitmentOf(uint64 balanceZat, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(balanceZat, salt));
    }

    /// @notice Check a balance and salt that are claimed to open a commitment.
    /// @param commitment The commitment, as stored in a snapshot.
    /// @param balanceZat The balance in zatoshi it is said to hide.
    /// @param salt The salt it was made with.
    /// @return True when this balance and salt produce the commitment.
    function opensTreasuryCommitment(bytes32 commitment, uint64 balanceZat, bytes32 salt) external pure returns (bool) {
        return commitment == treasuryCommitmentOf(balanceZat, salt);
    }

    /// @dev Timestamp of the current block. In seconds it stays far below 2^64.
    function _now() private view returns (uint64) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(block.timestamp);
    }

    function _historyOf(address user, uint256 series) private view returns (Snapshot[] storage) {
        if (series > currentSeries[user]) revert UnknownSeries(user, series);
        return _snapshots[user][series];
    }

    function _snapshotAt(address user, uint256 series, uint256 number) private view returns (Snapshot storage) {
        Snapshot[] storage history = _historyOf(user, series);
        if (number >= history.length) revert UnknownSnapshot(user, series, number);
        return history[number];
    }

    function _hashPair(bytes32 a, bytes32 b) private pure returns (bytes32) {
        return a <= b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    /// @dev Calls a read precompile and insists on an answer of exactly the expected length. The
    /// precompiles are not contracts, so they are reached with a plain staticcall.
    function _read(address precompile, bytes memory input, uint256 length) private view returns (bytes memory) {
        (bool ok, bytes memory output) = precompile.staticcall(input);
        if (!ok) revert PrecompileReadFailed(precompile);
        if (output.length != length) revert MalformedPrecompileData(precompile);
        return output;
    }

    /// @dev Calls a read precompile that answers with a single uint64.
    function _readUint64(address precompile, bytes memory input) private view returns (uint64) {
        bytes memory output = _read(precompile, input, WORD);
        if (abi.decode(output, (uint256)) > type(uint64).max) revert MalformedPrecompileData(precompile);
        return abi.decode(output, (uint64));
    }

    /// @dev Every word of the answer has to fit the type HyperCore declares for it; only then is
    /// the first word taken as the position size.
    function _readPosition(address user, uint32 perpIndex) private view returns (int64 szi) {
        bytes memory output = _read(POSITION_PRECOMPILE, abi.encode(user, perpIndex), POSITION_LENGTH);
        (int256 size, uint256 entryNtl, int256 isolatedRawUsd, uint256 leverage, uint256 isIsolated) =
            abi.decode(output, (int256, uint256, int256, uint256, uint256));
        if (
            size < type(int64).min || size > type(int64).max || entryNtl > type(uint64).max
                || isolatedRawUsd < type(int64).min || isolatedRawUsd > type(int64).max || leverage > type(uint32).max
                || isIsolated > 1
        ) revert MalformedPrecompileData(POSITION_PRECOMPILE);
        (szi,,,,) = abi.decode(output, (int64, uint64, int64, uint32, bool));
    }

    function _readPrice(address precompile, uint32 perpIndex) private view returns (uint64 px) {
        px = _readUint64(precompile, abi.encode(perpIndex));
        if (px == 0) revert ZeroPrice(precompile);
    }

    function _readL1BlockNumber() private view returns (uint64) {
        return _readUint64(L1_BLOCK_NUMBER_PRECOMPILE, "");
    }
}
