import { describe, expect, it } from 'vitest';
import type { FoundRun } from '../src/search';
import {
  answerTaken,
  previewTaken,
  standingOfPaid,
  standingOfPending,
  standingUnread,
  type PaidRun,
} from '../src/standing';
import { addressOf } from './fake-node';

const RUN_ID = 'HF-2026-10-0001';
const asked = {
  runId: RUN_ID,
  payees: [
    { tokenAccount: addressOf(1), amount: 1_000_000n, memo: 'INV-1041' },
    { tokenAccount: addressOf(2), amount: 2_500_000n, memo: '' },
  ],
};
const otherLines = { runId: RUN_ID, payees: [{ tokenAccount: addressOf(1), amount: 1_000_001n, memo: 'INV-1041' }] };
const paid: PaidRun = {
  tx: 'paying-transaction',
  transfers: [
    { tokenAccount: addressOf(1), amount: 1_000_000n, memo: 'INV-1041' },
    { tokenAccount: addressOf(2), amount: 2_500_000n, memo: null },
  ],
  cost: null,
};
const found: FoundRun = {
  settled: false,
  run: {
    runId: RUN_ID,
    signature: 'pending-transaction',
    slot: 50n,
    time: null,
    total: 3_500_000n,
    transfers: paid.transfers.map((transfer, index) => ({ ...transfer, to: addressOf(10 + index) })),
  },
};
const SPENT =
  `run ${RUN_ID} is spent: its marker is set on chain, ` +
  'but the payment could not be read to compare it with these lines';

describe('a payment that was read and has settled', () => {
  it('is answered as paid when it paid the lines asked for', () => {
    expect(answerTaken(standingOfPaid(asked, paid))).toEqual({
      ok: true,
      outcome: 'paid',
      tx: 'paying-transaction',
      error: null,
      replayed: true,
      lineMemos: true,
      cost: null,
      historyError: null,
    });
  });

  it('is a refusal when it paid other lines', () => {
    expect(answerTaken(standingOfPaid(otherLines, paid))).toMatchObject({
      ok: false,
      outcome: 'refused',
      tx: null,
      error: `run ${RUN_ID} was already paid by paying-transaction with different lines; nothing was sent`,
    });
  });

  it('names the payout that was sent and turned away, where there was one', () => {
    expect(answerTaken(standingOfPaid(otherLines, paid), 'outrun-transaction').error).toBe(
      `run ${RUN_ID} was already paid by paying-transaction with different lines; ` +
        'transaction outrun-transaction was sent for these, failed, and moved nothing',
    );
  });
});

describe('a payment that was read and has not settled', () => {
  it('is unknown, with its transaction, when it pays the lines asked for', () => {
    expect(answerTaken(standingOfPending(asked, found, 'finalized'))).toMatchObject({
      ok: false,
      outcome: 'unknown',
      tx: 'pending-transaction',
      error: `run ${RUN_ID} is on chain as pending-transaction but has not reached finalized yet`,
      replayed: true,
    });
  });

  it('is a refusal when it pays other lines', () => {
    expect(answerTaken(standingOfPending(otherLines, found, 'finalized'))).toMatchObject({
      outcome: 'refused',
      error: `run ${RUN_ID} is already on chain as pending-transaction with different lines; nothing was sent`,
    });
  });
});

describe('a run id whose marker is set and whose payment could not be read', () => {
  const unread = standingUnread(asked, 'connect ECONNREFUSED');

  it('is unknown, never paid: the marker does not say what was paid', () => {
    expect(answerTaken(unread)).toEqual({
      ok: false,
      outcome: 'unknown',
      tx: null,
      error: `${SPENT}; nothing was sent`,
      replayed: true,
      lineMemos: false,
      cost: null,
      historyError: 'connect ECONNREFUSED',
    });
  });

  it('is unknown for a payout that was sent and turned away as well', () => {
    expect(answerTaken(unread, 'outrun-transaction')).toMatchObject({
      outcome: 'unknown',
      tx: null,
      error: `${SPENT}; transaction outrun-transaction was sent for these, failed, and moved nothing`,
    });
  });
});

describe('previewTaken', () => {
  it('calls the lines paid only when a payment was read and matches', () => {
    expect(previewTaken(standingOfPaid(asked, paid))).toMatchObject({
      ok: true,
      error: null,
      alreadyPaid: true,
      spent: true,
      paidBy: 'paying-transaction',
    });
  });

  it('tells a run id that paid other lines from one whose payment could not be compared', () => {
    expect(previewTaken(standingOfPaid(otherLines, paid))).toMatchObject({
      ok: false,
      alreadyPaid: false,
      spent: true,
      paidBy: 'paying-transaction',
      historyError: null,
    });
    expect(previewTaken(standingUnread(asked, 'connect ECONNREFUSED'))).toMatchObject({
      ok: false,
      error: SPENT,
      alreadyPaid: false,
      spent: true,
      paidBy: null,
      historyError: 'connect ECONNREFUSED',
    });
  });

  it('does not call a payment that has not settled paid either', () => {
    expect(previewTaken(standingOfPending(asked, found, 'finalized'))).toMatchObject({
      ok: false,
      alreadyPaid: false,
      spent: true,
      paidBy: 'pending-transaction',
    });
  });
});
