import { decodeFunctionData, encodeEventTopics, toFunctionSelector, toHex } from 'viem';
import { Abis, ExecutionError } from 'viem/tempo';
import { describe, expect, it } from 'vitest';
import {
  CALL_NOT_ALLOWED,
  MAX_LINES_PER_RUN,
  NETWORKS,
  SPENDING_LIMIT_EXCEEDED,
  TOKENS,
  TRANSFER_SELECTOR,
  TRANSFER_TOPIC,
  TRANSFER_WITH_MEMO,
  TRANSFER_WITH_MEMO_SELECTOR,
  TRANSFER_WITH_MEMO_TOPIC,
  blockRanges,
  chainOf,
  decodeRevertReason,
  explainError,
  explorerTxUrl,
  formatBaseUnits,
  lineMemo,
  lineOfMemo,
  memoBytes,
  memoText,
  runIdProblem,
  runMemos,
  toBaseUnits,
  transferCall,
  transferWithMemoCall,
} from '../src/index';

describe('memos', () => {
  it('writes text left-aligned and pads it with zero bytes', () => {
    expect(memoBytes('HF-2026-10-0001')).toBe('0x48462d323032362d31302d303030310000000000000000000000000000000000');
    expect(memoBytes('A')).toBe(`0x41${'00'.repeat(31)}`);
  });

  it('agrees with the encoding the chain was observed to accept', () => {
    for (const text of ['HF-2026-10-0001/3', 'INV 42 / ana', '~', 'x'.repeat(32)]) {
      expect(memoBytes(text)).toBe(toHex(text, { size: 32 }));
    }
  });

  it('reads back what it wrote', () => {
    for (const text of ['HF-2026-10-0001/3', ' leading and trailing ', '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~', 'x'.repeat(32)]) {
      expect(memoText(memoBytes(text))).toBe(text);
    }
  });

  it('writes back what it read', () => {
    const memo = '0x48462d582d303030322f31000000000000000000000000000000000000000000';
    expect(memoText(memo)).toBe('HF-X-0002/1');
    expect(memoBytes(memoText(memo))).toBe(memo);
  });

  it('rejects text that is empty, too long or not printable ASCII', () => {
    for (const bad of ['', 'x'.repeat(33), 'tab\there', 'line\nbreak', 'café', '€5', 'nul\u0000', 'del\u007f']) {
      expect(() => memoBytes(bad), JSON.stringify(bad)).toThrow(RangeError);
    }
  });

  it('rejects bytes that are not a right-padded printable memo', () => {
    const bad = [
      '0x1234',
      `0x${'00'.repeat(32)}`,
      `0x0041${'00'.repeat(30)}`,
      `0x4100${'41'}${'00'.repeat(29)}`,
      `0x41ff${'00'.repeat(30)}`,
      `0x0a${'00'.repeat(31)}`,
      `0x${'zz'.repeat(32)}`,
    ];
    for (const memo of bad) expect(() => memoText(memo), memo).toThrow(RangeError);
  });

  it('numbers the lines of a run and keeps every memo within 32 bytes', () => {
    expect(lineMemo('HF-2026-10-0001', 3)).toBe('HF-2026-10-0001/3');
    const longest = 'R'.repeat(29);
    expect(memoBytes(lineMemo(longest, MAX_LINES_PER_RUN))).toHaveLength(66);
    expect(() => lineMemo('HF-1', 0)).toThrow(RangeError);
    expect(() => lineMemo('HF-1', MAX_LINES_PER_RUN + 1)).toThrow(RangeError);
    expect(() => lineMemo('HF-1', 1.5)).toThrow(RangeError);
  });

  it('accepts run ids that cannot be confused with a line suffix', () => {
    expect(runIdProblem('HF-2026-10-0001')).toBeNull();
    expect(runIdProblem('R'.repeat(29))).toBeNull();
    for (const bad of ['', 'HF/1', 'HF 1', 'R'.repeat(30), 'café', 'tab\t']) {
      expect(runIdProblem(bad), JSON.stringify(bad)).not.toBeNull();
    }
  });

  it('ties a memo to its run only in the one shape a run can be searched by', () => {
    expect(lineOfMemo('HF-1/3', 'HF-1')).toBe(3);
    expect(lineOfMemo('HF-1/32', 'HF-1')).toBe(32);
    for (const other of ['HF-1/ana', 'HF-1/', 'HF-1', 'HF-10/3', 'HF-1/0', 'HF-1/03', 'HF-1/33', 'HF-1/3 ', 'HF-1/3/1', 'HF-1/1e1', 'hf-1/3']) {
      expect(lineOfMemo(other, 'HF-1'), other).toBeNull();
    }
  });

  it('lists every memo a run can carry', () => {
    const memos = runMemos('HF-2026-10-0001');
    expect(memos).toHaveLength(MAX_LINES_PER_RUN);
    expect(memos[0]).toBe('HF-2026-10-0001/1');
    expect(memos[31]).toBe('HF-2026-10-0001/32');
    expect(memos.every((memo, i) => lineOfMemo(memo, 'HF-2026-10-0001') === i + 1)).toBe(true);
  });
});

describe('amounts', () => {
  it('parses decimals into six-decimal base units', () => {
    expect(toBaseUnits('12.34')).toBe(12_340_000n);
    expect(toBaseUnits('10')).toBe(10_000_000n);
    expect(toBaseUnits('0.000001')).toBe(1n);
    expect(toBaseUnits('0')).toBe(0n);
    expect(toBaseUnits('1000000.5')).toBe(1_000_000_500_000n);
  });

  it('formats base units with at least two decimals', () => {
    expect(formatBaseUnits(12_340_000n)).toBe('12.34');
    expect(formatBaseUnits(10_000_000n)).toBe('10.00');
    expect(formatBaseUnits(2_500_000n)).toBe('2.50');
    expect(formatBaseUnits(1n)).toBe('0.000001');
    expect(formatBaseUnits(1_001_000n)).toBe('1.001');
    expect(formatBaseUnits(0n)).toBe('0.00');
    expect(formatBaseUnits(-750_000n)).toBe('-0.75');
  });

  it('parses what it formats', () => {
    for (const units of [0n, 1n, 750_000n, 5_750_000n, 12_340_000n, 999_999_999_999n]) {
      expect(toBaseUnits(formatBaseUnits(units))).toBe(units);
    }
  });

  it('rejects anything that is not a plain non-negative decimal', () => {
    for (const bad of ['', '1.', '.5', '-1', '1e3', '1,5', '0.0000001', ' 1', '1 ', '0x10', 'ten']) {
      expect(() => toBaseUnits(bad), JSON.stringify(bad)).toThrow(RangeError);
    }
  });
});

describe('revert reasons', () => {
  it('names the two keychain violations', () => {
    expect(decodeRevertReason('0x8a9e71ea')).toMatchObject({ selector: SPENDING_LIMIT_EXCEEDED, name: 'SpendingLimitExceeded' });
    expect(decodeRevertReason('0x576b38b4')).toMatchObject({ selector: CALL_NOT_ALLOWED, name: 'CallNotAllowed' });
    expect(decodeRevertReason('0x8A9E71EA')?.name).toBe('SpendingLimitExceeded');
  });

  it('uses the selectors the keychain ABI declares', () => {
    expect(toFunctionSelector('SpendingLimitExceeded()')).toBe(SPENDING_LIMIT_EXCEEDED);
    expect(toFunctionSelector('CallNotAllowed()')).toBe(CALL_NOT_ALLOWED);
    expect(ExecutionError.from(SPENDING_LIMIT_EXCEEDED).errorName).toBe('SpendingLimitExceeded');
  });

  it('falls back to the Tempo ABIs, then to the raw data', () => {
    expect(decodeRevertReason(toFunctionSelector('KeyExpired()'))?.name).toBe('KeyExpired');
    expect(decodeRevertReason('0xdeadbeef')).toEqual({ selector: '0xdeadbeef', name: 'Unknown', message: 'unrecognised revert data 0xdeadbeef' });
  });

  it('has nothing to say without data', () => {
    for (const empty of [null, undefined, '', '0x', '0x12']) expect(decodeRevertReason(empty)).toBeNull();
  });

  it('explains a failed simulation by its revert data', () => {
    // Shape recorded from eth_fillTransaction on Moderato, as viem wraps it.
    const rpc = { code: 3, message: 'execution reverted: Account keychain error: SpendingLimitExceeded(SpendingLimitExceeded)', data: '0x8a9e71ea' };
    const wrapped = Object.assign(new Error('Execution reverted'), { cause: Object.assign(new Error('RPC Request failed.'), { code: 3, data: '0x8a9e71ea', cause: rpc }) });
    expect(explainError(wrapped)).toBe('SpendingLimitExceeded: the transfer exceeds what the access key may still spend');
    expect(explainError({ code: 3, data: '0x576b38b4', message: 'execution reverted' })).toBe('CallNotAllowed: the call is outside the scope the access key was authorized for');
  });

  it('explains a key the node refuses during validation', () => {
    const revoked = { code: -32603, message: 'Revm error: keychain validation failed: AccountKeychainError(KeyAlreadyRevoked(KeyAlreadyRevoked))' };
    expect(explainError(Object.assign(new Error('An internal error was received.'), { cause: revoked }))).toBe('KeyAlreadyRevoked: the access key was revoked by the account');
    expect(explainError({ code: -32000, message: 'keychain validation failed: AccountKeychainError(KeyExpired(KeyExpired))' })).toBe('KeyExpired: the access key has expired');
    expect(explainError({ message: 'Revm error: keychain precompile error: Account keychain error: KeyAlreadyExists(KeyAlreadyExists)' })).toMatch(/^KeyAlreadyExists: /);
  });

  it('passes every other failure through in the words of the node', () => {
    expect(explainError({ code: -32003, message: 'insufficient funds for gas * price + value: have 0 want 486' })).toBe('insufficient funds for gas * price + value: have 0 want 486');
    expect(explainError(Object.assign(new Error('HTTP request failed.'), { details: 'fetch failed' }))).toBe('fetch failed');
    expect(explainError('plain text')).toBe('plain text');
    expect(explainError(null)).toBe('unknown error');
  });
});

describe('networks and tokens', () => {
  it('knows both chains', () => {
    expect(NETWORKS.mainnet).toMatchObject({ chainId: 4217, testnet: false });
    expect(NETWORKS.moderato).toMatchObject({ chainId: 42431, testnet: true });
    expect(chainOf('mainnet').id).toBe(4217);
    expect(chainOf('moderato').id).toBe(42431);
  });

  it('lists the payout tokens of each network', () => {
    expect(TOKENS.mainnet).toEqual({
      pathUSD: '0x20c0000000000000000000000000000000000000',
      USDCe: '0x20c000000000000000000000b9537d11c60e8b50',
      OUSD: '0x20c0000000000000000000006a37da5c996874be',
    });
    expect(TOKENS.moderato.AlphaUSD).toBe('0x20c0000000000000000000000000000000000001');
    expect(TOKENS.moderato.USDCe).toBe('0x20c0000000000000000000009e8d7eb59b783726');
    expect(TOKENS.moderato.USDCe).not.toBe(TOKENS.mainnet.USDCe);
  });

  it('links transactions to the right explorer', () => {
    expect(explorerTxUrl('moderato', '0xabc')).toBe('https://explore.testnet.tempo.xyz/tx/0xabc');
    expect(explorerTxUrl('mainnet', '0xabc')).toBe('https://explore.tempo.xyz/tx/0xabc');
  });
});

describe('token calls', () => {
  const to = '0x3c71213434d56CC8ACDe9Fb1c6b3d4920e40E19A';

  it('pins the selectors and event topics to the TIP-20 ABI', () => {
    expect(toFunctionSelector(TRANSFER_WITH_MEMO)).toBe(TRANSFER_WITH_MEMO_SELECTOR);
    expect(toFunctionSelector('transfer(address,uint256)')).toBe(TRANSFER_SELECTOR);
    expect(encodeEventTopics({ abi: Abis.tip20, eventName: 'TransferWithMemo' })[0]).toBe(TRANSFER_WITH_MEMO_TOPIC);
    expect(encodeEventTopics({ abi: Abis.tip20, eventName: 'Transfer' })[0]).toBe(TRANSFER_TOPIC);
  });

  it('encodes a memo transfer on the token', () => {
    const call = transferWithMemoCall(TOKENS.moderato.AlphaUSD, to, 2_500_000n, 'HF-2026-10-0001/2');
    expect(call.to).toBe(TOKENS.moderato.AlphaUSD);
    expect(call.data.startsWith(TRANSFER_WITH_MEMO_SELECTOR)).toBe(true);
    expect(decodeFunctionData({ abi: Abis.tip20, data: call.data })).toMatchObject({ functionName: 'transferWithMemo', args: [to, 2_500_000n, memoBytes('HF-2026-10-0001/2')] });
  });

  it('refuses to encode a memo that would not read back', () => {
    expect(() => transferWithMemoCall(TOKENS.moderato.AlphaUSD, to, 1n, 'x'.repeat(33))).toThrow(RangeError);
  });

  it('encodes a plain transfer', () => {
    expect(transferCall(TOKENS.moderato.AlphaUSD, to, 1n).data.startsWith(TRANSFER_SELECTOR)).toBe(true);
  });
});

describe('log ranges', () => {
  it('covers a span newest first without gaps or overlap', () => {
    expect(blockRanges(0n, 250n, 100n)).toEqual([
      [151n, 250n],
      [51n, 150n],
      [0n, 50n],
    ]);
    expect(blockRanges(1n, 100n, 100n)).toEqual([[1n, 100n]]);
    expect(blockRanges(0n, 100n, 100n)).toEqual([
      [1n, 100n],
      [0n, 0n],
    ]);
    expect(blockRanges(10n, 5n, 100n)).toEqual([]);
  });

  it('never asks for more blocks than the span', () => {
    for (const [from, to] of blockRanges(38_000_000n, 39_000_000n, 100_000n)) expect(to - from + 1n).toBeLessThanOrEqual(100_000n);
  });
});
