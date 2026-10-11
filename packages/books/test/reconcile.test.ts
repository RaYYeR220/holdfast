import type { OwnedNote } from '@holdfast/core';
import type { JournalEntry } from '@holdfast/engine';
import { describe, expect, it } from 'vitest';
import {
  buildLedger,
  type LedgerEntry,
  type OnChainRun,
  type PayoutEvidence,
  type Problem,
  type ProblemKind,
  reconcile,
  type ReconcileInput,
  type Reconciliation,
  solanaRunOnChain,
  type SwapRecord,
  tempoRunOnChain,
} from '../src/index';
import {
  CLOID,
  type History,
  OID,
  RECEIPT_HEIGHT,
  RECEIPT_TIME,
  SPEND_HEIGHT,
  SPEND_TX,
  SWAP_ID,
  USDC_HYPERCORE_ID,
  ZEC_ID,
  deposit,
  historyWithPayouts,
  journalOf,
  marginSwap,
  openShort,
  payoutEvidence,
  realHistory,
  realTicks,
  receiptNote,
  solanaRun,
  tempoRun,
} from './fixtures';

type Records = Required<Omit<ReconcileInput, 'assets'>>;
type Books = { -readonly [K in keyof Records]: Records[K] extends readonly (infer T)[] ? T[] : never };

function books(history: History = realHistory()): Books {
  return {
    ledger: buildLedger(history.records),
    journal: history.journal,
    payouts: history.payouts,
    swaps: [...history.records.swaps],
  };
}

const kinds = (result: Reconciliation) => result.problems.map((p) => p.kind);
const only = (result: Reconciliation, kind: ProblemKind): Problem => {
  expect(kinds(result)).toEqual([kind]);
  return result.problems[0] as Problem;
};
const edit = (ledger: LedgerEntry[], id: string, change: Partial<LedgerEntry>) => ledger.map((e) => (e.id === id ? { ...e, ...change } : e));

const DEPOSIT_ID = `zcash:${deposit.id}`;
const ARRIVAL_ID = `swap:${SWAP_ID}:in`;
const FILL_ID = `hl:fill:${OID}:${openShort.tid}`;
const [tempoEvidence, solanaEvidence] = payoutEvidence as [PayoutEvidence, PayoutEvidence];
const tempoOnChain = tempoEvidence.onChain as OnChainRun;
const solanaOnChain = solanaEvidence.onChain as OnChainRun;

/** The books with one payout run's evidence replaced. */
function withPayout(evidence: PayoutEvidence): Books {
  const all = books(historyWithPayouts());
  return { ...all, payouts: all.payouts.map((p) => (p.run.id === evidence.run.id ? evidence : p)) };
}

describe('books that agree', () => {
  it('finds nothing wrong with the real history', () => {
    const result = reconcile(books());
    expect(result.problems).toEqual([]);
    expect(result.matched).toEqual([
      { kind: 'swap', refs: [`swap:${SWAP_ID}`, DEPOSIT_ID, ARRIVAL_ID] },
      { kind: 'order', refs: ['journal:3', FILL_ID] },
      { kind: 'balance', refs: ['journal:1', 'journal:5'] },
    ]);
  });

  it('matches every payout line to its transfer', () => {
    const result = reconcile(books(historyWithPayouts()));
    expect(result.problems).toEqual([]);
    expect(result.matched.filter((m) => m.kind === 'payout_line')).toEqual([
      { kind: 'payout_line', refs: ['payout:HF-2026-10-0001:1', tempoRun.tx] },
      { kind: 'payout_line', refs: ['payout:HF-2026-10-0001:2', tempoRun.tx] },
      { kind: 'payout_line', refs: ['payout:HF-2026-11-0001:1', solanaRun.tx] },
    ]);
    expect(result.matched.filter((m) => m.kind === 'swap')).toHaveLength(2);
  });

  it('has nothing to say about empty books', () => {
    expect(reconcile({ ledger: [], journal: [] })).toEqual({ matched: [], problems: [] });
  });
});

describe('payout lines against transfers on chain', () => {
  it('reports a line whose transfer is missing', () => {
    const result = reconcile(withPayout({ run: tempoRun, onChain: { ...tempoOnChain, transfers: tempoOnChain.transfers.slice(0, 1) } }));
    const problem = only(result, 'missing_transfer');
    expect(problem).toMatchObject({ severity: 'error', refs: ['payout:HF-2026-10-0001:2', tempoRun.tx] });
    expect(problem.detail).toContain('HF-2026-10-0001/2');
    expect(result.matched.filter((m) => m.kind === 'payout_line')).toHaveLength(2);
  });

  it('reports every line of a paid run that is not on chain at all', () => {
    const result = reconcile(withPayout({ run: tempoRun, onChain: null }));
    expect(kinds(result)).toEqual(['missing_transfer', 'missing_transfer']);
  });

  it('reports a transfer of the wrong amount', () => {
    const [first, second] = tempoOnChain.transfers as [OnChainRun['transfers'][number], OnChainRun['transfers'][number]];
    const result = reconcile(withPayout({ run: tempoRun, onChain: { ...tempoOnChain, transfers: [first, { ...second, amount: 299_999_999n }] } }));
    const problem = only(result, 'wrong_amount');
    expect(problem.severity).toBe('error');
    expect(problem.detail).toBe('line 2 of run HF-2026-10-0001 is 300000000 but 299999999 was transferred');
  });

  it('reports a transfer to the wrong payee', () => {
    const [first, second] = tempoOnChain.transfers as [OnChainRun['transfers'][number], OnChainRun['transfers'][number]];
    const elsewhere = '0x000000000000000000000000000000000000dEaD';
    const result = reconcile(withPayout({ run: tempoRun, onChain: { ...tempoOnChain, transfers: [first, { ...second, to: elsewhere }] } }));
    expect(only(result, 'wrong_recipient').refs).toEqual(['payout:HF-2026-10-0001:2', tempoRun.tx]);
  });

  it('reports a memo that was paid twice in one transaction', () => {
    const [first] = tempoOnChain.transfers;
    const transfers = [...tempoOnChain.transfers, first as OnChainRun['transfers'][number]];
    const result = reconcile(withPayout({ run: tempoRun, onChain: { ...tempoOnChain, transfers } }));
    const problem = only(result, 'duplicate_memo');
    expect(problem.detail).toBe('memo "HF-2026-10-0001/1" is on 1 line(s) and 2 transfer(s) of run HF-2026-10-0001');
    expect(result.matched.filter((m) => m.kind === 'payout_line')).toHaveLength(2);
  });

  it('reports a run whose memos appear in a second transaction', () => {
    const result = reconcile(withPayout({ run: tempoRun, onChain: { ...tempoOnChain, otherTxs: ['0xbeef'] } }));
    expect(only(result, 'duplicate_memo')).toMatchObject({ severity: 'error', refs: ['run:HF-2026-10-0001', '0xbeef'] });
  });

  it('reports two lines that share a memo instead of guessing which was paid', () => {
    const lines = tempoRun.lines.map((line) => ({ ...line, memo: 'HF-2026-10-0001/1' }));
    const run = { ...tempoRun, lines };
    const all = withPayout({ run, onChain: tempoOnChain });
    const result = reconcile({ ...all, ledger: buildLedger({ ...historyWithPayouts().records, payoutRuns: [run, solanaRun] }) });
    expect(kinds(result)).toEqual(['duplicate_memo', 'unexpected_transfer']);
  });

  it('reports a transfer no line asked for', () => {
    const extra = { to: '0x000000000000000000000000000000000000dEaD', tokenAccount: null, amount: 5n, memo: 'HF-2026-10-0001/9' };
    const result = reconcile(withPayout({ run: tempoRun, onChain: { ...tempoOnChain, transfers: [...tempoOnChain.transfers, extra] } }));
    expect(only(result, 'unexpected_transfer').detail).toContain('with memo "HF-2026-10-0001/9"');
  });

  it('matches a Solana run that carries no line memos by payee and amount, and says so', () => {
    const bare = { ...solanaOnChain, transfers: solanaOnChain.transfers.map((t) => ({ ...t, memo: null })) };
    const result = reconcile(withPayout({ run: solanaRun, onChain: bare }));
    expect(only(result, 'memo_not_on_chain').severity).toBe('warning');
    expect(result.matched).toContainEqual({ kind: 'payout_line', refs: ['payout:HF-2026-11-0001:1', solanaRun.tx] });
  });

  it('still checks the amount of a transfer it had to match without a memo', () => {
    const bare = { ...solanaOnChain, transfers: solanaOnChain.transfers.map((t) => ({ ...t, memo: null, amount: 1n })) };
    expect(kinds(reconcile(withPayout({ run: solanaRun, onChain: bare })))).toEqual(['wrong_amount', 'memo_not_on_chain']);
  });

  it('accepts the token account as the payee on Solana, and compares its addresses exactly', () => {
    const [line] = solanaRun.lines;
    const [transfer] = solanaOnChain.transfers as [OnChainRun['transfers'][number]];
    const toTokenAccount = { ...solanaRun, lines: [{ ...line, toAddress: transfer.tokenAccount as string }] } as typeof solanaRun;
    const all = withPayout({ run: toTokenAccount, onChain: solanaOnChain });
    const ledger = buildLedger({ ...historyWithPayouts().records, payoutRuns: [tempoRun, toTokenAccount] });
    expect(reconcile({ ...all, ledger }).problems).toEqual([]);

    const lowered = { ...solanaOnChain, transfers: [{ ...transfer, to: transfer.to.toLowerCase(), tokenAccount: null }] };
    expect(kinds(reconcile(withPayout({ run: solanaRun, onChain: lowered })))).toEqual(['wrong_recipient']);
  });

  it('reports a run whose total is not the sum of its lines', () => {
    const result = reconcile(withPayout({ run: { ...tempoRun, total: 750_000_001n }, onChain: tempoOnChain }));
    expect(only(result, 'run_total_mismatch').detail).toBe('run HF-2026-10-0001 records a total of 750000001 but its lines add up to 750000000');
  });

  it('reports a run found in a different transaction than the one recorded', () => {
    const result = reconcile(withPayout({ run: tempoRun, onChain: { ...tempoOnChain, tx: '0xother' } }));
    expect(kinds(result)).toContain('run_tx_mismatch');
  });

  it('reports a run the database calls failed while the chain shows it paid', () => {
    const failed = { ...tempoRun, status: 'failed' };
    const all = withPayout({ run: failed, onChain: tempoOnChain });
    const ledger = buildLedger({ ...historyWithPayouts().records, payoutRuns: [failed, solanaRun] });
    expect(only(reconcile({ ...all, ledger }), 'run_status_mismatch').severity).toBe('error');
  });

  it('only warns about a run that is still being sent', () => {
    const sending = { ...tempoRun, status: 'sending' };
    const ledger = buildLedger({ ...historyWithPayouts().records, payoutRuns: [sending, solanaRun] });
    const landed = reconcile({ ...withPayout({ run: sending, onChain: tempoOnChain }), ledger });
    expect(only(landed, 'run_status_mismatch').severity).toBe('warning');
    const inFlight = reconcile({ ...withPayout({ run: sending, onChain: null }), ledger });
    expect(only(inFlight, 'run_unsettled').severity).toBe('warning');
  });

  it('has nothing to match for a draft', () => {
    const draft = { ...tempoRun, status: 'draft' };
    const ledger = buildLedger({ ...historyWithPayouts().records, payoutRuns: [draft, solanaRun] });
    expect(reconcile({ ...withPayout({ run: draft, onChain: null }), ledger }).problems).toEqual([]);
  });

  it('reports a ledger that does not hold exactly the paid lines', () => {
    const all = books(historyWithPayouts());
    const changed = reconcile({ ...all, ledger: edit(all.ledger, 'payout:HF-2026-10-0001:1', { amount: -450_000_001n }) });
    expect(only(changed, 'payout_ledger_mismatch').refs).toEqual(['payout:HF-2026-10-0001:1']);

    const dropped = reconcile({ ...all, ledger: all.ledger.filter((e) => e.id !== 'payout:HF-2026-10-0001:2') });
    expect(only(dropped, 'payout_ledger_mismatch').detail).toBe('payout:HF-2026-10-0001:2 is a paid line of run HF-2026-10-0001 and is not in the ledger');

    const unbacked = reconcile({ ...all, payouts: all.payouts.filter((p) => p.run.id !== solanaRun.id) });
    expect(only(unbacked, 'payout_ledger_mismatch').detail).toBe('ledger entry payout:HF-2026-11-0001:1 has no paid payout line behind it');
  });

  it('takes what the rails found in the shape each returns it', () => {
    const tempo = tempoRunOnChain({
      tx: tempoRun.tx as string,
      blockNumber: 5_120_334n,
      lines: tempoOnChain.transfers.map((t, i) => ({ to: t.to, amount: t.amount, memo: t.memo as string, logIndex: i + 4 })),
      otherTxs: [],
    } as Parameters<typeof tempoRunOnChain>[0]);
    const solana = solanaRunOnChain({
      runId: solanaRun.id,
      signature: solanaRun.tx as string,
      slot: 371_204_118n,
      time: solanaRun.executedAt,
      total: solanaRun.total,
      transfers: solanaOnChain.transfers.map((t) => ({ to: t.to, tokenAccount: t.tokenAccount as string, amount: t.amount, memo: t.memo })),
    } as Parameters<typeof solanaRunOnChain>[0]);
    expect(tempo).toEqual(tempoOnChain);
    expect(solana).toEqual(solanaOnChain);
    expect(tempoRunOnChain(null)).toBeNull();
    expect(solanaRunOnChain(null)).toBeNull();
  });
});

describe('swaps against their funding and their arrival', () => {
  const withSwap = (swap: SwapRecord, records = realHistory().records): Books => {
    const history = { ...realHistory(), records: { ...records, swaps: [swap] } };
    return books(history);
  };

  it('reports a swap no treasury payment funded', () => {
    const history = realHistory();
    const result = reconcile(books({ ...history, records: { ...history.records, outgoing: [] } }));
    const problem = result.problems.find((p) => p.kind === 'unfunded_swap');
    expect(problem).toMatchObject({ severity: 'error', refs: [`swap:${SWAP_ID}`, `swap:${SWAP_ID}:out`] });
    expect(problem?.detail).toBe(`swap ${SWAP_ID} took 930000 zat, and no transparent payment of that amount left the treasury for it`);
    expect(result.matched.some((m) => m.kind === 'swap')).toBe(false);
  });

  it('reports the second of two swaps when one payment could only fund one', () => {
    const second = { ...marginSwap, id: 'second-swap', createdAt: marginSwap.createdAt + 60_000, originTxs: [], destinationTxs: ['0xother'] };
    const history = realHistory();
    const all = books({ ...history, records: { ...history.records, swaps: [marginSwap, second] } });
    const result = reconcile(all);
    expect(kinds(result)).toEqual(['unfunded_swap']);
    expect(result.problems[0]?.refs).toEqual(['swap:second-swap', 'swap:second-swap:out']);
  });

  it('reports a deposit whose amount is not the swap input', () => {
    const all = books();
    const result = reconcile({ ...all, ledger: edit(all.ledger, DEPOSIT_ID, { amount: -929_999n }) });
    expect(kinds(result)).toContain('swap_funding_mismatch');
    expect(result.problems.find((p) => p.kind === 'swap_funding_mismatch')?.detail).toBe(
      `swap ${SWAP_ID} took 930000 zat but the payment booked as its deposit is 929999 zat`,
    );
  });

  it('reports a swap with two deposits booked against it', () => {
    const all = books();
    const twin = { ...(all.ledger.find((e) => e.id === DEPOSIT_ID) as LedgerEntry), id: 'zcash:twin' };
    expect(kinds(reconcile({ ...all, ledger: [...all.ledger, twin] }))).toContain('swap_funding_mismatch');
  });

  it('reports a deposit dated before its swap existed', () => {
    const all = books();
    const result = reconcile({ ...all, ledger: edit(all.ledger, DEPOSIT_ID, { ts: marginSwap.createdAt - 3 * 3_600_000 }) });
    expect(result.problems.find((p) => p.kind === 'swap_funding_mismatch')?.detail).toContain('before the swap was created');
  });

  it('reports a swap the ledger has no input for at all', () => {
    const all = books();
    const result = reconcile({ ...all, ledger: all.ledger.filter((e) => e.id !== DEPOSIT_ID) });
    expect(kinds(result)).toContain('swap_funding_mismatch');
  });

  it('reports a finished swap that records no arrival', () => {
    expect(kinds(reconcile(withSwap({ ...marginSwap, amountOut: null })))).toEqual(['swap_arrival_missing']);
    expect(kinds(reconcile(withSwap({ ...marginSwap, destinationTxs: [] })))).toEqual(['swap_arrival_missing']);
    const all = books();
    expect(kinds(reconcile({ ...all, ledger: all.ledger.filter((e) => e.id !== ARRIVAL_ID) }))).toEqual(['swap_arrival_missing']);
  });

  it('reports an arrival that differs from what the swap delivered', () => {
    const all = books();
    expect(kinds(reconcile({ ...all, ledger: edit(all.ledger, ARRIVAL_ID, { amount: 1_102_097_701n }) }))).toEqual(['swap_arrival_mismatch']);
    const elsewhere = { chain: 'hyperliquid', tx: '0xother', block: null, url: null };
    expect(kinds(reconcile({ ...all, ledger: edit(all.ledger, ARRIVAL_ID, { proof: elsewhere }) }))).toEqual(['swap_arrival_mismatch']);
  });

  it('reports a swap that delivered less than its quote guaranteed', () => {
    const result = reconcile(withSwap({ ...marginSwap, minAmountOut: 1_102_097_701n }));
    expect(only(result, 'swap_below_minimum').severity).toBe('error');
  });

  it('warns about money that left for a swap that has not delivered', () => {
    const pending = reconcile(withSwap({ ...marginSwap, state: 'PROCESSING', amountOut: null, destinationTxs: [] }));
    expect(only(pending, 'swap_unsettled')).toMatchObject({ severity: 'warning', refs: [`swap:${SWAP_ID}`, DEPOSIT_ID] });
    const refunded = reconcile(withSwap({ ...marginSwap, state: 'REFUNDED', amountOut: null, destinationTxs: [] }));
    expect(only(refunded, 'swap_unsettled').detail).toContain('ended as "REFUNDED" and delivered nothing');
  });

  it('reports a swap leg in the ledger that belongs to no swap', () => {
    const all = books();
    const result = reconcile({ ...all, swaps: [] });
    expect(kinds(result)).toEqual(['swap_entry_without_swap', 'swap_entry_without_swap']);
    expect(result.problems.map((p) => p.refs)).toEqual([[DEPOSIT_ID], [ARRIVAL_ID]]);
  });

  it('matches a swap paid in something other than ZEC against its own record', () => {
    const unlock: SwapRecord = { ...marginSwap, id: 'unlock-1', purpose: 'unlock', originAsset: USDC_HYPERCORE_ID, destinationAsset: ZEC_ID, amountIn: 1_100_000_000n, amountOut: 880_000n, minAmountOut: 870_000n, originTxs: ['0xout'], destinationTxs: ['t-tx'] };
    const all = books({ ...realHistory(), records: { ...realHistory().records, swaps: [marginSwap, unlock] } });
    const result = reconcile(all);
    expect(result.problems).toEqual([]);
    expect(result.matched).toContainEqual({ kind: 'swap', refs: ['swap:unlock-1', 'swap:unlock-1:out', 'swap:unlock-1:in'] });
  });

  it('has nothing to say about a quote nobody paid into', () => {
    const quoted = { ...marginSwap, id: 'quoted', state: 'PENDING_DEPOSIT', amountOut: null, originTxs: [], destinationTxs: [], amountIn: 5n };
    const all = books({ ...realHistory(), records: { ...realHistory().records, swaps: [marginSwap, quoted] } });
    expect(reconcile(all).problems).toEqual([]);
  });
});

describe('orders against fills', () => {
  const withJournal = (change: (journal: JournalEntry[]) => void): Books => {
    const all = books();
    const journal = structuredClone(all.journal);
    change(journal);
    return { ...all, journal };
  };

  it('reports a fill no order explains', () => {
    const history = realHistory();
    const manual = { ...openShort, cloid: null, oid: '570748780001', tid: '318274650999001', time: openShort.time + 60_000 };
    const result = reconcile(books({ ...history, records: { ...history.records, fills: [openShort, manual] } }));
    const problem = only(result, 'fill_without_order');
    expect(problem).toMatchObject({ severity: 'error', refs: ['hl:fill:570748780001:318274650999001'] });
    expect(problem.detail).toContain('carries no client order id');
  });

  it('reports a fill under a client order id the journal never placed', () => {
    const history = realHistory();
    const foreign = { ...openShort, cloid: '0x00000000000000000000000000000001' };
    const result = reconcile(books({ ...history, records: { ...history.records, fills: [foreign] } }));
    expect(kinds(result).sort()).toEqual(['fill_without_order', 'order_without_fill']);
  });

  it('reports an order the venue shows no fill for', () => {
    const history = realHistory();
    const result = reconcile(books({ ...history, records: { ...history.records, fills: [] } }));
    const problem = only(result, 'order_without_fill');
    expect(problem).toMatchObject({ severity: 'error', refs: ['journal:3'] });
    expect(problem.detail).toBe(`journal entry 3 records 1 lot(s) filled for order ${CLOID}, and the venue shows no fill for it`);
  });

  it('adds up the pieces an order filled in', () => {
    const history = realHistory();
    const pieces = [
      { ...openShort, size: 0.01, tid: '1' },
      { ...openShort, size: 0.02, px: 1226.3, tid: '2' },
    ];
    const all = books({ ...history, records: { ...history.records, fills: pieces } });
    expect(only(reconcile(all), 'fill_size_mismatch').detail).toBe(`journal entry 3 records 1 lot(s) filled for order ${CLOID}; the venue filled 3`);

    const journal = structuredClone(all.journal);
    (journal[2] as JournalEntry).order!.result.filledLots = 3;
    const agreed = reconcile({ ...all, journal });
    expect(agreed.problems).toEqual([]);
    expect(agreed.matched).toContainEqual({ kind: 'order', refs: ['journal:3', `hl:fill:${OID}:1`, `hl:fill:${OID}:2`] });
  });

  it('reports a fill on the wrong side', () => {
    const history = realHistory();
    const bought = { ...openShort, side: 'buy' as const, direction: 'Open Long' };
    const result = reconcile(books({ ...history, records: { ...history.records, fills: [bought] } }));
    expect(only(result, 'fill_side_mismatch').refs).toEqual(['journal:3', FILL_ID]);
  });

  it('reports an order the journal wrote off that the venue filled after all', () => {
    const result = reconcile(
      withJournal((journal) => {
        (journal[2] as JournalEntry).order!.result = { ok: false, filledLots: 0, avgPx: null, oid: null, error: 'outcome unknown: socket closed' };
      }),
    );
    expect(only(result, 'fill_size_mismatch').detail).toContain('records 0 lot(s) filled');
  });

  it('does not expect a fill for an order that did not trade', () => {
    const history = realHistory();
    const all = books({ ...history, records: { ...history.records, fills: [] } });
    const journal = structuredClone(all.journal);
    (journal[2] as JournalEntry).order!.result = { ok: false, filledLots: 0, avgPx: null, oid: null, error: 'Insufficient margin to place order' };
    expect(reconcile({ ...all, journal }).problems).toEqual([]);
  });

  it('reports a fractional fill count instead of failing on it', () => {
    const result = reconcile(
      withJournal((journal) => {
        (journal[2] as JournalEntry).order!.result.filledLots = 0.5;
      }),
    );
    expect(kinds(result)).toEqual(['fill_size_mismatch']);
  });

  it('reports two journal entries that used one client order id', () => {
    const result = reconcile(
      withJournal((journal) => {
        (journal[3] as JournalEntry).order = { ...(journal[2] as JournalEntry).order!, seq: 4 };
      }),
    );
    expect(only(result, 'duplicate_cloid').refs).toEqual(['journal:3', 'journal:4']);
  });

  it('compares client order ids without regard to case', () => {
    const history = realHistory();
    const upper = { ...openShort, cloid: CLOID.toUpperCase().replace('0X', '0x') };
    expect(reconcile(books({ ...history, records: { ...history.records, fills: [upper] } })).problems).toEqual([]);
  });
});

describe('recorded balances against the ledger', () => {
  it('reports a balance the ledger does not add up to', () => {
    const history = realHistory();
    const richer = { ...receiptNote, zat: 1_975_001n };
    const result = reconcile(books({ ...history, records: { ...history.records, notes: [richer, history.records.notes[1] as OwnedNote] } }));
    const problem = only(result, 'balance_mismatch');
    expect(problem).toMatchObject({ severity: 'error', refs: ['journal:1', 'journal:5'] });
    expect(problem.detail).toBe(
      "journal entries 1 to 5: the journal recorded 1975000 zat where the ledger's Zcash entries add up to 1975001 zat (-1)",
    );
  });

  it('reports each stretch of entries once, separating those that agree from those that do not', () => {
    const all = books();
    const result = reconcile({ ...all, ledger: all.ledger.filter((e) => e.kind !== 'network_fee') });
    const balance = result.problems.filter((p) => p.kind === 'balance_mismatch');
    expect(balance).toHaveLength(1);
    expect(balance[0]?.refs).toEqual(['journal:2', 'journal:5']);
    expect(balance[0]?.detail).toContain('(-15000)');
    expect(result.matched).toContainEqual({ kind: 'balance', refs: ['journal:1'] });
  });

  it('goes by the block the scan reached, not by the clock', () => {
    // The block's own timestamp is ahead of the tick that scanned it.
    const ahead = { ...receiptNote, time: (realTicks[0]?.at ?? 0) + 45_000 };
    const history = realHistory();
    const result = reconcile(books({ ...history, records: { ...history.records, notes: [ahead, history.records.notes[1] as OwnedNote] } }));
    expect(result.problems).toEqual([]);
  });

  it('does not count a block the scan had not reached', () => {
    const journal = journalOf([
      { at: RECEIPT_TIME + 30_000, treasury: { zat: 0n, scannedTo: RECEIPT_HEIGHT - 1 }, venue: null },
      { at: RECEIPT_TIME + 90_000, treasury: { zat: 1_975_000n, scannedTo: RECEIPT_HEIGHT }, venue: null },
    ]);
    const result = reconcile({ ledger: buildLedger({ notes: [receiptNote] }), journal });
    expect(result).toEqual({ matched: [{ kind: 'balance', refs: ['journal:1', 'journal:2'] }], problems: [] });
  });

  it('falls back on time for an entry that has no block', () => {
    const journal = journalOf([
      { at: RECEIPT_TIME + 60_000, treasury: { zat: 1_975_000n, scannedTo: RECEIPT_HEIGHT }, venue: null },
      { at: RECEIPT_TIME + 120_000, treasury: { zat: 1_965_000n, scannedTo: RECEIPT_HEIGHT + 1 }, venue: null },
    ]);
    const ledger = buildLedger({ notes: [receiptNote], fees: [{ txid: 'ee'.repeat(32), zat: 10_000n, time: RECEIPT_TIME + 90_000 }] });
    expect(reconcile({ ledger, journal }).problems).toEqual([]);
  });

  it('skips entries that could not read the treasury', () => {
    const journal = journalOf([
      { at: RECEIPT_TIME + 60_000, treasury: null, venue: null },
      { at: RECEIPT_TIME + 120_000, treasury: { zat: 1_975_000n, scannedTo: RECEIPT_HEIGHT }, venue: null },
    ]);
    const result = reconcile({ ledger: buildLedger({ notes: [receiptNote] }), journal });
    expect(result).toEqual({ matched: [{ kind: 'balance', refs: ['journal:2'] }], problems: [] });
  });

  it('does not judge balances once the treasury holds a note it cannot follow', () => {
    const sapling: OwnedNote = { ...receiptNote, id: `${'6b'.repeat(32)}:sapling:0`, txid: '6b'.repeat(32), pool: 'sapling', nullifier: null, spent: false, zat: 400_000n, height: SPEND_HEIGHT + 5, time: 0 };
    const history = realHistory();
    const result = reconcile(books({ ...history, records: { ...history.records, notes: [...history.records.notes, sapling] } }));
    const problem = only(result, 'balance_unverifiable');
    expect(problem).toMatchObject({ severity: 'warning', refs: ['journal:3', 'journal:5'] });
    expect(result.matched).toContainEqual({ kind: 'balance', refs: ['journal:1', 'journal:2'] });
  });
});

describe('records that cannot be trusted as given', () => {
  it('reports a ledger entry that appears twice', () => {
    const all = books();
    const result = reconcile({ ...all, ledger: [...all.ledger, all.ledger[0] as LedgerEntry] });
    expect(result.problems.find((p) => p.kind === 'duplicate_record')).toMatchObject({ severity: 'error', refs: [all.ledger[0]?.id] });
  });

  it('reports a swap or a run given twice', () => {
    const all = books(historyWithPayouts());
    const result = reconcile({ ...all, swaps: [...all.swaps, marginSwap], payouts: [...all.payouts, tempoEvidence] });
    expect(kinds(result)).toEqual(['duplicate_record', 'duplicate_record']);
    expect(result.problems.map((p) => p.refs)).toEqual([[`swap:${SWAP_ID}`], ['run:HF-2026-10-0001']]);
  });

  it('reports what it cannot read instead of throwing', () => {
    const all = books();
    const broken = structuredClone(all.journal) as unknown as { order: unknown; snapshot: { treasury: unknown } }[];
    (broken[2] as { order: unknown }).order = { cloid: 42 };
    (broken[0] as { snapshot: { treasury: unknown } }).snapshot.treasury = { zat: 'a lot', asOf: 0 };
    const result = reconcile({ ...all, journal: broken as unknown as JournalEntry[] });
    const unreadable = result.problems.filter((p) => p.kind === 'unreadable');
    expect(unreadable.map((p) => p.detail.split(':')[0])).toEqual(['orders could not be reconciled', 'treasury balances could not be reconciled']);
    expect(result.matched.some((m) => m.kind === 'swap')).toBe(true);
  });

  it('never loses a spend to the same transaction id seen twice', () => {
    const twice = buildLedger({ ...realHistory().records, fees: [{ txid: SPEND_TX, zat: 15_000n, height: SPEND_HEIGHT }, { txid: SPEND_TX, zat: 15_000n, height: SPEND_HEIGHT }] });
    expect(reconcile({ ...books(), ledger: twice }).problems).toEqual([]);
  });
});
