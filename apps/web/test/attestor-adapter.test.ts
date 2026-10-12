import { type HedgeSnapshot, commitTreasury, hedgeAttestorAbi } from '@holdfast/attest';
import {
  type Address,
  type Hex,
  type TransactionSerialized,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionData,
  encodeFunctionResult,
  getAbiItem,
  isAddressEqual,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  zeroAddress,
} from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { ATTEST_GAS_LIMIT, attestorPort } from '../src/server/adapters/attestor';
import type { AttestorSettings } from '../src/server/config';
import type { AttestationCall } from '../src/server/deps';

const CONTRACT: Address = '0xa6aFA5c68146BbD4C49510987847C7C38837824E';
const TEAM: Address = '0xC7e7BAAFb0C822d0A934BbB2268F15A7eD8485bc';
const ATTESTER_KEY: Hex = `0x${'a7'.repeat(32)}`;
const ATTESTER = privateKeyToAddress(ATTESTER_KEY);
const GAS_PRICE = 174_592_151n;
const NONCE = 7;

const SETTINGS: AttestorSettings = { chainId: 999, rpcUrl: 'https://rpc.example.test/evm/rpc-key-that-must-not-leak', contract: CONTRACT, perp: { index: 214, szDecimals: 2 }, everyMinutes: 60 };

const stored: Omit<HedgeSnapshot, 'series' | 'number'> = {
  perpIndex: 214,
  szi: -5n,
  oraclePx: 12_347_810n,
  markPx: 12_339_000n,
  l1BlockNumber: 1_179_360_279n,
  timestamp: 1_791_685_480n,
  journalCount: 12n,
  journalRoot: `0x${'a1'.repeat(32)}`,
  treasuryCommitment: commitTreasury(5_000_000n, `0x${'5a'.repeat(32)}`),
};

const CALL: AttestationCall = { user: TEAM, journalRoot: `0x${'b2'.repeat(32)}`, journalCount: 14n, treasuryCommitment: commitTreasury(5_100_000n, `0x${'5b'.repeat(32)}`) };

const quantity = (n: bigint | number): Hex => `0x${n.toString(16)}`;

/** The `Attested` log a successful attestation leaves, as a node returns it inside a receipt. */
function attestedLog(address: Address, series: bigint, number: bigint, snapshot: typeof stored) {
  const event = getAbiItem({ abi: hedgeAttestorAbi, name: 'Attested' });
  return {
    address,
    topics: encodeEventTopics({ abi: hedgeAttestorAbi, eventName: 'Attested', args: { user: TEAM, series, number } }),
    data: encodeAbiParameters(
      event.inputs.filter((input) => !input.indexed),
      [ATTESTER, snapshot],
    ),
    blockNumber: '0x2e1e584',
    blockHash: `0x${'b1'.repeat(32)}`,
    transactionHash: `0x${'c1'.repeat(32)}`,
    transactionIndex: '0x0',
    logIndex: '0x0',
    removed: false,
  };
}

function receiptWith(status: '0x1' | '0x0', logs: unknown[]) {
  return {
    blockHash: `0x${'b1'.repeat(32)}`,
    blockNumber: '0x2e1e584',
    contractAddress: null,
    cumulativeGasUsed: '0x28a0d',
    effectiveGasPrice: quantity(GAS_PRICE * 2n),
    from: ATTESTER,
    gasUsed: '0x28a0d',
    logs,
    logsBloom: `0x${'00'.repeat(256)}`,
    status,
    to: CONTRACT,
    transactionHash: `0x${'c1'.repeat(32)}`,
    transactionIndex: '0x0',
    type: '0x0',
  };
}

/**
 * A node that answers what the adapter may ask, and nothing else: any other
 * method fails the test, a fee history or a gas estimate among them. Calls
 * and answers go through the real ABI encoding.
 */
function node() {
  const methods: string[] = [];
  const calls: { functionName: string; from: string | undefined; gas: string | undefined }[] = [];
  const raw: Hex[] = [];
  const state = {
    attester: zeroAddress as Address,
    /** What `attest` reverts with when the node is asked to run it; null lets it through. */
    attestRevert: null as Hex | null,
    /** Receipts by transaction hash; a function is asked anew on every read. */
    receipts: new Map<string, unknown | (() => unknown)>(),
    down: null as string | null,
    nonceTag: undefined as unknown,
  };

  function answer(call: { to: Address; data: Hex; from?: string; gas?: string }): Hex {
    if (!isAddressEqual(call.to, CONTRACT)) return '0x';
    const decoded = decodeFunctionData({ abi: hedgeAttestorAbi, data: call.data });
    calls.push({ functionName: decoded.functionName, from: call.from, gas: call.gas });
    switch (decoded.functionName) {
      case 'attesterOf':
        return encodeFunctionResult({ abi: hedgeAttestorAbi, functionName: 'attesterOf', result: state.attester });
      case 'currentSeries':
        return encodeFunctionResult({ abi: hedgeAttestorAbi, functionName: 'currentSeries', result: 1n });
      case 'snapshotCount':
        return encodeFunctionResult({ abi: hedgeAttestorAbi, functionName: 'snapshotCount', result: 3n });
      case 'seriesEndedAt':
        return encodeFunctionResult({ abi: hedgeAttestorAbi, functionName: 'seriesEndedAt', result: decoded.args[1] === 0n ? 1_791_600_000n : 0n });
      case 'latestSnapshot':
        return encodeFunctionResult({ abi: hedgeAttestorAbi, functionName: 'latestSnapshot', result: [2n, stored] });
      case 'snapshot':
        return encodeFunctionResult({ abi: hedgeAttestorAbi, functionName: 'snapshot', result: stored });
      case 'verifyEntry':
        return encodeFunctionResult({ abi: hedgeAttestorAbi, functionName: 'verifyEntry', result: decoded.args[3] === stored.journalRoot });
      case 'attest':
        if (state.attestRevert !== null) throw Object.assign(new Error('execution reverted'), { code: 3, data: state.attestRevert });
        return encodeFunctionResult({ abi: hedgeAttestorAbi, functionName: 'attest', result: [1n, 3n] });
      default:
        throw new Error(`unexpected call to ${decoded.functionName}`);
    }
  }

  const transport = custom(
    {
      async request({ method, params }: { method: string; params?: unknown }) {
        methods.push(method);
        if (state.down !== null) throw new Error(state.down);
        const args = (params ?? []) as unknown[];
        switch (method) {
          case 'eth_call':
            return answer(args[0] as { to: Address; data: Hex; from?: string; gas?: string });
          case 'eth_getTransactionCount':
            state.nonceTag = args[1];
            return quantity(NONCE);
          case 'eth_gasPrice':
            return quantity(GAS_PRICE);
          case 'eth_sendRawTransaction':
            raw.push(args[0] as Hex);
            return keccak256(args[0] as Hex);
          case 'eth_getTransactionReceipt': {
            const receipt = state.receipts.get(args[0] as string);
            return (typeof receipt === 'function' ? (receipt as () => unknown)() : receipt) ?? null;
          }
          default:
            throw new Error(`the adapter asked the node for ${method}`);
        }
      },
    },
    { retryCount: 0 },
  );
  return { transport, methods, calls, raw, state };
}

describe('the HedgeAttestor adapter', () => {
  it('describes the contract it was configured with', () => {
    const port = attestorPort(SETTINGS, { transport: node().transport });
    expect(port).toMatchObject({ chainId: 999, contract: CONTRACT, perp: { index: 214, szDecimals: 2 }, everyMs: 60 * 60_000 });
  });

  it('reads who an account has named, the state of a series, a snapshot and the contract’s verdict on a proof', async () => {
    const chain = node();
    const port = attestorPort(SETTINGS, { transport: chain.transport });

    expect(await port.attesterOf(TEAM)).toBeNull();
    chain.state.attester = ATTESTER;
    expect(await port.attesterOf(TEAM)).toBe(ATTESTER);

    expect(await port.series(TEAM, 'current')).toEqual({ series: 1n, snapshotCount: 3n, current: true, endedAt: null });
    expect(await port.series(TEAM, 0n)).toEqual({ series: 0n, snapshotCount: 3n, current: false, endedAt: 1_791_600_000n });
    expect(await port.snapshot(TEAM, 1n, 'latest')).toEqual({ series: 1n, number: 2n, ...stored });
    expect(await port.snapshot(TEAM, 1n, 0n)).toEqual({ series: 1n, number: 0n, ...stored });
    expect(await port.verifyEntry(TEAM, 1n, 2n, stored.journalRoot, [])).toBe(true);
    expect(await port.verifyEntry(TEAM, 1n, 2n, `0x${'00'.repeat(32)}`, [])).toBe(false);
    expect(new Set(chain.methods)).toEqual(new Set(['eth_call']));
  });

  it('signs an attestation as a legacy transaction with twice the quoted gas price and a fixed gas limit, asking for no estimate, and sends it only when told to', async () => {
    const chain = node();
    const port = attestorPort(SETTINGS, { transport: chain.transport });

    const { hash, raw } = await port.sign(ATTESTER_KEY, CALL);
    expect(chain.methods.sort()).toEqual(['eth_gasPrice', 'eth_getTransactionCount']);
    expect(chain.state.nonceTag).toBe('pending');
    expect(chain.raw).toEqual([]);
    // The hash is the one the node will know the transaction by.
    expect(hash).toBe(keccak256(raw));

    await port.broadcast(raw);
    expect(chain.methods.sort()).toEqual(['eth_gasPrice', 'eth_getTransactionCount', 'eth_sendRawTransaction']);
    expect(chain.raw).toEqual([raw]);
    const serialized = raw;

    const tx = parseTransaction(serialized);
    expect(tx).toMatchObject({ type: 'legacy', chainId: 999, nonce: NONCE, gasPrice: GAS_PRICE * 2n, gas: ATTEST_GAS_LIMIT, to: CONTRACT.toLowerCase() });
    expect(ATTEST_GAS_LIMIT).toBe(400_000n);
    expect(tx.value ?? 0n).toBe(0n);
    expect(tx.maxFeePerGas).toBeUndefined();
    expect(tx.data).toBe(encodeFunctionData({ abi: hedgeAttestorAbi, functionName: 'attest', args: [TEAM, 214, CALL.journalRoot, CALL.journalCount, CALL.treasuryCommitment] }));
    expect(await recoverTransactionAddress({ serializedTransaction: serialized as TransactionSerialized })).toBe(ATTESTER);
  });

  it('refuses a key that is not one without quoting it, and before it asks the node anything', async () => {
    const chain = node();
    const port = attestorPort(SETTINGS, { transport: chain.transport });
    const malformed = '0xnot-a-key-but-still-a-secret-of-sorts' as Hex;
    const message = await port.sign(malformed, CALL).then(
      () => 'signed',
      (error: Error) => error.message,
    );
    expect(message).toBe('preparing the attestation failed: the attester key is not a private key');
    expect(chain.methods).toEqual([]);
  });

  it('asks the node what the contract would answer, as the attester, under the gas of the transaction and without sending', async () => {
    const chain = node();
    const port = attestorPort(SETTINGS, { transport: chain.transport });

    expect(await port.refusalOf(ATTESTER, CALL)).toBeNull();
    expect(chain.calls).toEqual([{ functionName: 'attest', from: ATTESTER, gas: quantity(ATTEST_GAS_LIMIT) }]);

    chain.state.attestRevert = encodeErrorResult({ abi: hedgeAttestorAbi, errorName: 'JournalShrank', args: [40n, 14n] });
    expect(await port.refusalOf(ATTESTER, CALL)).toEqual({ error: 'JournalShrank', text: 'JournalShrank(40, 14)' });
    chain.state.attestRevert = encodeErrorResult({ abi: hedgeAttestorAbi, errorName: 'NotAttester', args: [TEAM, ATTESTER] });
    expect(await port.refusalOf(ATTESTER, CALL)).toEqual({ error: 'NotAttester', text: `NotAttester(${TEAM}, ${ATTESTER})` });
    expect(chain.raw).toEqual([]);
    expect(new Set(chain.methods)).toEqual(new Set(['eth_call']));
  });

  it('does not take a node that cannot be reached for a contract that agrees', async () => {
    const chain = node();
    const port = attestorPort(SETTINGS, { transport: chain.transport });
    chain.state.down = 'fetch failed';

    await expect(port.refusalOf(ATTESTER, CALL)).rejects.toThrow(/^asking the contract failed: .*fetch failed/);
    await expect(port.attesterOf(TEAM)).rejects.toThrow(/^attesterOf failed: .*fetch failed/);
    await expect(port.series(TEAM, 'current')).rejects.toThrow(/^reading the series failed: /);
    await expect(port.sign(ATTESTER_KEY, CALL)).rejects.toThrow(/^preparing the attestation failed: .*fetch failed/);
    await expect(port.broadcast('0x01')).rejects.toThrow(/^sending the attestation failed: .*fetch failed/);
    await expect(port.receipt(`0x${'c1'.repeat(32)}`)).rejects.toThrow(/^reading the receipt failed: /);
    expect(chain.raw).toEqual([]);

    // One line, without the request viem would print beside it.
    const message = await port.attesterOf(TEAM).catch((error: Error) => error.message);
    expect(message).not.toContain('\n');
    expect(message).not.toContain(SETTINGS.rpcUrl);
  });

  it('says what the contract answered when a read reverts', async () => {
    // A snapshot that does not exist: the contract reverts with its own error.
    const unknown = encodeErrorResult({ abi: hedgeAttestorAbi, errorName: 'UnknownSnapshot', args: [TEAM, 1n, 9n] });
    const port = attestorPort(SETTINGS, {
      transport: custom(
        {
          async request() {
            throw Object.assign(new Error('execution reverted'), { code: 3, data: unknown });
          },
        },
        { retryCount: 0 },
      ),
    });
    await expect(port.snapshot(TEAM, 1n, 9n)).rejects.toThrow(`reading the snapshot failed: the contract answered UnknownSnapshot(${TEAM}, 1, 9)`);
  });

  describe('reading how a transaction ended', () => {
    const HASH: Hex = `0x${'c1'.repeat(32)}`;

    it('gives the snapshot the contract’s own event reports, and takes no other contract’s word for it', async () => {
      const chain = node();
      const port = attestorPort(SETTINGS, { transport: chain.transport });
      expect(await port.receipt(HASH)).toBeNull();

      chain.state.receipts.set(HASH, receiptWith('0x1', [attestedLog(TEAM, 9n, 9n, stored), attestedLog(CONTRACT, 1n, 3n, stored)]));
      expect(await port.receipt(HASH)).toEqual({ ok: true, recorded: { user: TEAM, snapshot: { series: 1n, number: 3n, ...stored } } });

      chain.state.receipts.set(HASH, receiptWith('0x1', [attestedLog(TEAM, 9n, 9n, stored)]));
      expect(await port.receipt(HASH)).toEqual({ ok: true, recorded: null });

      chain.state.receipts.set(HASH, receiptWith('0x0', []));
      expect(await port.receipt(HASH)).toEqual({ ok: false, recorded: null });
      expect(new Set(chain.methods)).toEqual(new Set(['eth_getTransactionReceipt']));
    });

    it('waits for it no longer than it was told to', async () => {
      const chain = node();
      let clock = 1_800_000_000_000;
      const sleeps: number[] = [];
      const port = attestorPort(SETTINGS, {
        transport: chain.transport,
        now: () => clock,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock += ms;
        },
      });

      // Never shown: it asks once a second until the time is up, and then once more.
      expect(await port.receipt(HASH, 2_500)).toBeNull();
      expect(sleeps).toEqual([1_000, 1_000, 500]);
      expect(chain.methods).toHaveLength(4);

      // Shown on the third look.
      let looks = 0;
      chain.state.receipts.set(HASH, () => (++looks < 3 ? null : receiptWith('0x1', [attestedLog(CONTRACT, 1n, 3n, stored)])));
      sleeps.length = 0;
      expect(await port.receipt(HASH, 20_000)).toMatchObject({ ok: true, recorded: { snapshot: { series: 1n, number: 3n } } });
      expect(sleeps).toEqual([1_000, 1_000]);

      // Not waited for at all unless asked.
      chain.state.receipts.delete(HASH);
      sleeps.length = 0;
      expect(await port.receipt(HASH)).toBeNull();
      expect(sleeps).toEqual([]);
    });
  });
});
