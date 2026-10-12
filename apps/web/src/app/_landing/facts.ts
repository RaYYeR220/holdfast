import type { Chain, KeyKind } from '@/ui';

/**
 * What is on record about Holdfast and is not computed by the server: the
 * four keys, the refusals each chain or venue answered with, the payouts made
 * with the paying keys, and what was recorded of the demo treasury on
 * mainnet. Every transaction named here is public; the page links each one.
 */

export const DOCS_URL = 'https://github.com/RaYYeR220/holdfast#readme';
export const REPOSITORY_URL = 'https://github.com/RaYYeR220/holdfast';

/** The demo treasury's own Hyperliquid account. */
export const TEAM_ACCOUNT = '0xC7e7BAAFb0C822d0A934BbB2268F15A7eD8485bc';

export interface KeyFact {
  kind: KeyKind;
  name: string;
  chain: string;
  job: string;
  can: string;
  cannot: string;
  enforcedBy: string;
}

export const KEYS: readonly KeyFact[] = [
  { kind: 'view', name: 'Viewing key', chain: 'Zcash', job: 'to read', can: 'Read the shielded treasury', cannot: 'Spend', enforcedBy: 'Cryptography: a viewing key cannot sign' },
  { kind: 'agent', name: 'Agent key', chain: 'Hyperliquid', job: 'to hedge', can: 'Place and cancel ZEC perpetual orders', cannot: 'Withdraw or transfer', enforcedBy: 'The exchange' },
  { kind: 'access', name: 'Access key', chain: 'Tempo', job: 'to pay', can: 'Pay contractors up to a periodic limit', cannot: 'Exceed the limit or call anything else', enforcedBy: 'The chain' },
  { kind: 'delegate', name: 'Token delegate', chain: 'Solana', job: 'to pay', can: 'Pay contractors up to a fixed allowance', cannot: 'Exceed the allowance; nothing after revoke', enforcedBy: 'The Token program' },
];

export interface Refusal {
  id: string;
  chain: Chain;
  chainName: string;
  /** Every refusal on record was on mainnet. */
  network: 'mainnet';
  who: string;
  kind: KeyKind;
  /** What the key was pointed at, completing "Tried to ...". */
  tried: string;
  /** What came back, as the network returned it. */
  answer: string;
  /** False when the answer is a statement of fact and not a quotation. */
  quoted: boolean;
  why: string;
  /** Where the answer can be checked. A viewing key has nowhere to send a spend, so it has none. */
  proof: { kind: 'tx'; id: string } | { kind: 'account'; address: string } | null;
}

export const REFUSALS: readonly Refusal[] = [
  {
    id: 'hl-withdraw',
    chain: 'hyperliquid',
    chainName: 'Hyperliquid',
    network: 'mainnet',
    who: 'agent key',
    kind: 'agent',
    tried: 'withdraw from the team account',
    answer: 'Must deposit before performing actions',
    quoted: true,
    why: 'A withdrawal signed by the agent applies to the agent’s own empty account, never the team’s. The exchange refused the request, so no transaction exists; the team account is public.',
    proof: { kind: 'account', address: TEAM_ACCOUNT },
  },
  {
    id: 'tempo-limit',
    chain: 'tempo',
    chainName: 'Tempo',
    network: 'mainnet',
    who: 'access key',
    kind: 'access',
    tried: 'pay more than the remaining limit',
    answer: 'SpendingLimitExceeded',
    quoted: true,
    why: 'The transaction was included and reverted by the chain.',
    proof: { kind: 'tx', id: '0x2246d81e18fa8269c799855079e7e9ec3cabec80430b62aedd040ab9acb9bce9' },
  },
  {
    id: 'tempo-scope',
    chain: 'tempo',
    chainName: 'Tempo',
    network: 'mainnet',
    who: 'access key',
    kind: 'access',
    tried: 'call a function outside its scope',
    answer: 'CallNotAllowed',
    quoted: true,
    why: 'The key is scoped to one payment function on one token. The transaction was included and reverted.',
    proof: { kind: 'tx', id: '0x80b065d23f17bc54495e2d92eb9e15980f68d50e39f6e83ae142f2ed7d587d11' },
  },
  {
    id: 'solana-allowance',
    chain: 'solana',
    chainName: 'Solana',
    network: 'mainnet',
    who: 'token delegate',
    kind: 'delegate',
    tried: 'transfer above the delegated allowance',
    answer: 'custom program error: 0x1',
    quoted: true,
    why: 'The transaction failed in the Token program.',
    proof: { kind: 'tx', id: '5UpRY36zNFBVJo6VwRsCUJmnEQbvxs2R1xCZzmSU2RNGBLSUALwWeHPPSH3MKK8ZroXEY3MsuiSaquoZjwQiZq99' },
  },
  {
    id: 'solana-revoked',
    chain: 'solana',
    chainName: 'Solana',
    network: 'mainnet',
    who: 'token delegate',
    kind: 'delegate',
    tried: 'transfer after the owner revoked it',
    answer: 'custom program error: 0x4',
    quoted: true,
    why: 'After a revoke the delegate can move nothing. The transaction failed in the Token program.',
    proof: { kind: 'tx', id: 'FjduxHjy1bqB1Nc4i6QbKkyUgEwEXMVsVmM4z3CFpYiJFfY8gsSaQ3t5azzDrB8czwHamboSwirDqN37xrsrYVg' },
  },
  {
    id: 'zcash-spend',
    chain: 'zcash',
    chainName: 'Zcash',
    network: 'mainnet',
    who: 'viewing key',
    kind: 'view',
    tried: 'spend',
    answer: 'No signature is possible',
    quoted: false,
    why: 'A viewing key has no spending authority. There is nothing to send to a network.',
    proof: null,
  },
];

/** The refusal each of the three keys on the hero's chain opens, top to bottom. */
export const HERO_KEYS: readonly { refusal: string; name: string; sub: string }[] = [
  { refusal: 'zcash-spend', name: 'Viewing key', sub: 'can see, cannot spend' },
  { refusal: 'hl-withdraw', name: 'Agent key', sub: 'can trade, cannot withdraw' },
  { refusal: 'tempo-limit', name: 'Paying keys', sub: 'can pay to a limit, no more' },
];

export interface Payout {
  chain: Chain;
  chainName: string;
  run: string;
  /** The lines of the run, in USDC. */
  lines: readonly string[];
  tx: string;
}

/** Runs paid on mainnet with the two paying keys. */
export const PAYOUTS: readonly Payout[] = [
  { chain: 'tempo', chainName: 'Tempo', run: 'HF-2026-10-0001', lines: ['0.40', '0.35'], tx: '0x379f560f0c9a053e2a1b117fab40ac5d84371c68d188c2583be015eac3fe53e9' },
  { chain: 'solana', chainName: 'Solana', run: 'HF-2026-10-0003', lines: ['0.40', '0.35'], tx: '4kLtT81sjyhGt53HsN3YZXAuX5XYLnsXy4Eu3LiaV9PCXFsNkwDxmpovUY3Ww9KHubDtzdyewnCBo8DerfdauYc8' },
];

/** What happened to one grant payment on mainnet, as recorded on October 10, 2026. */
export const RECORDED = {
  on: 'October 10, 2026',
  received: { zec: '0.01975', memo: 'ZCG grant, milestone 2 of 4' },
  margin: { zec: '0.0093', usdc: '11.02', via: 'NEAR Intents' },
  short: { zec: '0.01', fillPx: 1226.4 },
} as const;

export const PRIVACY = {
  private: 'Inflows, memos, balance.',
  public: 'The hedge on Hyperliquid, stablecoin payouts.',
} as const;

export const NOT_CLAIMED = ['no users', 'no revenue', 'no audit', 'no token'] as const;
