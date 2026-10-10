import type { PayoutLine } from '@holdfast/core';
import { describe, expect, it } from 'vitest';
import { MAX_LINES_PER_RUN, TOKENS, TRANSFER_WITH_MEMO_SELECTOR, feeCeiling, gasCeiling } from '../src/index';
import { OUTSIDER, PAYEES, ROOT, START, TOKEN, line, setup } from './fake-chain';

const RUN = 'HF-2026-10-0001';
const lines = [line(RUN, 1, PAYEES[0], 1_000_000n), line(RUN, 2, PAYEES[1], 2_500_000n), line(RUN, 3, PAYEES[2], 750_000n)];

async function problems(arrange: (ctx: ReturnType<typeof setup>) => void, input: { lines?: PayoutLine[]; runId?: string; account?: string } = {}): Promise<string[]> {
  const ctx = setup();
  arrange(ctx);
  const result = await ctx.rail.preflight({ account: input.account ?? ROOT, lines: input.lines ?? lines, ...(input.runId === undefined ? {} : { runId: input.runId }) });
  expect(ctx.chain.signed).toHaveLength(0);
  expect(ctx.chain.broadcasts).toHaveLength(0);
  return result.ok ? [] : result.problems;
}

describe('preflight', () => {
  it('passes a run the key, the account and the sponsor can all carry', async () => {
    expect(await problems(() => undefined)).toEqual([]);
    expect(await problems(() => undefined, { runId: RUN })).toEqual([]);
  });

  it('refuses a revoked key', async () => {
    const found = await problems(({ chain }) => chain.revoke());
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^access key 0x[0-9a-fA-F]{40} was revoked$/);
  });

  it('refuses an expired key', async () => {
    const found = await problems(({ chain }) => {
      chain.key = { ...chain.key, expiry: BigInt(START - 10) };
    });
    expect(found).toEqual([expect.stringMatching(/ expired at 2026-10-10T\d\d:\d\d:\d\d\.000Z$/)]);
  });

  it('refuses a key that expires before the payout is certain to settle', async () => {
    const found = await problems(({ chain }) => {
      chain.key = { ...chain.key, expiry: BigInt(START + 30) };
    });
    expect(found).toEqual([expect.stringMatching(/ expires at .*, before a payout sent now is certain to settle$/)]);
  });

  it('refuses a key the account never authorized', async () => {
    const found = await problems(({ chain }) => chain.forget());
    expect(found).toEqual([expect.stringMatching(/ is not authorized on this account$/)]);
  });

  it('refuses a run larger than what the key may still spend', async () => {
    const found = await problems(({ chain }) => {
      chain.key = { ...chain.key, remaining: 4_000_000n };
    });
    expect(found).toEqual([expect.stringMatching(/^the run totals 4\.25 but the key may only spend 4\.00 more until 2026-10-10T/)]);
  });

  it('lets a run spend the limit to the last unit, since the sponsor pays the fee', async () => {
    expect(
      await problems(({ chain }) => {
        chain.key = { ...chain.key, remaining: 4_250_000n };
      }),
    ).toEqual([]);
  });

  it('refuses a payee outside the recipient allow-list', async () => {
    const found = await problems(() => undefined, { lines: [lines[0]!, line(RUN, 2, OUTSIDER, 1n)] });
    expect(found).toEqual([`line 2: ${OUTSIDER} is not on the key's recipient allow-list`]);
  });

  it('accepts any payee when the key has no recipient list', async () => {
    const found = await problems(
      ({ chain }) => {
        chain.key = { ...chain.key, scopes: [{ target: TOKEN, selectorRules: [{ selector: TRANSFER_WITH_MEMO_SELECTOR, recipients: [] }] }] };
      },
      { lines: [line(RUN, 1, OUTSIDER, 1n)] },
    );
    expect(found).toEqual([]);
  });

  it('refuses a key that is scoped to another token', async () => {
    const found = await problems(({ chain }) => {
      chain.key = { ...chain.key, scopes: [{ target: TOKENS.moderato.BetaUSD, selectorRules: [{ selector: TRANSFER_WITH_MEMO_SELECTOR, recipients: [] }] }] };
    });
    expect(found).toEqual([expect.stringMatching(/ is not the bounded payout key this rail accepts: it may call other contracts \(0x20c0.*2\); it may not call transferWithMemo on the payout token$/)]);
  });

  it('refuses a key without a spending limit, and one without a call scope', async () => {
    const unlimited = await problems(({ chain }) => {
      chain.key = { ...chain.key, enforceLimits: false, remaining: 0n };
    });
    expect(unlimited).toEqual([expect.stringMatching(/ is not the bounded payout key this rail accepts: it has no spending limit$/)]);
    const unscoped = await problems(({ chain }) => {
      chain.key = { ...chain.key, isScoped: false, scopes: [] };
    });
    expect(unscoped).toEqual([expect.stringMatching(/ is not the bounded payout key this rail accepts: it has no call scope and may call anything$/)]);
  });

  it('refuses a run the account cannot fund', async () => {
    const found = await problems(({ chain }) => {
      chain.rootBalance = 4_000_000n;
    });
    expect(found).toEqual(['the run totals 4.25 but the account holds 4.00 of the payout token']);
  });

  it('refuses when the sponsor cannot cover the worst-case fee', async () => {
    const found = await problems(({ chain }) => {
      chain.sponsorBalance = 100n;
    });
    expect(found).toEqual([expect.stringMatching(/^fee sponsor 0x[0-9a-fA-F]{40} holds 0\.0001 of the fee token, the fee may reach 0\.00\d+$/)]);
  });

  it('refuses an invalid memo without reading the chain', async () => {
    const found = await problems(({ chain }) => chain.failing.add('keyState'), { lines: [{ ...lines[0]!, memo: 'caf\u00e9' }, { ...lines[1]!, memo: 'x'.repeat(33) }, { ...lines[2]!, memo: '' }] });
    expect(found).toEqual([expect.stringContaining('line 1: memo "caf\u00e9" has a non-printable or non-ASCII character'), expect.stringContaining('line 2: memo'), 'line 3: memo is empty']);
  });

  it('refuses two lines with the same memo', async () => {
    const found = await problems(() => undefined, { lines: [lines[0]!, { ...lines[1]!, memo: lines[0]!.memo }] });
    expect(found).toEqual([`line 2: memo "${RUN}/1" is used by an earlier line`]);
  });

  it('refuses more lines than one transaction may carry', async () => {
    const many = Array.from({ length: MAX_LINES_PER_RUN + 1 }, (_, i) => line('HF-BIG', i + 1, PAYEES[i % 3]!, 1n));
    expect(await problems(() => undefined, { lines: many })).toEqual([`33 lines exceed the ${MAX_LINES_PER_RUN} calls one Tempo transaction may carry`]);
    expect(await problems(() => undefined, { lines: many.slice(0, MAX_LINES_PER_RUN) })).toEqual([]);
  });

  it('refuses an empty run, a zero amount and a malformed payee', async () => {
    expect(await problems(() => undefined, { lines: [] })).toEqual(['the run has no payout lines']);
    expect(await problems(() => undefined, { lines: [{ ...lines[0]!, amount: 0n }] })).toEqual(['line 1: amount must be positive']);
    expect(await problems(() => undefined, { lines: [{ ...lines[0]!, to: '0x1234' }] })).toEqual(['line 1: "0x1234" is not a valid address']);
    // One wrong character in a checksummed address.
    expect(await problems(() => undefined, { lines: [{ ...lines[0]!, to: PAYEES[0].replace('3c71', '3C71') }] })).toHaveLength(1);
  });

  it('refuses memos that are not line memos of the run id, when one is given', async () => {
    const found = await problems(() => undefined, { runId: 'HF-2026-10-0002' });
    expect(found).toHaveLength(3);
    expect(found[0]).toBe(`line 1: memo "${RUN}/1" is not "HF-2026-10-0002/<line>" with a line from 1 to 32`);
    const named = await problems(() => undefined, { runId: RUN, lines: [{ ...lines[0]!, memo: `${RUN}/ana` }] });
    expect(named).toEqual([`line 1: memo "${RUN}/ana" is not "${RUN}/<line>" with a line from 1 to 32`]);
    expect(await problems(() => undefined, { runId: 'HF/2' })).toEqual([expect.stringContaining('run id "HF/2" may only use')]);
  });

  it('refuses a malformed account, and an account that is its own sponsor', async () => {
    expect(await problems(() => undefined, { account: 'nope' })).toEqual(['account "nope" is not a valid address']);
    const ctx = setup();
    const result = await ctx.rail.preflight({ account: ctx.rail.sponsorAddress, lines });
    expect(result).toEqual({ ok: false, problems: ['the fee sponsor must be a different account from the one paying out'] });
  });

  it('reports every chain-side problem at once', async () => {
    const found = await problems(({ chain }) => {
      chain.key = { ...chain.key, remaining: 1n };
      chain.rootBalance = 0n;
      chain.sponsorBalance = 0n;
    });
    expect(found).toHaveLength(3);
  });

  it('never says ok when the chain cannot be read', async () => {
    expect(await problems(({ chain }) => chain.failing.add('keyState'))).toEqual(['could not read the chain: keyState failed: fetch failed']);
    expect(
      await problems(({ chain }) => {
        chain.wrongChain = true;
      }),
    ).toEqual(['could not read the chain: the RPC serves chain 4217, but moderato is chain 42431']);
  });
});

describe('fee ceiling', () => {
  it('stays above the gas measured on Moderato', () => {
    // 3 first-time payees plus the first use of the lane: 1.05M; 32 first-time payees: 8.57M; 32 known payees: 0.65M.
    expect(gasCeiling(3)).toBeGreaterThan(1_050_000n);
    expect(gasCeiling(32)).toBeGreaterThan(8_565_480n + 250_000n);
    // Provisioning with 3 allow-listed payees: 4.35M; with 25: 15.55M.
    expect(gasCeiling(1, { recipients: 3 }) - gasCeiling(1)).toBeGreaterThan(4_347_490n);
    expect(gasCeiling(1, { recipients: 25 }) - gasCeiling(1)).toBeGreaterThan(15_545_665n);
  });

  it('converts gas at three times the base fee into token units, rounding up', () => {
    expect(feeCeiling(1_000_000n, 600_000_000n)).toBe(1_800n);
    expect(feeCeiling(1n, 1n)).toBe(1n);
    expect(feeCeiling(0n, 600_000_000n)).toBe(0n);
  });
});
