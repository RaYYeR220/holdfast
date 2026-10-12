import { TRANSFER_WITH_MEMO_SELECTOR, type KeyStatus } from '@holdfast/tempo';
import type { AttestationSummary } from '@/server/attestations/service';
import type { SafetyFacts } from '@/server/pages/safety';
import type { Reading } from '@/server/reading';
import type { KeyKindShown, KeyScope } from '@/server/safety/scopes';
import type { State } from '@/ui';
import { formatUnits } from '../books/amounts';

/**
 * What the Safety page shows, worked out from what the server read: one
 * card for each key the service holds and one for each refusal on record.
 * Nothing here reads anything; the same functions serve the public demo and
 * the owner's page.
 */

/** One refusal as the server has it on record. */
export interface RefusalRecord {
  id: string;
  chain: string;
  kind: string;
  attempted: string;
  outcome: string;
  tx: string | null;
  txUrl: string | null;
  at: number;
}

export interface SafetyData {
  keys: KeyScope[];
  refusals: RefusalRecord[];
  /** The latest snapshot of the hedge on HyperEVM; a null value when the current series holds none. */
  attestation: Reading<AttestationSummary | null>;
  facts: SafetyFacts;
}

export type KeyId = 'viewing' | 'agent' | 'access' | 'delegate' | 'attester';

const KEY_OF_KIND: Record<KeyKindShown, KeyId> = {
  zcash_viewing_key: 'viewing',
  hl_agent: 'agent',
  tempo_access: 'access',
  solana_delegate: 'delegate',
  hl_attester: 'attester',
};

/** The key a refusal on a chain belongs to: each chain has one key that can sign there. */
const KEY_OF_CHAIN: Record<string, KeyId> = { hyperliquid: 'agent', tempo: 'access', solana: 'delegate' };

interface KeyCopy {
  name: string;
  chain: string;
  /** What the key is for, completing "It …". */
  job: string;
  can: string;
  cannot: string;
}

/** What each key can and cannot do, as the product's own documentation states it. */
const COPY: Record<KeyId, KeyCopy> = {
  viewing: {
    name: 'Viewing key',
    chain: 'Zcash',
    job: 'reads the shielded treasury',
    can: 'Read payments in, their memos, the balance, and what the treasury itself sent.',
    cannot: 'Spend, or sign anything.',
  },
  agent: {
    name: 'Agent key',
    chain: 'Hyperliquid',
    job: 'trades the short on the team’s own account',
    can: 'Place and cancel orders on the team’s account, and switch its account mode.',
    cannot: 'Withdraw or transfer the team’s funds.',
  },
  access: {
    name: 'Access key',
    chain: 'Tempo',
    job: 'pays contractors up to a limit per period',
    can: 'Call transferWithMemo on one stablecoin, to the recipients it lists when it lists any, up to the limit of the current period.',
    cannot: 'Spend more, call any other function or token, or pay after expiry or revocation.',
  },
  delegate: {
    name: 'Token delegate',
    chain: 'Solana',
    job: 'pays contractors up to a fixed allowance',
    can: 'Transfer up to the allowance out of the team’s one token account.',
    cannot: 'Exceed the allowance, or move anything after the team revokes it.',
  },
  attester: {
    name: 'Attester key',
    chain: 'HyperEVM',
    job: 'records snapshots of the hedge and moves no money',
    can: 'Record a snapshot for the team’s account on HedgeAttestor, once that account has named it.',
    cannot: 'Move anything: it holds no funds of the organisation. It cannot supply the position or the prices of a snapshot, which the contract reads from HyperCore itself, and cannot change or remove a snapshot.',
  },
};

export type ScopeLine =
  | { label: string; text: string }
  /** An amount, set as a figure. */
  | { label: string; figure: string }
  /** A moment, shown absolute and relative. */
  | { label: string; time: number }
  /** Addresses, each shown shortened with its full value to copy. */
  | { label: string; addresses: string[] };

export type ScopeView =
  | { status: 'unavailable'; source: string; reason: string; at: number }
  | {
      status: 'ok';
      /** Where the scope was read: a chain, or the key's own format. */
      source: string;
      at: number;
      state: State;
      /** The bound in a few words, for the state tag. */
      headline: string;
      lines: ScopeLine[];
      /** How a live key is broader than the service accepts; the service does not use such a key. */
      warnings: string[];
    };

export interface KeyCard extends KeyCopy {
  id: KeyId;
  /** The label and value of the address shown for the key: its own public half, or for the viewing key the address it receives on. */
  address: { label: string; value: string | null; note: string | null };
  /** The account of the team the key acts on. */
  actsOn: { label: string; value: string | null; missing: string };
  /** Who holds the key to its bound, in the server's words. */
  enforcedBy: string;
  scope: ScopeView;
  /** How many refusals on record are this key's. */
  refusals: number;
}

const capital = (text: string): string => (text === '' ? text : `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}`);
const sentence = (text: string): string => (/[.!?]$/.test(text) ? capital(text) : `${capital(text)}.`);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What a Tempo key may call, in words. */
function tempoCalls(scope: KeyStatus['scope'], symbol: string): string {
  if (scope.unrestricted) return 'Any call: the key has no call scope.';
  const elsewhere = scope.otherTargets.length > 0 ? ` It may also call ${scope.otherTargets.length === 1 ? 'another contract' : `${scope.otherTargets.length} other contracts`}.` : '';
  if (scope.selectors === null) return `Every function of ${symbol}.${elsewhere}`;
  if (scope.selectors.length === 0) return `No function of ${symbol}.${elsewhere}`;
  const others = scope.selectors.filter((selector) => selector.toLowerCase() !== TRANSFER_WITH_MEMO_SELECTOR);
  const memo = scope.selectors.length > others.length;
  if (memo && others.length === 0) return `transferWithMemo on ${symbol}, and no other function.${elsewhere}`;
  return `${memo ? 'transferWithMemo and ' : ''}${others.join(', ')} on ${symbol}.${elsewhere}`;
}

/** The Tempo access key as the Account Keychain reports it, in the terms of the page. */
export function tempoScope(key: KeyStatus, token: { symbol: string; decimals: number }, source: string, at: number): ScopeView {
  const lines: ScopeLine[] = [];
  let state: State;
  let headline: string;

  if (key.authorized) {
    const left = `${formatUnits(key.remaining, token.decimals, 2)} ${token.symbol}`;
    state = 'limit';
    headline = `${left} left`;
    lines.push({ label: key.periodEnd === null ? 'Left of its limit' : 'Left in this period', figure: left });
    if (key.periodEnd !== null) lines.push({ label: 'Period ends', time: key.periodEnd });
  } else if (key.revoked) {
    state = 'refused';
    headline = 'Revoked';
    lines.push({ label: 'Standing', text: 'Revoked by the account. The chain accepts nothing this key signs.' });
  } else if (key.live) {
    state = 'refused';
    headline = 'Not used: too broad';
    lines.push({ label: 'Standing', text: 'Live on the account, with wider bounds than the service accepts. The service pays with no such key.' });
  } else if (key.expiresAt !== null && key.expiresAt <= at) {
    state = 'unlocked';
    headline = 'Expired';
    lines.push({ label: 'Standing', text: 'Expired. The chain accepts nothing this key signs.' });
  } else {
    state = 'unlocked';
    headline = 'Not authorized';
    lines.push({ label: 'Standing', text: 'The account has not authorized this key. Until it does, the chain accepts nothing the key signs.' });
  }

  if (key.live || key.expiresAt !== null) {
    lines.push(key.expiresAt === null ? { label: 'Expires', text: 'No expiry is set.' } : { label: key.expiresAt <= at ? 'Expired' : 'Expires', time: key.expiresAt });
  }
  if (key.live) {
    lines.push({ label: 'May call', text: tempoCalls(key.scope, token.symbol) });
    const { recipients } = key.scope;
    if (recipients === null) lines.push({ label: 'May pay', text: 'Any recipient.' });
    else if (recipients.length === 0) lines.push({ label: 'May pay', text: 'Nobody: the scope lists no recipient.' });
    else lines.push({ label: 'May pay', addresses: [...recipients] });
  }
  return { status: 'ok', source, at, state, headline, lines, warnings: key.live ? key.mismatch.map(sentence) : [] };
}

/** The Solana delegate's allowance as the token account reports it. */
export function solanaScope(value: { owner: string; remaining: bigint }, token: { symbol: string; decimals: number }, source: string, at: number): ScopeView {
  if (value.remaining <= 0n) {
    return {
      status: 'ok',
      source,
      at,
      state: 'unlocked',
      headline: 'No allowance',
      lines: [{ label: 'Allowance left', text: `None, in ${token.symbol}. The delegate can move nothing: it was never approved, was revoked, or has spent what it was given.` }],
      warnings: [],
    };
  }
  const left = `${formatUnits(value.remaining, token.decimals, 2)} ${token.symbol}`;
  return { status: 'ok', source, at, state: 'limit', headline: `${left} left`, lines: [{ label: 'Allowance left', figure: left }], warnings: [] };
}

function scopeOf(key: KeyScope, facts: SafetyFacts): ScopeView {
  const { scope } = key;
  if (scope.status !== 'ok') return { status: 'unavailable', source: scope.source, reason: scope.reason, at: scope.readAt };
  const { value, source, readAt: at } = scope;
  const unread = (what: string): ScopeView => ({ status: 'unavailable', source, reason: `the answer about ${what} was not in a form this page can show`, at });

  switch (key.kind) {
    case 'zcash_viewing_key':
      if (!isRecord(value) || value.canSpend !== false) return unread('the viewing key');
      return {
        status: 'ok',
        source,
        at,
        state: 'locked',
        headline: 'Cannot spend',
        lines: [{ label: 'Authority', text: 'To view only. This is what a viewing key is: it was checked when the organisation was registered, and anything else pasted in its place is refused by its shape.' }],
        warnings: [],
      };
    case 'tempo_access':
      if (!isRecord(value) || typeof value.authorized !== 'boolean' || !isRecord(value.scope)) return unread('the access key');
      return tempoScope(value as unknown as KeyStatus, facts.tempo.token, source, at);
    case 'solana_delegate':
      if (!isRecord(value) || typeof value.owner !== 'string' || typeof value.remaining !== 'bigint') return unread('the delegate');
      return solanaScope({ owner: value.owner, remaining: value.remaining }, facts.solana.token, source, at);
    case 'hl_attester':
      if (!isRecord(value) || typeof value.registered !== 'boolean') return unread('the attester');
      return value.registered
        ? { status: 'ok', source, at, state: 'locked', headline: 'Named by the account', lines: [{ label: 'On HedgeAttestor', text: 'The team’s account has named this key as its attester. It can record snapshots for that account and for no other.' }], warnings: [] }
        : { status: 'ok', source, at, state: 'unlocked', headline: 'Not named', lines: [{ label: 'On HedgeAttestor', text: 'The team’s account has not named this key. Until it does, the contract accepts no snapshot from it.' }], warnings: [] };
    case 'hl_agent':
      if (!isRecord(value) || typeof value.approved !== 'boolean') return unread('the agent key');
      if (!value.approved) {
        return { status: 'ok', source, at, state: 'unlocked', headline: 'Not approved', lines: [{ label: 'On the account', text: 'The account has not approved this key. Until it does, the venue accepts no order the key signs.' }], warnings: [] };
      }
      return {
        status: 'ok',
        source,
        at,
        state: 'limit',
        headline: 'Approved to trade',
        lines: [
          { label: 'On the account', text: 'The venue lists this key among the agents of the account. It signs orders for that account; a withdrawal or transfer it signs is applied to its own empty address.' },
          typeof value.validUntil === 'number' ? { label: 'Approval lapses', time: value.validUntil } : { label: 'Approval lapses', text: 'The venue names no expiry.' },
        ],
        warnings: [],
      };
  }
}

/** One card for each key the service holds, in the order the server lists them. */
export function keyCards(data: SafetyData): KeyCard[] {
  const { facts } = data;
  const treasury = facts.treasury.status === 'ok' ? facts.treasury.value.address : null;
  return data.keys.map((key): KeyCard => {
    const id = KEY_OF_KIND[key.kind];
    const actsOn: Record<KeyId, KeyCard['actsOn']> = {
      viewing: { label: 'Reads', value: treasury, missing: facts.treasury.status === 'ok' ? '' : facts.treasury.reason },
      agent: { label: 'Trades on', value: facts.hyperliquidAccount, missing: '' },
      access: { label: 'Pays from', value: facts.tempo.account, missing: 'The organisation has not named a Tempo account yet.' },
      delegate: { label: 'Pays from', value: facts.solana.owner, missing: 'The organisation has not named a Solana wallet yet.' },
      attester: { label: 'Records for', value: facts.hyperliquidAccount, missing: '' },
    };
    const address: KeyCard['address'] =
      id === 'viewing'
        ? { label: 'Key', value: null, note: 'Never shown. It is stored encrypted and appears on these pages only as the treasury address it receives on.' }
        : { label: 'Address', value: key.address, note: key.address === null ? 'The organisation has no such key.' : null };
    return {
      id,
      ...COPY[id],
      address,
      actsOn: actsOn[id],
      enforcedBy: sentence(key.enforcedBy),
      scope: scopeOf(key, facts),
      refusals: data.refusals.filter((refusal) => KEY_OF_CHAIN[refusal.chain] === id).length,
    };
  });
}

const CHAIN_NAME: Record<string, string> = { hyperliquid: 'Hyperliquid', tempo: 'Tempo', solana: 'Solana', zcash: 'Zcash' };

const KIND_TITLE: Record<string, string> = {
  'hyperliquid:withdraw3': 'A withdrawal signed by the agent key',
  'hyperliquid:usdSend': 'A transfer of dollars signed by the agent key',
  'tempo:over_limit': 'A payment over the limit',
  'tempo:out_of_scope': 'A call outside the key’s scope',
  'solana:over_allowance': 'A transfer over the allowance',
  'solana:revoked_delegate': 'A transfer after the delegate was revoked',
};

export interface ErrorReading {
  /** The error in a few words: `Custom program error 0x4`. */
  answer: string;
  /** Where in the transaction it was raised. */
  where: string;
}

/**
 * A Solana transaction error read out. The node reports
 * `{"InstructionError":[1,{"Custom":4}]}`: the instruction that failed,
 * counted from zero, and the program's own error number. Null when the text
 * is not such an error.
 */
export function readSolanaError(outcome: string): ErrorReading | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.InstructionError)) return null;
  const [index, error] = parsed.InstructionError as unknown[];
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return null;
  const where = `Raised by instruction ${index + 1} of the transaction.`;
  if (isRecord(error) && typeof error.Custom === 'number' && Number.isInteger(error.Custom) && error.Custom >= 0) {
    return { answer: `Custom program error 0x${error.Custom.toString(16)}`, where };
  }
  return typeof error === 'string' && error !== '' ? { answer: error, where } : null;
}

export interface RefusalCard {
  id: string;
  /** The key that was refused; null for a chain none of the keys signs on. */
  key: KeyId | null;
  chainName: string;
  title: string;
  attempted: string;
  /** The chain's or the venue's own answer, as it was received. */
  outcome: string;
  /** The same answer read out, where the chain returned it as a structure. */
  reading: ErrorReading | null;
  /** How the refusal came to be on record: a transaction the chain included and failed, or an answer of the venue. */
  how: string;
  at: number;
  tx: { chain: 'tempo' | 'solana'; id: string; url: string } | null;
}

const HEX_ADDRESS = /0x[0-9a-fA-F]{40}/g;

function howOf(record: RefusalRecord, agent: string | null): string {
  if (record.chain === 'tempo') return 'Tempo included the transaction and reverted it. The link opens it on the explorer.';
  if (record.chain === 'solana') return 'Solana included the transaction and failed it. The link opens it on the explorer.';
  if (record.chain === 'hyperliquid') {
    const named = record.outcome.match(HEX_ADDRESS) ?? [];
    const own = agent !== null && named.some((address) => address.toLowerCase() === agent.toLowerCase());
    return `This is the exchange’s answer to a request the agent key signed, not a transaction: there is nothing to link.${own ? ' The address in the answer is the agent’s own, which is empty. A withdrawal or transfer acts on the account of whoever signed it.' : ''}`;
  }
  return record.tx === null ? 'There is no transaction on record for this refusal.' : 'The transaction is on record.';
}

/** One card for each refusal on record, newest first as the server lists them. */
export function refusalCards(data: SafetyData): RefusalCard[] {
  const agent = data.keys.find((key) => key.kind === 'hl_agent')?.address ?? null;
  return data.refusals.map((record): RefusalCard => {
    const onChain = record.chain === 'tempo' || record.chain === 'solana';
    return {
      id: record.id,
      key: KEY_OF_CHAIN[record.chain] ?? null,
      chainName: CHAIN_NAME[record.chain] ?? record.chain,
      title: KIND_TITLE[`${record.chain}:${record.kind}`] ?? capital(record.kind.replaceAll('_', ' ')),
      // As the server worded it, which may start with the name of a function: closed with a full stop and otherwise left alone.
      attempted: /[.!?]$/.test(record.attempted) ? record.attempted : `${record.attempted}.`,
      outcome: record.outcome,
      reading: record.chain === 'solana' ? readSolanaError(record.outcome) : null,
      how: howOf(record, agent),
      at: record.at,
      tx: onChain && record.tx !== null && record.txUrl !== null ? { chain: record.chain as 'tempo' | 'solana', id: record.tx, url: record.txUrl } : null,
    };
  });
}

/** What the page says about a key with nothing on record, where a reader would look for its refusals. */
export const NO_ATTEMPT: Partial<Record<KeyId, string>> = {
  viewing: 'Nothing to attempt: a viewing key has nothing to sign with.',
  attester: 'It signs snapshots and nothing that moves money, so there is no limit on funds to test.',
};
