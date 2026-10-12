import type { KeyStatus } from '@holdfast/tempo';
import { describe, expect, it } from 'vitest';
import { hyperEvmUrl, sourceName } from '../../src/app/_sections/safety/links';
import { type SafetyData, keyCards, readSolanaError, refusalCards, solanaScope, tempoScope } from '../../src/app/_sections/safety/model';
import { probeSpecs } from '../../src/app/_sections/safety/probes';
import { drawSealPlate } from '../../src/app/_sections/safety/seal';

const NOW = Date.UTC(2026, 9, 12, 18);
const USDC_E = { symbol: 'USDC.e', decimals: 6 };
const PAYEES = ['0x7EB73149b648D8d3aF9b86b2ACb2e525bDb32CC8', '0x0c9D4C19f931f053c90a50B25F0B1f92d3373092'] as const;
const AGENT = '0x677811d01c4250c2e3677a85b430a82f078c5928';
const ACCOUNT = '0xC7e7BAAFb0C822d0A934BbB2268F15A7eD8485bc';

const bounded: KeyStatus = {
  accessKey: '0x4527180245A3a804CeD5F7f5Dffd6B516a1366cd',
  authorized: true,
  live: true,
  mismatch: [],
  revoked: false,
  expiresAt: NOW + 27 * 86_400_000,
  limited: true,
  remaining: 1_250_000n,
  periodEnd: NOW + 27 * 86_400_000,
  scope: { unrestricted: false, selectors: ['0x95777d59'], recipients: [...PAYEES], otherTargets: [] },
};

const textOf = (scope: ReturnType<typeof tempoScope>, label: string): unknown => {
  if (scope.status !== 'ok') return undefined;
  const line = scope.lines.find((candidate) => candidate.label === label);
  if (line === undefined) return undefined;
  return 'text' in line ? line.text : 'figure' in line ? line.figure : 'time' in line ? line.time : line.addresses;
};

describe('the Tempo access key as the page states it', () => {
  it('shows a bounded key by what is left, when the period ends, when it expires, what it may call and whom it may pay', () => {
    const scope = tempoScope(bounded, USDC_E, 'tempo', NOW);
    expect(scope).toMatchObject({ status: 'ok', source: 'tempo', at: NOW, state: 'limit', headline: '1.25 USDC.e left', warnings: [] });
    expect(textOf(scope, 'Left in this period')).toBe('1.25 USDC.e');
    expect(textOf(scope, 'Period ends')).toBe(bounded.periodEnd);
    expect(textOf(scope, 'Expires')).toBe(bounded.expiresAt);
    expect(textOf(scope, 'May call')).toBe('transferWithMemo on USDC.e, and no other function.');
    expect(textOf(scope, 'May pay')).toEqual([...PAYEES]);
  });

  it('calls a one-off limit what it is, and a key without recipients one that may pay anyone', () => {
    const scope = tempoScope({ ...bounded, periodEnd: null, expiresAt: null, scope: { ...bounded.scope, recipients: null } }, USDC_E, 'tempo', NOW);
    expect(textOf(scope, 'Left of its limit')).toBe('1.25 USDC.e');
    expect(textOf(scope, 'Period ends')).toBeUndefined();
    expect(textOf(scope, 'Expires')).toBe('No expiry is set.');
    expect(textOf(scope, 'May pay')).toBe('Any recipient.');
  });

  it('never shows a limit for a key the service does not pay with', () => {
    const unknown: KeyStatus = { ...bounded, authorized: false, live: false, expiresAt: null, remaining: 0n, periodEnd: null, scope: { unrestricted: true, selectors: null, recipients: null, otherTargets: [] } };
    expect(tempoScope(unknown, USDC_E, 'tempo', NOW)).toMatchObject({ state: 'unlocked', headline: 'Not authorized', lines: [{ label: 'Standing' }] });
    expect(tempoScope({ ...unknown, revoked: true }, USDC_E, 'tempo', NOW)).toMatchObject({ state: 'refused', headline: 'Revoked' });

    const expired = tempoScope({ ...unknown, expiresAt: NOW - 1 }, USDC_E, 'tempo', NOW);
    expect(expired).toMatchObject({ state: 'unlocked', headline: 'Expired' });
    expect(textOf(expired, 'Expired')).toBe(NOW - 1);

    const broad = tempoScope({ ...bounded, authorized: false, limited: false, remaining: 0n, periodEnd: null, mismatch: ['it has no spending limit', 'it has no call scope and may call anything'], scope: { unrestricted: true, selectors: null, recipients: null, otherTargets: [] } }, USDC_E, 'tempo', NOW);
    expect(broad).toMatchObject({ state: 'refused', headline: 'Not used: too broad', warnings: ['It has no spending limit.', 'It has no call scope and may call anything.'] });
    expect(textOf(broad, 'May call')).toBe('Any call: the key has no call scope.');
    for (const scope of [unknown, { ...unknown, revoked: true }]) expect(textOf(tempoScope(scope, USDC_E, 'tempo', NOW), 'Left in this period')).toBeUndefined();
  });

  it('says in words what a scope other than the expected one lets a key call', () => {
    const calls = (scope: KeyStatus['scope']) => textOf(tempoScope({ ...bounded, scope }, USDC_E, 'tempo', NOW), 'May call');
    expect(calls({ unrestricted: false, selectors: null, recipients: null, otherTargets: [] })).toBe('Every function of USDC.e.');
    expect(calls({ unrestricted: false, selectors: [], recipients: [], otherTargets: [] })).toBe('No function of USDC.e.');
    expect(calls({ unrestricted: false, selectors: ['0x95777d59', '0xa9059cbb'], recipients: null, otherTargets: [] })).toBe('transferWithMemo and 0xa9059cbb on USDC.e.');
    expect(calls({ unrestricted: false, selectors: ['0x95777d59'], recipients: [], otherTargets: ['0x20c0000000000000000000000000000000000000'] })).toBe('transferWithMemo on USDC.e, and no other function. It may also call another contract.');
  });
});

describe('the Solana delegate as the page states it', () => {
  it('shows what is left of the allowance, or that there is none', () => {
    expect(solanaScope({ owner: 'B1zT', remaining: 750_000n }, { symbol: 'USDC', decimals: 6 }, 'solana', NOW)).toMatchObject({ state: 'limit', headline: '0.75 USDC left', lines: [{ label: 'Allowance left', figure: '0.75 USDC' }] });
    expect(solanaScope({ owner: 'B1zT', remaining: 0n }, { symbol: 'USDC', decimals: 6 }, 'solana', NOW)).toMatchObject({ state: 'unlocked', headline: 'No allowance' });
  });
});

const facts: SafetyData['facts'] = {
  network: 'mainnet',
  treasury: { status: 'ok', source: 'viewing key', readAt: NOW, value: { address: 'u1dafv4je7nx5y363sj8cs3te0hcfkwytp84wy3u3e43quvgqkvqhrhtgst0cvh33jk5xew3d3026qsx3at6envp2crvwl72mcksxzl5c3' } },
  hyperliquidAccount: ACCOUNT,
  tempo: { network: 'mainnet', account: '0x43E69cd36fbf1Bbe73E03Dd5d06c8ff9f81Be4c8', token: { address: '0x20C000000000000000000000b9537d11c60E8b50', ...USDC_E } },
  solana: { cluster: 'mainnet-beta', owner: 'B1zTmCPofZo7TZET5k7jL43FzVG5TFcbQPijYi7mFV97', token: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6 } },
  attestor: { contract: '0xa6aFA5c68146BbD4C49510987847C7C38837824E', chainId: 999, everyMinutes: 60 },
};

const data: SafetyData = {
  keys: [
    { kind: 'zcash_viewing_key', address: null, chain: 'zcash', enforcedBy: 'the Zcash protocol: a viewing key carries no authority to spend', scope: { status: 'ok', source: 'key format', readAt: NOW, value: { canView: true, canSpend: false } } },
    { kind: 'hl_agent', address: AGENT, chain: 'hyperliquid', enforcedBy: 'Hyperliquid', scope: { status: 'unavailable', source: 'hyperliquid', readAt: NOW, reason: 'the Hyperliquid adapter has no read of the agents an account has approved' } },
    { kind: 'tempo_access', address: bounded.accessKey, chain: 'tempo', enforcedBy: 'the Tempo Account Keychain', scope: { status: 'ok', source: 'tempo', readAt: NOW, value: bounded } },
    { kind: 'solana_delegate', address: 'HBy3fT36LiCgfBuf1mymsxRwv2DDKQd5MB8z8DJghnu3', chain: 'solana', enforcedBy: 'the SPL Token program', scope: { status: 'ok', source: 'solana', readAt: NOW, value: { owner: facts.solana.owner, remaining: 750_000n } } },
    { kind: 'hl_attester', address: '0xab529b0da6e787ff23092d00e98db6c1160b33a5', chain: 'hyperliquid', enforcedBy: 'the HedgeAttestor contract on HyperEVM', scope: { status: 'ok', source: 'hyperevm', readAt: NOW, value: { registered: true } } },
  ],
  refusals: [
    { id: 'r4', chain: 'solana', kind: 'revoked_delegate', attempted: 'a transfer of one base unit by the delegate after the owner revoked it', outcome: '{"InstructionError":[1,{"Custom":4}]}', tx: 'Fjdu', txUrl: 'https://explorer.solana.com/tx/Fjdu', at: NOW - 4 },
    { id: 'r3', chain: 'tempo', kind: 'over_limit', attempted: 'transferWithMemo of the largest amount there is', outcome: 'SpendingLimitExceeded', tx: '0x2246', txUrl: 'https://explore.tempo.xyz/tx/0x2246', at: NOW - 5 },
    { id: 'r2', chain: 'hyperliquid', kind: 'withdraw3', attempted: `a withdrawal to the organisation's own account, signed by the agent key ${AGENT}`, outcome: `Must deposit before performing actions. User: ${AGENT}`, tx: null, txUrl: null, at: NOW - 6 },
    { id: 'r1', chain: 'hyperliquid', kind: 'usdSend', attempted: 'a transfer of dollars', outcome: 'Insufficient balance for withdrawal', tx: null, txUrl: null, at: NOW - 7 },
  ],
  attestation: { status: 'ok', source: 'hyperevm', readAt: NOW, value: null },
  facts,
};

describe('the keys on the Safety page', () => {
  it('are one card each, in the server’s order, with the account each acts on and its scope as read', () => {
    const cards = keyCards(data);
    expect(cards.map((card) => [card.id, card.name, card.chain, card.scope.status === 'ok' ? card.scope.headline : card.scope.status, card.refusals])).toEqual([
      ['viewing', 'Viewing key', 'Zcash', 'Cannot spend', 0],
      ['agent', 'Agent key', 'Hyperliquid', 'unavailable', 2],
      ['access', 'Access key', 'Tempo', '1.25 USDC.e left', 1],
      ['delegate', 'Token delegate', 'Solana', '0.75 USDC left', 1],
      ['attester', 'Attester key', 'HyperEVM', 'Named by the account', 0],
    ]);
    expect(cards[1]?.scope).toEqual({ status: 'unavailable', source: 'hyperliquid', reason: 'the Hyperliquid adapter has no read of the agents an account has approved', at: NOW });
    expect(cards.map((card) => card.actsOn.value)).toEqual([facts.treasury.status === 'ok' ? facts.treasury.value.address : null, ACCOUNT, facts.tempo.account, facts.solana.owner, ACCOUNT]);
    expect(cards.map((card) => card.enforcedBy.endsWith('.'))).toEqual([true, true, true, true, true]);
    expect(cards[0]?.enforcedBy).toBe('The Zcash protocol: a viewing key carries no authority to spend.');
  });

  it('never show the viewing key, and show the treasury address in its place', () => {
    const [viewing] = keyCards(data);
    expect(viewing?.address).toMatchObject({ value: null });
    expect(viewing?.address.note).toContain('Never shown');
    expect(viewing?.actsOn).toMatchObject({ label: 'Reads', value: expect.stringMatching(/^u1/) });
  });

  it('say what is missing where an account is not named or an answer cannot be read', () => {
    const bare: SafetyData = {
      ...data,
      facts: { ...facts, treasury: { status: 'unavailable', source: 'viewing key', readAt: NOW, reason: 'the stored viewing key no longer passes its check' }, tempo: { ...facts.tempo, account: null }, solana: { ...facts.solana, owner: null } },
      keys: data.keys.map((key) => (key.kind === 'hl_attester' ? { ...key, scope: { status: 'ok' as const, source: 'hyperevm', readAt: NOW, value: { registered: false } } } : key.kind === 'solana_delegate' ? { ...key, scope: { status: 'ok' as const, source: 'solana', readAt: NOW, value: 'nonsense' } } : key)),
    };
    const cards = keyCards(bare);
    expect(cards[0]?.actsOn).toMatchObject({ value: null, missing: 'the stored viewing key no longer passes its check' });
    expect(cards[2]?.actsOn).toMatchObject({ value: null, missing: 'The organisation has not named a Tempo account yet.' });
    expect(cards[3]?.scope).toMatchObject({ status: 'unavailable', source: 'solana' });
    expect(cards[4]?.scope).toMatchObject({ status: 'ok', state: 'unlocked', headline: 'Not named' });
  });
});

describe('the refusals on the Safety page', () => {
  it('keep the chain’s own answer and say how each came to be on record', () => {
    const cards = refusalCards(data);
    expect(cards.map((card) => [card.key, card.chainName, card.title, card.tx?.id ?? null])).toEqual([
      ['delegate', 'Solana', 'A transfer after the delegate was revoked', 'Fjdu'],
      ['access', 'Tempo', 'A payment over the limit', '0x2246'],
      ['agent', 'Hyperliquid', 'A withdrawal signed by the agent key', null],
      ['agent', 'Hyperliquid', 'A transfer of dollars signed by the agent key', null],
    ]);
    expect(cards[0]).toMatchObject({ outcome: '{"InstructionError":[1,{"Custom":4}]}', reading: { answer: 'Custom program error 0x4', where: 'Raised by instruction 2 of the transaction.' }, tx: { chain: 'solana', url: 'https://explorer.solana.com/tx/Fjdu' } });
    expect(cards[1]).toMatchObject({ outcome: 'SpendingLimitExceeded', reading: null, attempted: 'transferWithMemo of the largest amount there is.' });
    expect(cards[1]?.how).toContain('reverted');
  });

  it('say of a Hyperliquid refusal that there is no transaction, and whose address the answer names only when it is the agent’s', () => {
    const [, , withdrawal, transfer] = refusalCards(data);
    expect(withdrawal?.tx).toBeNull();
    expect(withdrawal?.how).toContain('not a transaction');
    expect(withdrawal?.how).toContain('The address in the answer is the agent’s own');
    expect(transfer?.how).toContain('not a transaction');
    expect(transfer?.how).not.toContain('The address in the answer');
  });

  it('show a kind or a chain they do not know under its own name', () => {
    const [card] = refusalCards({ ...data, refusals: [{ id: 'x', chain: 'base', kind: 'something_new', attempted: 'a thing', outcome: 'no', tx: '0x1', txUrl: null, at: NOW }] });
    expect(card).toMatchObject({ key: null, chainName: 'base', title: 'Something new', tx: null });
  });

  it('read a Solana error out, and nothing that is not one', () => {
    expect(readSolanaError('{"InstructionError":[1,{"Custom":1}]}')).toEqual({ answer: 'Custom program error 0x1', where: 'Raised by instruction 2 of the transaction.' });
    expect(readSolanaError('{"InstructionError":[0,{"Custom":6001}]}')).toEqual({ answer: 'Custom program error 0x1771', where: 'Raised by instruction 1 of the transaction.' });
    expect(readSolanaError('{"InstructionError":[2,"InvalidAccountData"]}')).toEqual({ answer: 'InvalidAccountData', where: 'Raised by instruction 3 of the transaction.' });
    for (const text of ['SpendingLimitExceeded', '{"InstructionError":"x"}', '{"InstructionError":[-1,{"Custom":1}]}', '{"InstructionError":[1,{"Custom":"1"}]}', '[]', '']) expect(readSolanaError(text)).toBeNull();
  });
});

describe('the probes an owner is offered', () => {
  it('state what each sends and to whom, and name the payee the over-limit probe is aimed at', () => {
    const specs = probeSpecs(data);
    expect(specs.map((spec) => [spec.kind, spec.to.address, spec.blocked])).toEqual([
      ['hyperliquid_withdrawal', ACCOUNT, null],
      ['tempo_over_limit', PAYEES[0], null],
      ['tempo_out_of_scope', facts.tempo.account, null],
      ['solana_over_allowance', facts.solana.owner, null],
    ]);
    expect(specs[0]?.cost).toMatch(/^Nothing/);
    expect(specs[1]?.to.what).toBe('The first recipient the key lists');
    for (const spec of specs.slice(1)) expect(spec.cost).toContain('fee');
  });

  it('are held back, with the reason, while the account they would be tried against is not named', () => {
    const specs = probeSpecs({ ...data, facts: { ...facts, tempo: { ...facts.tempo, account: null }, solana: { ...facts.solana, owner: null } }, keys: data.keys.map((key) => (key.kind === 'tempo_access' ? { ...key, scope: { status: 'unavailable' as const, source: 'tempo', readAt: NOW, reason: 'the organisation has no Tempo account yet' } } : key)) });
    expect(specs.map((spec) => spec.blocked?.fix ?? null)).toEqual([null, 'payouts', 'payouts', 'payouts']);
    expect(specs[1]?.to).toEqual({ what: 'The first recipient the key lists, or the team’s own Tempo account when it lists none', address: null });
  });
});

describe('names and pictures', () => {
  it('link to the HyperEVM explorer on chain 999 and nowhere else', () => {
    expect(hyperEvmUrl(999, 'tx', '0xfeaf')).toBe('https://hyperevmscan.io/tx/0xfeaf');
    expect(hyperEvmUrl(999, 'address', '0xa6aF')).toBe('https://hyperevmscan.io/address/0xa6aF');
    expect(hyperEvmUrl(998, 'tx', '0xfeaf')).toBeNull();
    expect(sourceName('hyperevm')).toBe('HyperEVM');
    expect(sourceName('somewhere else')).toBe('somewhere else');
  });

  it('draw the attester’s seal as paper on ink at any plate size', () => {
    for (const [w, h] of [[48, 28], [74, 34], [8, 8]] as const) {
      const bits = drawSealPlate(w, h).bits();
      expect(bits).toHaveLength(w * h);
      const paper = bits.reduce((sum, bit) => sum + bit, 0);
      expect(paper).toBeGreaterThan(0);
      expect(paper).toBeLessThan(w * h);
    }
  });
});
