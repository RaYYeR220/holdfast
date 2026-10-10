import { type OutgoingPayment, type OwnedNote, ZERO_ROOT, type Zat } from '@holdfast/core';
import type { JournalEntry, OrgState, ScanCommit, Store } from './types';

interface OrgData {
  state: OrgState;
  notes: Map<string, OwnedNote & { spent: boolean }>;
  outgoing: Map<string, OutgoingPayment>;
  fees: Map<string, { txid: string; height: number; zat: Zat }>;
  journal: JournalEntry[];
  busy: boolean;
}

/**
 * The whole store in memory. It backs the test-suite and single-process
 * self-hosting, and it is the reference for what the database one must do.
 */
export class MemoryStore implements Store {
  private readonly orgs = new Map<string, OrgData>();

  addOrg(init: Omit<OrgState, 'scannedTo' | 'tip' | 'nextSeq' | 'lastDigest'>): void {
    if (this.orgs.has(init.id)) throw new Error(`organisation ${init.id} already exists`);
    this.orgs.set(init.id, {
      state: { ...init, scannedTo: null, tip: null, nextSeq: 1, lastDigest: ZERO_ROOT },
      notes: new Map(),
      outgoing: new Map(),
      fees: new Map(),
      journal: [],
      busy: false,
    });
  }

  private org(orgId: string): OrgData {
    const data = this.orgs.get(orgId);
    if (data === undefined) throw new Error(`unknown organisation ${orgId}`);
    return data;
  }

  update(orgId: string, patch: Partial<Pick<OrgState, 'policy' | 'lockEnabled' | 'hlUser'>>): void {
    Object.assign(this.org(orgId).state, patch);
  }

  async withOrgLock<T>(orgId: string, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
    const data = this.org(orgId);
    if (data.busy) return { ran: false };
    data.busy = true;
    try {
      return { ran: true, value: await fn() };
    } finally {
      data.busy = false;
    }
  }

  async loadOrg(orgId: string): Promise<OrgState> {
    return structuredClone(this.org(orgId).state);
  }

  async commitScan(orgId: string, scan: ScanCommit): Promise<void> {
    const data = this.org(orgId);
    const inRange = (height: number) => height >= scan.from && height <= scan.to;

    // Spends found in an earlier scan of a block that is being re-read are
    // found again by this one; everything from the range is replaced.
    for (const [id, note] of data.notes) if (inRange(note.height)) data.notes.delete(id);
    for (const [id, out] of data.outgoing) if (inRange(out.height)) data.outgoing.delete(id);
    for (const [txid, fee] of data.fees) if (inRange(fee.height)) data.fees.delete(txid);

    for (const note of scan.notes) data.notes.set(note.id, { ...note });
    for (const out of scan.outgoing) data.outgoing.set(out.id, { ...out });
    const heightOf = new Map([...scan.notes, ...scan.outgoing].map((x) => [x.txid, x.height]));
    for (const fee of scan.fees) data.fees.set(fee.txid, { ...fee, height: heightOf.get(fee.txid) ?? scan.to });

    const spent = new Set(scan.spentNullifiers);
    for (const note of data.notes.values()) {
      if (note.nullifier !== null && spent.has(note.nullifier)) note.spent = true;
    }
    data.state.scannedTo = scan.to;
    data.state.tip = { ...scan.tip };
  }

  async unspentNullifiers(orgId: string): Promise<string[]> {
    return [...this.org(orgId).notes.values()].flatMap((n) => (!n.spent && n.nullifier !== null ? [n.nullifier] : []));
  }

  async trackedBalance(orgId: string): Promise<Zat> {
    let sum = 0n;
    for (const note of this.org(orgId).notes.values()) {
      if (!note.spent && note.nullifier !== null) sum += note.zat;
    }
    return sum;
  }

  async appendJournal(entry: JournalEntry): Promise<void> {
    const data = this.org(entry.orgId);
    if (entry.seq !== data.state.nextSeq) throw new Error(`journal entry ${entry.seq} is out of sequence, expected ${data.state.nextSeq}`);
    if (entry.prev !== data.state.lastDigest) throw new Error(`journal entry ${entry.seq} does not follow the last entry`);
    data.journal.push(structuredClone(entry));
    data.state.nextSeq += 1;
    data.state.lastDigest = entry.digest;
  }

  // Read access for views and tests.
  journal(orgId: string): JournalEntry[] {
    return this.org(orgId).journal;
  }

  notes(orgId: string): OwnedNote[] {
    return [...this.org(orgId).notes.values()];
  }

  outgoing(orgId: string): OutgoingPayment[] {
    return [...this.org(orgId).outgoing.values()];
  }

  /** Notes received in pools whose spends cannot be followed with a viewing key. */
  untrackedBalance(orgId: string): Zat {
    let sum = 0n;
    for (const note of this.org(orgId).notes.values()) if (note.nullifier === null) sum += note.zat;
    return sum;
  }
}
