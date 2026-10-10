import type {
  Advisory,
  Decision,
  HedgeVenue,
  Hex,
  OrderResult,
  OutgoingPayment,
  OwnedNote,
  Policy,
  ReferencePrice,
  Snapshot,
  TreasuryScanner,
  Zat,
} from '@holdfast/core';

/** What the engine knows about one organisation when a tick starts. */
export interface OrgState {
  id: string;
  /** Unified full viewing key of the treasury. */
  ufvk: string;
  /** First block that can contain treasury funds. */
  birthday: number;
  /** Last block fully scanned, or null before the first scan. */
  scannedTo: number | null;
  /** The organisation's own Hyperliquid account. */
  hlUser: string;
  policy: Policy;
  /** Whether the treasurer has asked for the runway lock to be on. */
  lockEnabled: boolean;
  /** Sequence number the next journal entry will carry. */
  nextSeq: number;
  /** Digest of the last journal entry; the zero root before the first. */
  lastDigest: Hex;
}

export interface ScanCommit {
  from: number;
  to: number;
  notes: OwnedNote[];
  outgoing: OutgoingPayment[];
  fees: { txid: string; zat: Zat }[];
  spentNullifiers: string[];
}

export interface OrderRecord {
  seq: number;
  cloid: Hex;
  side: 'buy' | 'sell';
  lots: number;
  limitPx: number;
  reduceOnly: boolean;
  result: OrderResult;
}

/** One tick, written down so that anyone can replay why it did what it did. */
export interface JournalEntry {
  orgId: string;
  seq: number;
  at: number;
  /** Digest of the previous entry: entries form a chain. */
  prev: Hex;
  /** Digest of this entry's body together with `prev`. */
  digest: Hex;
  snapshot: Snapshot;
  policyDigest: Hex;
  decision: Decision;
  advisories: Advisory[];
  order: OrderRecord | null;
  /** Sources that could not be read this tick, and why. */
  errors: { source: 'treasury' | 'venue' | 'reference'; message: string }[];
  scan: { from: number; to: number; tip: number; caughtUp: boolean } | null;
}

/**
 * Persistence the engine needs. The database-backed implementation and the
 * in-memory one used in tests satisfy the same contract.
 */
export interface Store {
  /** Run `fn` unless another tick for this organisation is in flight. */
  withOrgLock<T>(orgId: string, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }>;
  loadOrg(orgId: string): Promise<OrgState>;
  /**
   * Record a scanned range atomically: notes in the range replace whatever
   * was stored for those heights, so a reorganised block leaves no ghosts.
   */
  commitScan(orgId: string, scan: ScanCommit): Promise<void>;
  /** Nullifiers of notes not yet known to be spent. */
  unspentNullifiers(orgId: string): Promise<string[]>;
  /** Sum of unspent notes whose spends the viewing key can follow. */
  trackedBalance(orgId: string): Promise<Zat>;
  /** Append the entry and advance the organisation's sequence in one step. */
  appendJournal(entry: JournalEntry): Promise<void>;
}

export interface TickDeps {
  store: Store;
  scanner: TreasuryScanner;
  venue: HedgeVenue;
  reference: ReferencePrice;
  now: () => number;
}

export type TickOutcome = { ran: true; entry: JournalEntry } | { ran: false; reason: 'locked' };
