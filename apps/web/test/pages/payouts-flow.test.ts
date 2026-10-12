import { describe, expect, it } from 'vitest';
import { EMPTY_LINE, type LineDraft, type RunContext, type TermsDraft, addressProblem, checkRun, checkTerms, executionTold, failureTold, isSolanaAddress, leftAfter, limitWords, solanaCostTotal } from '../../src/app/_sections/payouts/flow';

const PAYEES = ['0x3c71213434d56CC8ACDe9Fb1c6b3d4920e40E19A', '0xF3009617E5A04f001Fc6839Def7A7f8A7ab4545b', '0x166EAfA209a18A105D592c726d21e19D2ad37568'] as const;
const SOLANA_PAYEES = ['9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy'] as const;
const NOW = 1_791_640_000;

describe('a typed address', () => {
  it('is a Solana address when it is base58 for thirty-two bytes', () => {
    expect(isSolanaAddress(SOLANA_PAYEES[0])).toBe(true);
    expect(isSolanaAddress('11111111111111111111111111111111')).toBe(true);
    expect(isSolanaAddress(PAYEES[0])).toBe(false);
    expect(isSolanaAddress(SOLANA_PAYEES[0].slice(0, 30))).toBe(false);
    expect(isSolanaAddress(`${SOLANA_PAYEES[0]}${SOLANA_PAYEES[1]}`)).toBe(false);
    expect(isSolanaAddress('0OIl')).toBe(false);
    expect(isSolanaAddress('')).toBe(false);
  });

  it('is held to the chain of the run, and a Tempo address to its checksum', () => {
    expect(addressProblem('tempo', PAYEES[0])).toBeNull();
    expect(addressProblem('tempo', PAYEES[0].toLowerCase())).toBeNull();
    expect(addressProblem('tempo', `${PAYEES[0].slice(0, -1)}a`)).toMatch(/checksum/);
    expect(addressProblem('tempo', SOLANA_PAYEES[0])).toMatch(/not a Tempo address/);
    expect(addressProblem('solana', SOLANA_PAYEES[0])).toBeNull();
    expect(addressProblem('solana', PAYEES[0])).toBe('This is not a Solana address.');
    expect(addressProblem('solana', '')).toBe('Enter the address to pay.');
  });
});

describe('the bounds of the access key as a form describes them', () => {
  const draft: TermsDraft = { limit: '250', periodDays: 30, expiryDays: 90, anyRecipient: false, recipients: `${PAYEES[0]}\n${PAYEES[1].toLowerCase()}` };

  it('become the terms the server takes: base units, seconds, an expiry counted from now, addresses with their checksum', () => {
    expect(checkTerms(draft, 6, NOW)).toEqual({ ok: true, terms: { limit: 250_000_000n, periodSeconds: 30 * 86_400, expiry: NOW + 90 * 86_400, recipients: [PAYEES[0], PAYEES[1]] } });
  });

  it('name no recipients at all when any recipient is allowed, whatever the list holds', () => {
    const check = checkTerms({ ...draft, anyRecipient: true, recipients: 'not an address' }, 6, NOW);
    expect(check).toEqual({ ok: true, terms: { limit: 250_000_000n, periodSeconds: 30 * 86_400, expiry: NOW + 90 * 86_400 } });
    expect(check.ok && 'recipients' in check.terms).toBe(false);
  });

  it('make a limit that is given once a period of nothing', () => {
    expect(checkTerms({ ...draft, periodDays: 0 }, 6, NOW)).toMatchObject({ ok: true, terms: { periodSeconds: 0 } });
  });

  it('are refused with the reason for a limit that is no amount', () => {
    expect(checkTerms({ ...draft, limit: '' }, 6, NOW)).toEqual({ ok: false, errors: { limit: 'Enter an amount.' } });
    expect(checkTerms({ ...draft, limit: '0' }, 6, NOW)).toMatchObject({ ok: false, errors: { limit: 'The amount has to be more than nothing.' } });
  });

  it('are refused when the list of recipients is empty, holds something that is no address, repeats one, or is too long', () => {
    expect(checkTerms({ ...draft, recipients: ' \n ' }, 6, NOW)).toEqual({ ok: false, errors: { recipients: 'List at least one address the key may pay, or allow any recipient.' } });
    expect(checkTerms({ ...draft, recipients: `${PAYEES[0]}\nAda Lovelace` }, 6, NOW)).toMatchObject({ ok: false, errors: { recipients: expect.stringContaining('"Ada"') } });
    expect(checkTerms({ ...draft, recipients: `${PAYEES[0]}, ${PAYEES[0].toLowerCase()}` }, 6, NOW)).toMatchObject({ ok: false, errors: { recipients: expect.stringContaining('listed twice') } });
    const many = Array.from({ length: 26 }, (_unused, index) => `0x${index.toString(16).padStart(40, '0')}`).join('\n');
    expect(checkTerms({ ...draft, recipients: many }, 6, NOW)).toEqual({ ok: false, errors: { recipients: 'A key lists at most 25 recipients; this list has 26.' } });
  });

  it('are written out as a sentence', () => {
    const token = { symbol: 'USDC.e', decimals: 6 };
    expect(limitWords({ limit: 250_000_000n, periodSeconds: 30 * 86_400 }, token)).toBe('250.00 USDC.e in every period of 30 days');
    expect(limitWords({ limit: 2_000_000n, periodSeconds: 0 }, token)).toBe('2.00 USDC.e, once, with no refill');
  });
});

describe('the lines of a new run', () => {
  const tempo: RunContext = { chain: 'tempo', decimals: 6, symbol: 'USDC.e', remaining: 1_250_000n, recipients: [PAYEES[0], PAYEES[1]] };
  const solana: RunContext = { chain: 'solana', decimals: 6, symbol: 'USDC', remaining: 750_000n, recipients: null };
  const line = (over: Partial<LineDraft>): LineDraft => ({ ...EMPTY_LINE, name: 'Ada Lovelace', address: PAYEES[0], amount: '0.40', reference: 'INV-1041', ...over });

  it('become the lines the API takes when every one is whole', () => {
    const check = checkRun([line({}), line({ name: ' Grace Hopper ', address: PAYEES[1].toLowerCase(), amount: '0.35', reference: '' })], tempo);
    expect(check.problem).toBeNull();
    expect(check.warnings).toEqual([]);
    expect(check.total).toBe(750_000n);
    expect(check.payload).toEqual([
      { payee: { name: 'Ada Lovelace', address: PAYEES[0] }, amount: 400_000n, reference: 'INV-1041' },
      { payee: { name: 'Grace Hopper', address: PAYEES[1] }, amount: 350_000n, reference: '' },
    ]);
  });

  it('say of each field what is wrong with it, and give no lines to send while anything is', () => {
    const check = checkRun([line({ name: '', address: 'nobody', amount: 'lots', reference: ' padded ' })], tempo);
    expect(check.lines[0]).toEqual({
      units: null,
      name: 'Enter the name of the payee.',
      address: 'This is not a Tempo address: 0x and forty hexadecimal characters.',
      amount: 'Write the amount as a plain number, such as 250 or 250.50.',
      reference: 'A reference must not start or end with a space.',
    });
    expect(check.payload).toBeNull();
    expect(check.total).toBe(0n);
  });

  it('say at once when a Tempo recipient is not on the key’s list, and still let the run be drafted', () => {
    const check = checkRun([line({}), line({ address: PAYEES[2] })], tempo);
    expect(check.warnings).toEqual([`Line 2: ${PAYEES[2]} is not among the recipients the access key lists. The chain would refuse the whole run.`]);
    expect(check.payload).toHaveLength(2);
    expect(checkRun([line({ address: PAYEES[2] })], { ...tempo, recipients: null }).warnings).toEqual([]);
  });

  it('say at once when the total is over what the key has left', () => {
    const over = checkRun([line({ amount: '1' }), line({ address: PAYEES[1], amount: '0.30' })], tempo);
    expect(over.warnings).toEqual(['The run totals 1.30 USDC.e; the access key has 1.25 USDC.e left in this period. The chain would refuse the whole run.']);
    expect(checkRun([line({ amount: '1.25' })], tempo).warnings).toEqual([]);
    const allowance = checkRun([{ name: 'Linus', address: SOLANA_PAYEES[0], amount: '0.80', reference: '' }], solana);
    expect(allowance.warnings).toEqual(['The run totals 0.80 USDC; the delegate has 0.75 USDC of allowance left. The chain would refuse the whole run.']);
    expect(checkRun([line({ amount: '999' })], { ...tempo, remaining: null }).warnings).toEqual([]);
  });

  it('hold a Solana run to addresses of Solana and to references that are each their own', () => {
    const check = checkRun(
      [
        { name: 'Linus', address: SOLANA_PAYEES[0], amount: '0.40', reference: 'INV-7' },
        { name: 'Margaret', address: SOLANA_PAYEES[1], amount: '0.35', reference: 'INV-7' },
        { name: 'Ada', address: PAYEES[0], amount: '0.10', reference: '' },
        { name: 'Grace', address: SOLANA_PAYEES[1], amount: '0.10', reference: '' },
      ],
      { ...solana, remaining: null },
    );
    expect(check.lines[0]).toEqual({ units: 400_000n });
    expect(check.lines[1]?.reference).toMatch(/earlier line has this reference/);
    expect(check.lines[2]?.address).toBe('This is not a Solana address.');
    expect(check.lines[3]).toEqual({ units: 100_000n });
    expect(check.payload).toBeNull();
  });

  it('do not ask a Tempo run for references of its own: the memo on chain is the run id and the line', () => {
    expect(checkRun([line({}), line({ address: PAYEES[1] })], tempo).payload).toHaveLength(2);
  });

  it('refuse a reference that would not go on chain as written', () => {
    expect(checkRun([line({ reference: 'café' })], tempo).lines[0]?.reference).toMatch(/plain letters/);
    expect(checkRun([line({ reference: 'x'.repeat(65) })], tempo).lines[0]?.reference).toBe('A reference has at most 64 characters; this one has 65.');
  });

  it('refuse a run with no line and one with more lines than the server takes, on either rail', () => {
    expect(checkRun([], tempo)).toMatchObject({ problem: 'A run has at least one line.', payload: null });
    const many = Array.from({ length: 33 }, () => line({}));
    expect(checkRun(many, { ...tempo, remaining: null })).toMatchObject({ problem: 'A run carries at most 32 lines; this one has 33.', payload: null });
    expect(checkRun(many.slice(0, 32), { ...tempo, remaining: null }).problem).toBeNull();
    const solanaLines = Array.from({ length: 33 }, (_unused, index) => ({ name: 'Linus', address: SOLANA_PAYEES[0], amount: '0.01', reference: `INV-${index}` }));
    expect(checkRun(solanaLines, { ...solana, remaining: null })).toMatchObject({ problem: 'A run carries at most 32 lines; this one has 33.', payload: null });
  });
});

describe('what a run leaves of a limit', () => {
  it('is the difference, and unknown when the limit is unknown or does not cover the run', () => {
    expect(leftAfter(1_250_000n, 750_000n)).toBe(500_000n);
    expect(leftAfter(750_000n, 750_000n)).toBe(0n);
    expect(leftAfter(500_000n, 750_000n)).toBeNull();
    expect(leftAfter(null, 750_000n)).toBeNull();
  });

  it('adds up what a Solana run takes from the SOL of the service key', () => {
    expect(solanaCostTotal({ newTokenAccounts: 2, rentLamports: 4_078_560n, markerLamports: 897_840n, feeLamports: 5_000n })).toBe(4_981_400n);
  });
});

describe('a failed step in words', () => {
  it('says that nothing was signed when the treasurer declined', () => {
    expect(failureTold({ code: 'wallet_rejected', message: 'signing the authorization was declined in the wallet', status: null })).toEqual({
      kind: 'warning',
      word: 'Declined',
      title: 'You declined',
      body: ['Signing the authorization was declined in the wallet.', 'Nothing was signed and nothing was sent. Nothing has changed.'],
    });
  });

  it('gives a refusal of the server in the server’s own words, with every problem it listed', () => {
    const told = failureTold({ code: 'refused', message: 'the sponsor cannot pay the fee: it holds 0.00 and the transaction may cost 0.42', status: 409 });
    expect(told).toMatchObject({ kind: 'refusal', word: 'Refused', body: ['The sponsor cannot pay the fee: it holds 0.00 and the transaction may cost 0.42.'] });
    const invalid = failureTold({ code: 'invalid_input', message: 'the body is not valid', status: 400, details: { problems: ['body.lines.0.amount: Invalid string', 7] } });
    expect(invalid.body).toEqual(['The body is not valid.', 'Body.lines.0.amount: Invalid string.']);
  });

  it('does not say a transaction failed when the chain only has not shown it yet', () => {
    const told = failureTold({ code: 'not_confirmed', message: 'the chain does not show an allowance of 1500000 yet', status: null });
    expect(told.kind).toBe('warning');
    expect(told.body[1]).toContain('does not mean the transaction failed');
  });

  it('says it is not known whether a request arrived when the server did not answer', () => {
    expect(failureTold({ code: 'network', message: 'the server could not be reached', status: null }).body[1]).toContain('not known');
  });

  it('tells a wallet that failed from one that was declined, a signer of the wrong account, and a session that ended', () => {
    expect(failureTold({ code: 'wallet_failed', message: 'signing the transaction failed in the wallet: Attempt to debit an account but found no record of a prior credit.', status: null })).toMatchObject({ kind: 'refusal', word: 'Failed' });
    expect(failureTold({ code: 'wrong_account', message: 'the wallet shares A, and the transaction has to be signed by B', status: null })).toMatchObject({ word: 'Wrong account' });
    expect(failureTold({ code: 'unauthenticated', message: 'sign in first', status: 401 })).toMatchObject({ word: 'Signed out' });
    expect(failureTold({ code: 'unexpected_request', message: 'the transaction the server prepared approves another amount than the one asked for; nothing was signed', status: null })).toMatchObject({ kind: 'refusal', word: 'Stopped' });
    expect(failureTold({ code: 'something_new', message: 'no', status: 500 })).toMatchObject({ kind: 'warning', word: 'Failed', body: ['No.'] });
  });
});

describe('the end of an attempt to pay a run in words', () => {
  const base = { replayed: false, error: null, chain: 'tempo' as const, hasTx: true };

  it('tells a run this call paid from one that was already paid, and calls the second the product working', () => {
    expect(executionTold({ ...base, outcome: 'paid' })).toMatchObject({ kind: 'done', word: 'Paid', title: 'The run is paid' });
    expect(executionTold({ ...base, outcome: 'paid', replayed: true })).toMatchObject({ kind: 'info', word: 'Already paid', title: 'This run was already paid; nothing was sent' });
  });

  it('says nothing was sent for a refusal, with the reason', () => {
    const told = executionTold({ ...base, outcome: 'refused', error: 'access key is not authorized on this account', hasTx: false });
    expect(told).toMatchObject({ kind: 'refusal', word: 'Refused', title: 'Nothing was sent' });
    expect(told.body[0]).toBe('Access key is not authorized on this account.');
  });

  it('says a failed transaction paid no line', () => {
    expect(executionTold({ ...base, outcome: 'failed', error: 'the transaction failed on chain: custom program error 0x1', chain: 'solana' })).toMatchObject({ kind: 'refusal', word: 'Failed', title: 'A transaction was sent and paid nothing' });
  });

  it('never calls an unsettled run unpaid, says what is known, and says that asking again is safe', () => {
    const told = executionTold({ ...base, outcome: 'unsettled', error: 'the outcome of the payout is unknown: confirmation timed out', chain: 'solana' });
    expect(told).toMatchObject({ kind: 'warning', word: 'Not settled', title: 'Whether the run is paid is not established' });
    expect(told.body).toEqual([
      'The outcome of the payout is unknown: confirmation timed out.',
      'A transaction for this run was signed, and its fate has not been read from the chain.',
      'Do not treat the run as unpaid, and do not pay it by hand. Asking again is safe: Solana accepts one payout for a run id, whoever sends the second, and the rail looks the run up before it sends.',
    ]);
    expect(executionTold({ ...base, outcome: 'unsettled', hasTx: false }).body).toContain('No transaction is named in the answer.');
    expect(executionTold({ ...base, outcome: 'unsettled' }).body.at(-1)).toContain('looks the run up on Tempo before it sends anything');
  });

  it('says a run that was not sent for a passing reason is as it was', () => {
    expect(executionTold({ ...base, outcome: 'not_sent', error: 'could not rule out that run HF-2027-01-0001 was paid', hasTx: false })).toMatchObject({ kind: 'warning', word: 'Not sent' });
  });
});
