import { DEFAULT_POLICY, type Policy } from '@holdfast/core';
import { describe, expect, it } from 'vitest';
import { castCall, hyperEvmTxUrl, lockHref, lockParams, parseSnapshot } from '../../src/app/_sections/lock/params';
import { POLICY_FIELDS, policyChanges, policyInWords, policyProblems, policyToText, readPolicy, shown, toText } from '../../src/app/_sections/lock/policy';
import { previewFigures, zecText } from '../../src/app/_sections/lock/preview';
import { marginScale, shareOf, standingOf } from '../../src/app/_sections/lock/scale';
import { decisionWords, fundingWords, lotsAsZec, modeWord, orderWords, standingWords, switchWords } from '../../src/app/_sections/lock/words';

describe('the margin scale', () => {
  it('carries the floor, the threshold and the target of the policy, in the order of the scale', () => {
    const scale = marginScale(DEFAULT_POLICY, 8_790);
    expect(scale.marks.map((mark) => [mark.key, mark.bps])).toEqual([
      ['floor', 2_000],
      ['topUp', 6_400],
      ['target', 8_000],
    ]);
    expect(scale.zones).toEqual([
      { key: 'buyBack', fromBps: 0, toBps: 2_000 },
      { key: 'topUp', fromBps: 2_000, toBps: 6_400 },
      { key: 'held', fromBps: 6_400, toBps: scale.maxBps },
    ]);
  });

  it('ends a fifth beyond the target, or beyond the ratio when that is further out, in whole steps of twenty percent', () => {
    expect(marginScale(DEFAULT_POLICY, null).maxBps).toBe(10_000);
    expect(marginScale(DEFAULT_POLICY, 8_790).maxBps).toBe(12_000);
    expect(marginScale(DEFAULT_POLICY, 15_000).maxBps).toBe(18_000);
  });

  it('draws a ratio far beyond the target at the end of the scale and says that it is beyond it', () => {
    const scale = marginScale(DEFAULT_POLICY, 90_000);
    expect(scale.maxBps).toBe(32_000);
    expect(scale.pointer).toEqual({ bps: 90_000, clipped: true });
    expect(shareOf(scale, 90_000)).toBe(100);
  });

  it('has no pointer when there is no short', () => {
    const scale = marginScale(DEFAULT_POLICY, null);
    expect(scale.pointer).toBeNull();
    expect(scale.standing).toBe('none');
  });

  it('puts the figures of marks that are close together on separate lines', () => {
    const rows = Object.fromEntries(marginScale(DEFAULT_POLICY, 8_790).marks.map((mark) => [mark.key, mark.row]));
    // On a scale to 120%, 64% and 80% are thirteen percent of its length apart.
    expect(rows).toEqual({ floor: 0, topUp: 0, target: 1 });
    const apart = Object.fromEntries(marginScale({ ...DEFAULT_POLICY, topUpWarnBps: 5_000 }, null).marks.map((mark) => [mark.key, mark.row]));
    expect(apart).toEqual({ floor: 0, topUp: 0, target: 0 });
  });

  it('keeps the zones in order for a policy whose threshold is under its floor', () => {
    const scale = marginScale({ ...DEFAULT_POLICY, topUpWarnBps: 1_000 }, null);
    expect(scale.zones[1]).toEqual({ key: 'topUp', fromBps: 2_000, toBps: 2_000 });
    expect(scale.zones[2]?.fromBps).toBe(2_000);
  });

  it('says where the ratio stands against the policy', () => {
    expect(standingOf(DEFAULT_POLICY, 1_999)).toBe('buyBack');
    expect(standingOf(DEFAULT_POLICY, 2_000)).toBe('topUp');
    expect(standingOf(DEFAULT_POLICY, 6_399)).toBe('topUp');
    expect(standingOf(DEFAULT_POLICY, 6_400)).toBe('belowTarget');
    expect(standingOf(DEFAULT_POLICY, 8_000)).toBe('atTarget');
    expect(standingWords('topUp', DEFAULT_POLICY)).toMatchObject({ state: 'limit', label: 'Top-up asked' });
    expect(standingWords('buyBack', DEFAULT_POLICY).text).toContain('down to what the margin carries at 30.0%');
  });
});

describe('the journal in words', () => {
  const hold = { mode: 'HOLD' as const, targetLots: 1, marginRatioBps: 8_784, actions: [], refusals: [], reasons: ['short matches the treasury'] };

  it('names the modes in the product’s words', () => {
    expect([modeWord('HOLD'), modeWord('REBALANCE'), modeWord('DERISK')]).toEqual(['Hold', 'Rebalance', 'Buy-back']);
  });

  it('writes the reasons as sentences', () => {
    expect(decisionWords({ decision: hold, errors: [] })).toEqual({ mode: 'Hold', lines: ['Short matches the treasury.'], state: null, stateLabel: null });
  });

  it('marks an entry with a refusal, in the refusal’s own words', () => {
    const words = decisionWords({ decision: { ...hold, reasons: [], refusals: [{ code: 'FUNDING_BELOW_FLOOR', detail: 'funding -900 bps APR is under the -500 bps floor' }] }, errors: [] });
    expect(words.lines).toEqual(['Refused, funding -900 bps APR is under the -500 bps floor.']);
    expect(words).toMatchObject({ state: 'refused', stateLabel: 'Refused' });
  });

  it('names the source that failed', () => {
    const words = decisionWords({ decision: { ...hold, reasons: [], refusals: [{ code: 'STALE_HL', detail: 'venue state is missing, old or malformed' }] }, errors: [{ source: 'venue', message: 'connect ETIMEDOUT' }] });
    expect(words.lines).toEqual(['Refused, venue state is missing, old or malformed.', 'Hyperliquid could not be read: connect ETIMEDOUT.']);
    expect(words.state).toBe('refused');
    expect(decisionWords({ decision: hold, errors: [{ source: 'reference', message: 'no answer' }] })).toMatchObject({ state: 'stale', stateLabel: 'Source failed' });
  });

  it('says so when an entry has nothing to say', () => {
    expect(decisionWords({ decision: { ...hold, reasons: [] }, errors: [] }).lines).toEqual(['Nothing to do.']);
  });

  it('states what an order did', () => {
    const order = { seq: 2, cloid: '0xd5ce' as const, side: 'sell' as const, lots: 1, limitPx: 1222.7, reduceOnly: false, result: { ok: true, filledLots: 1, avgPx: 1226.4, oid: '570748779376', error: null } };
    expect(orderWords(order)).toBe('Sold 0.01 ZEC at $1,226.40, order 570748779376.');
    expect(orderWords({ ...order, side: 'buy', lots: 5, result: { ...order.result, filledLots: 2 } })).toBe('Bought back 0.02 ZEC of 0.05 ZEC at $1,226.40, order 570748779376.');
    expect(orderWords({ ...order, result: { ok: false, filledLots: 0, avgPx: null, oid: null, error: 'outcome unknown: socket hang up' } })).toBe('Sell 0.01 ZEC at a limit of $1,222.70: not filled. Outcome unknown: socket hang up.');
    expect(orderWords(null)).toBeNull();
  });

  it('writes lots as ZEC', () => {
    expect(lotsAsZec(1)).toBe('0.01 ZEC');
    expect(lotsAsZec(250)).toBe('2.50 ZEC');
  });
});

describe('funding in words', () => {
  it('says who pays whom, and what that means under the policy', () => {
    expect(fundingWords(1_095, DEFAULT_POLICY)).toMatchObject({ who: expect.stringContaining('Longs are paying shorts'), underFloor: false });
    const paying = fundingWords(-300, DEFAULT_POLICY);
    expect(paying.who).toContain('Shorts are paying longs');
    expect(paying.underFloor).toBe(false);
    const under = fundingWords(-501, DEFAULT_POLICY);
    expect(under.underFloor).toBe(true);
    expect(under.consequence).toContain('opens no new short');
    expect(fundingWords(0, DEFAULT_POLICY).who).toContain('Nobody is paying');
  });
});

describe('switching the lock, stated before it is switched', () => {
  const facts = { policy: DEFAULT_POLICY, shortLots: 3, targetLots: 3, agentApproved: true };

  it('says that off buys the whole short back and leaves the margin where it is', () => {
    const words = switchWords({ ...facts, enable: false });
    expect(words.confirm).toBe('Switch the lock off');
    expect(words.lines.join(' ')).toContain('buys back the whole short of 3 lots, 0.03 ZEC, with one immediate-or-cancel limit at most 0.30% over the mark');
    expect(words.lines.join(' ')).toContain('The margin stays on your Hyperliquid account');
  });

  it('says that off has nothing to buy back when no short is open', () => {
    expect(switchWords({ ...facts, enable: false, shortLots: 0 }).lines.join(' ')).toContain('No short is open');
  });

  it('says what on sells towards, under which guards, and what it needs', () => {
    const text = switchWords({ ...facts, enable: true, shortLots: 0 }).lines.join(' ');
    expect(text).toContain('sells towards a short of 3 lots, 0.03 ZEC');
    expect(text).toContain('at most 0.30% under the mark');
    expect(text).toContain('under 180 s old');
    expect(text).toContain('margin carries at 2×');
    expect(text).not.toContain('agent key approved yet');
  });

  it('warns when the agent is not approved, or when that could not be read', () => {
    expect(switchWords({ ...facts, enable: true, agentApproved: false }).lines.join(' ')).toContain('does not show the agent key approved yet');
    expect(switchWords({ ...facts, enable: true, agentApproved: null }).lines.join(' ')).toContain('could not be read');
  });

  it('says so when the treasury calls for no short at all', () => {
    expect(switchWords({ ...facts, enable: true, targetLots: 0 }).lines.join(' ')).toContain('calls for no short');
  });
});

describe('the policy as text', () => {
  it('writes every figure in its own unit and reads it back unchanged', () => {
    const text = policyToText(DEFAULT_POLICY);
    expect(text).toMatchObject({ marginTargetBps: '80', maxSlippageBps: '0.3', fundingFloorAprBps: '-5', maxDataAgeMs: '180', maxLeverage: '2', bandLots: '1', minOrderUsd: '10', maxOracleRefDivBps: '1.5' });
    expect(readPolicy(text)).toEqual({ ok: true, policy: DEFAULT_POLICY });
    expect(POLICY_FIELDS.map((field) => field.key).sort()).toEqual((Object.keys(DEFAULT_POLICY) as (keyof Policy)[]).sort());
  });

  it('shows figures with their units', () => {
    expect(shown('marginTargetBps', 8_000)).toBe('80.0%');
    expect(shown('maxSlippageBps', 30)).toBe('0.30%');
    expect(shown('fundingFloorAprBps', -500)).toBe('−5.0% a year');
    expect(shown('maxDataAgeMs', 180_000)).toBe('180 s');
    expect(shown('maxLeverage', 2)).toBe('2×');
    expect(shown('bandLots', 1)).toBe('1 lot');
    expect(shown('minOrderUsd', 10)).toBe('$10');
    expect(toText('maxLeverage', 2.5)).toBe('2.5');
  });

  it('reads a comma as a decimal point and a typographic minus as a minus', () => {
    const read = readPolicy({ ...policyToText(DEFAULT_POLICY), maxSlippageBps: '0,45', fundingFloorAprBps: '−7.5' });
    expect(read).toMatchObject({ ok: true, policy: { maxSlippageBps: 45, fundingFloorAprBps: -750 } });
  });

  it('refuses what is not a figure, at its field', () => {
    const read = readPolicy({ ...policyToText(DEFAULT_POLICY), marginTargetBps: 'eighty', bandLots: '1.5', maxSlippageBps: '0.305', topUpWarnBps: '' });
    expect(read).toEqual({ ok: false, general: [], errors: { marginTargetBps: 'Write a plain number, such as 80 or 0.3.', bandLots: 'A whole number is needed here.', maxSlippageBps: 'At most 2 decimals.', topUpWarnBps: 'A figure is needed here.' } });
  });

  it('refuses what the server’s own check refuses, in the units of the editor', () => {
    const tooLow = readPolicy({ ...policyToText(DEFAULT_POLICY), marginTargetBps: '40' });
    expect(tooLow).toMatchObject({ ok: false, errors: { marginTargetBps: 'Must be at least 50.0%, the margin ratio the leverage cap stands for.', topUpWarnBps: 'Must be below the target margin.' } });
    const outOfRange = readPolicy({ ...policyToText(DEFAULT_POLICY), maxSlippageBps: '6' });
    expect(outOfRange).toMatchObject({ ok: false, errors: { maxSlippageBps: 'Must be between 0.01% and 5.0%.' } });
    const restore = readPolicy({ ...policyToText(DEFAULT_POLICY), deRiskRestoreBps: '15' });
    expect(restore).toMatchObject({ ok: false, errors: { deRiskRestoreBps: 'Must be above the buy-back floor.' } });
  });

  it('puts the server’s reasons beside their fields and keeps one it does not know as it came', () => {
    expect(policyProblems(['sweepAboveBps must be above marginTargetBps', 'unknown field colour'])).toEqual({ errors: { sweepAboveBps: 'Must be above the target margin.' }, general: ['unknown field colour'] });
  });

  it('lists what a save would change', () => {
    expect(policyChanges(DEFAULT_POLICY, DEFAULT_POLICY)).toEqual([]);
    expect(policyChanges(DEFAULT_POLICY, { ...DEFAULT_POLICY, marginTargetBps: 8_500, maxLeverage: 1.5 })).toEqual([
      { key: 'marginTargetBps', label: 'Target margin', from: '80.0%', to: '85.0%' },
      { key: 'maxLeverage', label: 'Leverage cap', from: '2×', to: '1.5×' },
    ]);
  });

  it('states the policy in a paragraph with its own numbers', () => {
    expect(policyInWords(DEFAULT_POLICY)).toBe(
      'The short covers 100.0% of the treasury’s ZEC. A lock starts with margin worth 80.0% of the short. Under 64.0% the service asks the treasurer for a top-up back to 80.0%. Under 20.0% the controller buys back part of the short, down to what the margin carries at 30.0%.',
    );
  });
});

describe('the address of a Lock page', () => {
  it('reads an older journal page and a proof out of the query', () => {
    expect(lockParams({})).toEqual({ before: null, check: null, snapshot: null });
    expect(lockParams({ before: '120', check: '2', snapshot: '0.1' })).toEqual({ before: 120, check: 2, snapshot: { series: 0n, number: 1n } });
    expect(lockParams({ check: ['7', '8'] }).check).toBe(7);
  });

  it('treats anything that is not what it should be as absent', () => {
    expect(lockParams({ before: '0', check: '-1', snapshot: '1' })).toEqual({ before: null, check: null, snapshot: null });
    expect(lockParams({ before: '2.5', check: '99999999999', snapshot: '0.1.2' })).toEqual({ before: null, check: null, snapshot: null });
    expect(parseSnapshot('01.2')).toBeNull();
    expect(parseSnapshot('a.b')).toBeNull();
  });

  it('writes the address back', () => {
    expect(lockHref('/demo', {})).toBe('/demo/lock');
    expect(lockHref('/app', { before: 120 }, 'journal')).toBe('/app/lock?before=120#journal');
    expect(lockHref('/demo', { before: null, check: 2, snapshot: { series: 0n, number: 1n } }, 'proof')).toBe('/demo/lock?check=2&snapshot=0.1#proof');
  });

  it('prints the call that asks the contract the same question', () => {
    const call = castCall({
      contract: '0xa6aFA5c68146BbD4C49510987847C7C38837824E',
      chainId: 999,
      account: '0xC7e7BAAFb0C822d0A934BbB2268F15A7eD8485bc',
      series: 0n,
      number: 0n,
      leaf: '0x1071afec6513bb629db9e62c7731e26ed6c534d2eb61d911a9dcf2499c564c62',
      proof: ['0x487c', '0x4b18'],
    });
    expect(call.split('\n')).toEqual([
      'cast call 0xa6aFA5c68146BbD4C49510987847C7C38837824E \\',
      '  "verifyEntry(address,uint256,uint256,bytes32,bytes32[])(bool)" \\',
      '  0xC7e7BAAFb0C822d0A934BbB2268F15A7eD8485bc 0 0 \\',
      '  0x1071afec6513bb629db9e62c7731e26ed6c534d2eb61d911a9dcf2499c564c62 \\',
      '  "[0x487c,0x4b18]" \\',
      '  --rpc-url https://rpc.hyperliquid.xyz/evm',
    ]);
    expect(castCall({ contract: '0x1', chainId: 998, account: '0x2', series: '1', number: '2', leaf: '0x3', proof: [] })).toContain('<an RPC endpoint of chain 998>');
  });

  it('links a HyperEVM transaction only on the chain whose explorer it knows', () => {
    expect(hyperEvmTxUrl(999, '0xfeaf')).toBe('https://hyperevmscan.io/tx/0xfeaf');
    expect(hyperEvmTxUrl(998, '0xfeaf')).toBeNull();
  });
});

describe('the figures of a preview', () => {
  it('derives what is kept, the share sold and the cost of the swap', () => {
    const figures = previewFigures({ treasuryZat: 10_000_000_000n, sellZat: 4_456_824_513n, px: 1_200, swapCostBps: 50 });
    expect(figures.keptZat).toBe(5_543_175_487n);
    expect(figures.soldShareBps).toBe(4_456);
    expect(figures.swapCostUsd).toBeCloseTo(44.56824513 * 1_200 * 0.005, 6);
    expect(previewFigures({ treasuryZat: 0n, sellZat: 0n, px: 1, swapCostBps: 50 }).soldShareBps).toBe(0);
  });

  it('writes zatoshi as ZEC', () => {
    expect(zecText(1_030_000n)).toBe('0.0103');
    expect(zecText(250_000_000n)).toBe('2.5');
    expect(zecText(0n)).toBe('0');
  });
});
