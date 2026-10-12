/**
 * ABI of contracts/src/HedgeAttestor.sol. Written from the forge build by
 * `pnpm --filter @holdfast/attest abi`; change the contract, not this file.
 */
export const hedgeAttestorAbi = [
  {
    type: 'function',
    name: 'attest',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'perpIndex', type: 'uint32' },
      { name: 'journalRoot', type: 'bytes32' },
      { name: 'journalCount', type: 'uint64' },
      { name: 'treasuryCommitment', type: 'bytes32' },
    ],
    outputs: [
      { name: 'series', type: 'uint256' },
      { name: 'number', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'attesterOf',
    inputs: [
      { name: 'user', type: 'address' },
    ],
    outputs: [
      { name: 'attester', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'currentSeries',
    inputs: [
      { name: 'user', type: 'address' },
    ],
    outputs: [
      { name: 'series', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'latestSnapshot',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'series', type: 'uint256' },
    ],
    outputs: [
      { name: 'number', type: 'uint256' },
      {
        name: 'snap',
        type: 'tuple',
        components: [
          { name: 'perpIndex', type: 'uint32' },
          { name: 'szi', type: 'int64' },
          { name: 'oraclePx', type: 'uint64' },
          { name: 'markPx', type: 'uint64' },
          { name: 'l1BlockNumber', type: 'uint64' },
          { name: 'timestamp', type: 'uint64' },
          { name: 'journalCount', type: 'uint64' },
          { name: 'journalRoot', type: 'bytes32' },
          { name: 'treasuryCommitment', type: 'bytes32' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'opensTreasuryCommitment',
    inputs: [
      { name: 'commitment', type: 'bytes32' },
      { name: 'balanceZat', type: 'uint64' },
      { name: 'salt', type: 'bytes32' },
    ],
    outputs: [
      { name: '', type: 'bool' },
    ],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    name: 'removeAttester',
    inputs: [],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'seriesEndedAt',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'series', type: 'uint256' },
    ],
    outputs: [
      { name: '', type: 'uint64' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'setAttester',
    inputs: [
      { name: 'attester', type: 'address' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'snapshot',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'series', type: 'uint256' },
      { name: 'number', type: 'uint256' },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'perpIndex', type: 'uint32' },
          { name: 'szi', type: 'int64' },
          { name: 'oraclePx', type: 'uint64' },
          { name: 'markPx', type: 'uint64' },
          { name: 'l1BlockNumber', type: 'uint64' },
          { name: 'timestamp', type: 'uint64' },
          { name: 'journalCount', type: 'uint64' },
          { name: 'journalRoot', type: 'bytes32' },
          { name: 'treasuryCommitment', type: 'bytes32' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'snapshotCount',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'series', type: 'uint256' },
    ],
    outputs: [
      { name: '', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'startSeries',
    inputs: [],
    outputs: [
      { name: 'series', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'treasuryCommitmentOf',
    inputs: [
      { name: 'balanceZat', type: 'uint64' },
      { name: 'salt', type: 'bytes32' },
    ],
    outputs: [
      { name: '', type: 'bytes32' },
    ],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    name: 'verifyEntry',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'series', type: 'uint256' },
      { name: 'number', type: 'uint256' },
      { name: 'leaf', type: 'bytes32' },
      { name: 'proof', type: 'bytes32[]' },
    ],
    outputs: [
      { name: '', type: 'bool' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'event',
    name: 'Attested',
    inputs: [
      { name: 'user', type: 'address', indexed: true },
      { name: 'series', type: 'uint256', indexed: true },
      { name: 'number', type: 'uint256', indexed: true },
      { name: 'attester', type: 'address', indexed: false },
      {
        name: 'snapshot',
        type: 'tuple',
        indexed: false,
        components: [
          { name: 'perpIndex', type: 'uint32' },
          { name: 'szi', type: 'int64' },
          { name: 'oraclePx', type: 'uint64' },
          { name: 'markPx', type: 'uint64' },
          { name: 'l1BlockNumber', type: 'uint64' },
          { name: 'timestamp', type: 'uint64' },
          { name: 'journalCount', type: 'uint64' },
          { name: 'journalRoot', type: 'bytes32' },
          { name: 'treasuryCommitment', type: 'bytes32' },
        ],
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'AttesterRemoved',
    inputs: [
      { name: 'user', type: 'address', indexed: true },
      { name: 'previous', type: 'address', indexed: true },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'AttesterSet',
    inputs: [
      { name: 'user', type: 'address', indexed: true },
      { name: 'attester', type: 'address', indexed: true },
      { name: 'previous', type: 'address', indexed: true },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'SeriesStarted',
    inputs: [
      { name: 'user', type: 'address', indexed: true },
      { name: 'series', type: 'uint256', indexed: true },
    ],
    anonymous: false,
  },
  {
    type: 'error',
    name: 'JournalRewritten',
    inputs: [
      { name: 'previousRoot', type: 'bytes32' },
      { name: 'journalRoot', type: 'bytes32' },
    ],
  },
  {
    type: 'error',
    name: 'JournalRootCountMismatch',
    inputs: [
      { name: 'journalRoot', type: 'bytes32' },
      { name: 'journalCount', type: 'uint64' },
    ],
  },
  {
    type: 'error',
    name: 'JournalShrank',
    inputs: [
      { name: 'previousCount', type: 'uint64' },
      { name: 'journalCount', type: 'uint64' },
    ],
  },
  {
    type: 'error',
    name: 'MalformedPrecompileData',
    inputs: [
      { name: 'precompile', type: 'address' },
    ],
  },
  {
    type: 'error',
    name: 'NoAttester',
    inputs: [
      { name: 'user', type: 'address' },
    ],
  },
  {
    type: 'error',
    name: 'NoSnapshots',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'series', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'NotAttester',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'caller', type: 'address' },
    ],
  },
  {
    type: 'error',
    name: 'PrecompileReadFailed',
    inputs: [
      { name: 'precompile', type: 'address' },
    ],
  },
  {
    type: 'error',
    name: 'SeriesUnused',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'series', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'UnknownSeries',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'series', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'UnknownSnapshot',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'series', type: 'uint256' },
      { name: 'number', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'ZeroAttester',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ZeroPrice',
    inputs: [
      { name: 'precompile', type: 'address' },
    ],
  },
] as const;
