import type { OrgRecord } from '@holdfast/db';
import {
  type AccessKeyAuthorizationRequest,
  type AccessKeyPolicyInput,
  type KeyStatus,
  type RevocationPreparation,
  type RevocationRequest,
  buildAccessKeyAuthorization,
  serializeSignedAuthorization,
} from '@holdfast/tempo';
import type { Address, Hex } from 'viem';
import type { Deps, SolanaUnsigned } from '../deps';
import { invalid, refused, unavailable } from '../errors';
import { type Reading, reading } from '../reading';
import { messageOf } from '../redact';
import { type TempoAccess, solanaAccess, tempoAccess } from './access';

type RailDeps = Pick<Deps, 'store' | 'tempo' | 'solana' | 'now' | 'redact'>;

export interface TempoRailView {
  network: string;
  chainId: number;
  token: { address: string; symbol: string; decimals: number };
  /** The organisation's Tempo account; null until its profile names one. */
  account: string | null;
  /** The key id the root of that account authorizes. */
  accessKey: string | null;
  /** What the Account Keychain says about the key on that account, read now. */
  key: Reading<KeyStatus>;
}

export async function tempoRail(deps: RailDeps, org: OrgRecord): Promise<TempoRailView> {
  const stored = await deps.store.activeKey(org.id, 'tempo_access');
  const key = await reading('tempo', deps, async () => {
    const { rail, account } = await tempoAccess(deps, org);
    return rail.keyStatus(account);
  });
  return {
    network: deps.tempo.network,
    chainId: deps.tempo.chainId,
    token: { address: deps.tempo.token, symbol: deps.tempo.tokenSymbol, decimals: deps.tempo.decimals },
    account: org.tempoAccount,
    accessKey: stored?.address ?? null,
    key,
  };
}

/** The bounds the treasurer puts on the access key. Everything else about the key is fixed by the service. */
export interface TempoTerms {
  /** Spending limit in token base units: per period, or once when `periodSeconds` is 0. */
  limit: bigint;
  periodSeconds: number;
  /** Unix seconds after which the key stops working. */
  expiry: number;
  /** Payees the key may pay; leave out to allow any recipient. */
  recipients?: string[] | undefined;
}

function expectedPolicy(deps: Pick<Deps, 'tempo'>, access: TempoAccess, terms: TempoTerms): AccessKeyPolicyInput {
  return {
    rootAddress: access.account as Address,
    accessKeyAddress: access.accessKey as Address,
    token: deps.tempo.token,
    limit: terms.limit,
    periodSeconds: terms.periodSeconds,
    expiry: terms.expiry,
    chainId: deps.tempo.chainId,
    ...(terms.recipients === undefined || terms.recipients.length === 0 ? {} : { recipients: terms.recipients as Address[] }),
  };
}

function build(expected: AccessKeyPolicyInput): AccessKeyAuthorizationRequest {
  try {
    return buildAccessKeyAuthorization(expected);
  } catch (error) {
    throw invalid(messageOf(error));
  }
}

/**
 * What the root of the organisation's Tempo account signs to authorize the
 * service's access key: one token, a spending limit, an expiry, and
 * `transferWithMemo` on that token as the only call.
 */
export async function tempoAuthorizationRequest(deps: RailDeps, org: OrgRecord, terms: TempoTerms) {
  const expected = expectedPolicy(deps, await tempoAccess(deps, org), terms);
  const request = build(expected);
  return { expected, signPayload: request.signPayload, key: request.key, policy: request.policy, authorization: request.authorization };
}

export interface TempoSubmission {
  terms: TempoTerms;
  /** The root's signature over the sign payload; or */
  signature?: string | undefined;
  /** the authorization already signed and serialized by the wallet. */
  signedWire?: string | undefined;
}

/**
 * Submit a root-signed authorization. The rail sends it only if it grants
 * exactly the terms given here, to this organisation's key, on this
 * organisation's account, signed by that account's root. An authorization the
 * key already holds on those terms is answered without sending anything.
 */
export async function submitTempoAuthorization(deps: RailDeps, org: OrgRecord, submission: TempoSubmission): Promise<{ authorized: true; tx: string | null; txUrl: string | null; sent: boolean }> {
  const access = await tempoAccess(deps, org);
  const expected = expectedPolicy(deps, access, submission.terms);
  const request = build(expected);

  let signedWire: Hex;
  if (submission.signedWire !== undefined) {
    signedWire = submission.signedWire as Hex;
  } else if (submission.signature !== undefined) {
    try {
      signedWire = serializeSignedAuthorization(request.authorization, submission.signature as Hex);
    } catch (error) {
      throw invalid(`the signature could not be attached to the authorization: ${messageOf(error)}`);
    }
  } else {
    throw invalid('give either the signature or the signed authorization');
  }

  const result = await access.rail.submitAuthorization({ account: access.account, signedWire, expected });
  if (!result.ok) {
    throw refused(deps.redact(result.error ?? 'the authorization was not accepted'), result.tx === null ? {} : { tx: result.tx, txUrl: deps.tempo.txUrl(result.tx) });
  }
  return { authorized: true, tx: result.tx, txUrl: result.tx === null ? null : deps.tempo.txUrl(result.tx), sent: result.tx !== null };
}

const TEMPO = 'Tempo';

/**
 * What the root of the organisation's Tempo account signs to take the
 * service's access key back: one call, `revokeKey` of that key on the Account
 * Keychain, with the nonce, the fee and the deadline as the chain has them
 * now. The service's sponsor pays the fee, with a signature of its own after
 * the root's, so the account needs to hold nothing for it. Changes nothing,
 * and refuses when there is nothing to revoke.
 */
export async function tempoRevokeRequest(deps: RailDeps, org: OrgRecord): Promise<RevocationRequest> {
  const access = await tempoAccess(deps, org);
  let preparation: RevocationPreparation;
  try {
    preparation = await access.rail.prepareRevocation(access.account);
  } catch (error) {
    throw unavailable(TEMPO, deps.redact(messageOf(error)));
  }
  if (!preparation.ok) throw refused(deps.redact(preparation.problems.join('; ')));
  return preparation.request;
}

/**
 * Send a revocation the root signed. The rail gives it the sponsor's
 * signature and sends it only if it is the revocation of this organisation's
 * key, by the root of this organisation's account, on the terms the rail
 * prepares; a transaction that is anything else is refused and goes nowhere.
 * The answer comes once the receipt shows the keychain revoking the key.
 */
export async function submitTempoRevoke(deps: RailDeps, org: OrgRecord, submission: { signedTransaction: string }): Promise<{ tx: string; txUrl: string }> {
  const access = await tempoAccess(deps, org);
  const result = await access.rail.submitRevocation({ account: access.account, signedTransaction: submission.signedTransaction as Hex });
  if (!result.ok || result.tx === null) {
    throw refused(deps.redact(result.error ?? 'the revocation was not accepted'), result.tx === null ? {} : { tx: result.tx, txUrl: deps.tempo.txUrl(result.tx) });
  }
  return { tx: result.tx, txUrl: deps.tempo.txUrl(result.tx) };
}

/** How many Tempo access keys the service makes for one organisation over its life, the first included. */
export const MAX_TEMPO_KEYS_PER_ORGANISATION = 4;

/**
 * Give the organisation a new Tempo access key in the place of one that is
 * dead. A key the root revoked can never be authorized again and an expired
 * one signs nothing, so without a new key the organisation could not pay on
 * Tempo again. The old key is retired on the chain's own word that it is
 * revoked or expired, and on nothing less: a key that can still sign, or that
 * was never authorized, is left in place, and so is every key while the chain
 * cannot be read. The retired key stays on record with its address. The new
 * one is made the way an organisation's first is and can do nothing until the
 * root authorizes it. Answers with the rail as it stands afterwards.
 */
export async function replaceTempoAccessKey(deps: RailDeps, org: OrgRecord): Promise<TempoRailView> {
  const access = await tempoAccess(deps, org);
  let key: KeyStatus;
  try {
    key = await access.rail.keyStatus(access.account);
  } catch (error) {
    throw unavailable(TEMPO, deps.redact(messageOf(error)));
  }
  // Known to the keychain, not revoked and yet not live: its expiry, a real time, has passed.
  const expired = !key.revoked && !key.live && key.expiresAt !== null && key.expiresAt > 0;
  if (!key.revoked && !expired) {
    const { accessKey } = access;
    if (key.authorized) throw refused(`access key ${accessKey} is authorized on this account and can still pay; revoke it before a new key takes its place`);
    if (key.live) throw refused(`access key ${accessKey} is live on this account and can still sign; revoke it before a new key takes its place`);
    // An expiry of zero is not a time that passed. The keychain is not known to report one for a key it holds, and such a key is not taken for dead.
    if (key.expiresAt !== null) throw refused(`the chain holds access key ${accessKey} on this account with an expiry it does not state; revoke it before a new key takes its place`);
    throw refused(`access key ${accessKey} was never authorized on this account; nothing is wrong with it, and it is not replaced`);
  }

  // Every key made here can cost the fee sponsor an authorization and a revocation, so an organisation gets a bounded number of them.
  const made = (await deps.store.listKeys(org.id)).filter((key) => key.kind === 'tempo_access').length;
  if (made >= MAX_TEMPO_KEYS_PER_ORGANISATION) throw refused(`this organisation has already had ${made} access keys, which is as many as the service makes for one organisation`);

  const next = deps.tempo.newAccessKey();
  // Nothing is written when another request has put a key in the dead one's place already: either way one new key stands there.
  await deps.store.replaceKey(org.id, access.accessKey, { kind: 'tempo_access', address: next.address, secret: next.privateKey });
  return tempoRail(deps, org);
}

export interface SolanaRailView {
  cluster: string;
  token: { address: string; symbol: string; decimals: number };
  /** The organisation's wallet; null until its profile names one. */
  owner: string | null;
  /** The service key the wallet approves as delegate. */
  delegate: string | null;
  /** What the delegate may still move from the wallet's token account, read now. */
  allowance: Reading<{ remaining: bigint }>;
}

export async function solanaRail(deps: RailDeps, org: OrgRecord): Promise<SolanaRailView> {
  const stored = await deps.store.activeKey(org.id, 'solana_delegate');
  const allowance = await reading('solana', deps, async () => {
    const { rail, owner } = await solanaAccess(deps, org);
    return { remaining: (await rail.remaining(owner)).remaining };
  });
  return {
    cluster: deps.solana.cluster,
    token: { address: deps.solana.mint, symbol: deps.solana.tokenSymbol, decimals: deps.solana.decimals },
    owner: org.solanaOwner,
    delegate: stored?.address ?? null,
    allowance,
  };
}

async function unsigned<T>(deps: Pick<Deps, 'redact'>, make: () => Promise<SolanaUnsigned<T>>): Promise<SolanaUnsigned<T>> {
  try {
    return await make();
  } catch (error) {
    throw unavailable('Solana', deps.redact(messageOf(error)));
  }
}

/**
 * The transaction with which the organisation's wallet approves the service
 * key as delegate for `amount`. An approval replaces the one before it: the
 * allowance becomes `amount`, it is not added to what is left.
 */
export async function solanaApproval(deps: RailDeps, org: OrgRecord, amount: bigint) {
  const { owner, delegate } = await solanaAccess(deps, org);
  return unsigned(deps, () => deps.solana.buildApproval({ owner, delegate, amount }));
}

/** The transaction with which the wallet takes the delegation back. */
export async function solanaRevoke(deps: RailDeps, org: OrgRecord) {
  const { owner } = await solanaAccess(deps, org);
  return unsigned(deps, () => deps.solana.buildRevoke({ owner }));
}
