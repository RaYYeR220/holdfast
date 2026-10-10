import { type Address, type Hex, pad, toHex } from 'viem';
import { describe, expect, it } from 'vitest';
import { type ChainLog, TOKENS, TRANSFER_TOPIC, TRANSFER_WITH_MEMO_TOPIC, memoBytes, runLines, sameLines, verifyPayoutLogs } from '../src/index';
import { OUTSIDER, PAYEES, ROOT, TOKEN, line } from './fake-chain';

const RUN = 'HF-2026-10-0001';
const lines = [line(RUN, 1, PAYEES[0], 1_000_000n), line(RUN, 2, PAYEES[1], 2_500_000n), line(RUN, 3, PAYEES[2], 750_000n)];
const KEYCHAIN = '0xaAAAaaAA00000000000000000000000000000000';
const FEE_MANAGER = '0xfeEC000000000000000000000000000000000000';
const SPONSOR = '0xc444BEC05a6bC61b391C736a9CaBD474E1a297af';

let index = 0;
function log(address: Address, topics: Hex[], amount: bigint): ChainLog {
  return { address, topics, data: toHex(amount, { size: 32 }), logIndex: index++, transactionHash: '0xaa', blockNumber: 1n };
}
const topic = (address: Address) => pad(address).toLowerCase() as Hex;
const transfer = (from: Address, to: Address, amount: bigint, token: Address = TOKEN) => log(token, [TRANSFER_TOPIC, topic(from), topic(to)], amount);
const memoTransfer = (from: Address, to: Address, amount: bigint, memo: string, token: Address = TOKEN) =>
  log(token, [TRANSFER_WITH_MEMO_TOPIC, topic(from), topic(to), memoBytes(memo)], amount);

/** The logs a sponsored three-line payout leaves, in the order the chain emits them. */
function receiptLogs(): ChainLog[] {
  index = 20;
  return [
    transfer(SPONSOR, FEE_MANAGER, 129n),
    ...lines.flatMap((entry) => [
      log(KEYCHAIN, ['0x2d1a2c1e1e4b0d0f6f3d6b3f8a5a3a52e3c0b5e0c1d2e3f4a5b6c7d8e9f0a1b2', topic(ROOT)], entry.amount),
      transfer(ROOT, entry.to, entry.amount),
      memoTransfer(ROOT, entry.to, entry.amount, entry.memo),
    ]),
    transfer(FEE_MANAGER, SPONSOR, 16n),
  ];
}

const verify = (logs: ChainLog[], expected = lines) => verifyPayoutLogs({ root: ROOT, token: TOKEN, lines: expected, logs });
const problemsOf = (logs: ChainLog[], expected = lines) => {
  const check = verify(logs, expected);
  return check.ok ? [] : check.problems;
};

describe('verifying a payout receipt', () => {
  it('accepts exactly one memo transfer per line and reports where each one is', () => {
    const check = verify(receiptLogs());
    expect(check).toEqual({
      ok: true,
      lines: [
        { to: PAYEES[0], amount: 1_000_000n, memo: `${RUN}/1`, logIndex: 23 },
        { to: PAYEES[1], amount: 2_500_000n, memo: `${RUN}/2`, logIndex: 26 },
        { to: PAYEES[2], amount: 750_000n, memo: `${RUN}/3`, logIndex: 29 },
      ],
    });
  });

  it('does not depend on the order of the events', () => {
    expect(verify(receiptLogs().reverse()).ok).toBe(true);
  });

  it('does not need the plain Transfer that accompanies each memo transfer', () => {
    expect(verify(receiptLogs().filter((entry) => entry.topics[0] !== TRANSFER_TOPIC)).ok).toBe(true);
  });

  it('fails when a line has no event', () => {
    const logs = receiptLogs().filter((entry) => entry.topics[3] !== memoBytes(`${RUN}/2`));
    expect(problemsOf(logs)).toContain(`line 2 (${RUN}/2): no TransferWithMemo event carries this memo`);
  });

  it('fails when nothing was emitted at all', () => {
    expect(problemsOf([])).toHaveLength(3);
  });

  it('fails on a wrong amount', () => {
    const logs = receiptLogs().map((entry) => (entry.topics[3] === memoBytes(`${RUN}/2`) ? { ...entry, data: toHex(2_400_000n, { size: 32 }) } : entry));
    expect(problemsOf(logs)).toContain(`line 2 (${RUN}/2): 2.40 on chain, expected 2.50`);
  });

  it('fails on a wrong memo', () => {
    const logs = receiptLogs().map((entry) => (entry.topics[3] === memoBytes(`${RUN}/3`) ? { ...entry, topics: [...entry.topics.slice(0, 3), memoBytes('HF-2026-10-0002/3')] } : entry));
    const problems = problemsOf(logs);
    expect(problems).toContain(`line 3 (${RUN}/3): no TransferWithMemo event carries this memo`);
    expect(problems).toContain(`unexpected TransferWithMemo of 0.75 to ${PAYEES[2]} with memo HF-2026-10-0002/3`);
  });

  it('fails on a wrong recipient', () => {
    const logs = receiptLogs().map((entry) => (entry.topics[3] === memoBytes(`${RUN}/1`) ? { ...entry, topics: [entry.topics[0] as Hex, entry.topics[1] as Hex, topic(OUTSIDER), entry.topics[3] as Hex] } : entry));
    expect(problemsOf(logs)).toContain(`line 1 (${RUN}/1): paid to ${OUTSIDER}, expected ${PAYEES[0]}`);
  });

  it('fails when the transfer happened in another token', () => {
    const beta = TOKENS.moderato.BetaUSD;
    const logs = receiptLogs().map((entry) => (entry.topics[3] === memoBytes(`${RUN}/1`) ? { ...entry, address: beta } : entry));
    expect(problemsOf(logs).some((problem) => problem.startsWith(`line 1 (${RUN}/1): paid in token`))).toBe(true);
  });

  it('fails on an extra memo transfer', () => {
    index = 90;
    const logs = [...receiptLogs(), memoTransfer(ROOT, OUTSIDER, 5_000_000n, 'HF-2026-10-0001/4')];
    expect(problemsOf(logs)).toEqual([`unexpected TransferWithMemo of 5.00 to ${OUTSIDER} with memo ${RUN}/4`]);
  });

  it('fails when a line was paid twice', () => {
    index = 90;
    const logs = [...receiptLogs(), memoTransfer(ROOT, PAYEES[0], 1_000_000n, `${RUN}/1`)];
    expect(problemsOf(logs)).toEqual([`unexpected TransferWithMemo of 1.00 to ${PAYEES[0]} with memo ${RUN}/1`]);
  });

  it('fails on an extra plain transfer out of the account', () => {
    index = 90;
    expect(problemsOf([...receiptLogs(), transfer(ROOT, OUTSIDER, 9_000_000n)])).toEqual([`unexpected Transfer of 9.00 from the account to ${OUTSIDER}`]);
    expect(problemsOf([...receiptLogs(), transfer(ROOT, OUTSIDER, 1n, TOKENS.moderato.BetaUSD)])).toHaveLength(1);
  });

  it('ignores movements that are not out of the account', () => {
    index = 90;
    expect(verify([...receiptLogs(), transfer(OUTSIDER, ROOT, 1n), memoTransfer(SPONSOR, OUTSIDER, 1n, 'someone else')]).ok).toBe(true);
  });

  it('accepts the zero transfer that carries a key authorization', () => {
    index = 5;
    const carrier = { to: ROOT, amount: 0n, memo: 'HF-KEY-AUTHORIZED' };
    expect(verify([transfer(ROOT, ROOT, 0n), memoTransfer(ROOT, ROOT, 0n, carrier.memo)], [carrier]).ok).toBe(true);
  });
});

describe('reading a run out of a receipt', () => {
  it('returns the memo transfers of that run only', () => {
    index = 90;
    const logs = [...receiptLogs(), memoTransfer(ROOT, PAYEES[0], 1n, 'HF-2026-10-00010/1'), memoTransfer(OUTSIDER, PAYEES[0], 1n, `${RUN}/9`)];
    expect(runLines(logs, ROOT, TOKEN, RUN).map((entry) => entry.memo)).toEqual([`${RUN}/1`, `${RUN}/2`, `${RUN}/3`]);
    expect(runLines(logs, ROOT, TOKEN, 'HF-2026-10-00010')).toHaveLength(1);
    expect(runLines(logs, ROOT, TOKENS.moderato.BetaUSD, RUN)).toEqual([]);
  });

  it('compares the lines of a run regardless of order and address case', () => {
    const found = [...lines].reverse().map((entry, i) => ({ ...entry, to: entry.to.toLowerCase() as Address, logIndex: i }));
    expect(sameLines(lines, found)).toBe(true);
    expect(sameLines(lines.slice(0, 2), found)).toBe(false);
    expect(sameLines(lines, found.map((entry) => ({ ...entry, amount: entry.amount + 1n })))).toBe(false);
    expect(sameLines([lines[0]!, lines[0]!], [found[2]!, found[1]!])).toBe(false);
  });
});
