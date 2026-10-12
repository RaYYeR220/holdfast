import type { ProbeKind } from '@/server/safety/service';
import type { SafetyData } from './model';

/**
 * The four probes an owner can run, each described before it is run: which
 * key signs, exactly what is sent and where, what the chain or venue is
 * expected to answer, and what it costs the service. The descriptions follow
 * what the server sends for each kind.
 */
export interface ProbeSpec {
  kind: ProbeKind;
  title: string;
  /** The key that signs. */
  signer: string;
  /** What is sent. */
  sends: string;
  /** Whom it is addressed to: always an account of the team's own, or a payee the key already lists. */
  to: { what: string; address: string | null };
  /** What has to come back for the limit to have held. */
  expected: string;
  cost: string;
  /** Why the probe cannot be run as things stand, with where that is put right; null when it can. */
  blocked: { reason: string; fix: 'payouts' } | null;
}

/** The dollars the Hyperliquid probe asks for in each of its two requests, as the page writes the amount. */
const HYPERLIQUID_PROBE_USD = 'five';

/** The payees the Tempo access key lists, as the chain reported them; null when it lists none or was not read. */
function tempoRecipients(data: SafetyData): string[] | null {
  const scope = data.keys.find((key) => key.kind === 'tempo_access')?.scope;
  if (scope?.status !== 'ok') return null;
  const value = scope.value as { scope?: { recipients?: unknown } } | null;
  const recipients = value?.scope?.recipients;
  return Array.isArray(recipients) && recipients.every((item) => typeof item === 'string') ? (recipients as string[]) : null;
}

export function probeSpecs(data: SafetyData): ProbeSpec[] {
  const { facts } = data;
  const firstRecipient = tempoRecipients(data)?.[0] ?? null;
  const noTempo: ProbeSpec['blocked'] = facts.tempo.account === null ? { reason: 'The organisation has no Tempo account yet, so there is no account for the access key to be tried against.', fix: 'payouts' } : null;
  const noSolana: ProbeSpec['blocked'] = facts.solana.owner === null ? { reason: 'The organisation has not named a Solana wallet yet, so there is no token account for the delegate to be tried against.', fix: 'payouts' } : null;
  const tempoToken = facts.tempo.token.symbol;

  return [
    {
      kind: 'hyperliquid_withdrawal',
      title: 'Withdraw with the agent key',
      signer: 'The Hyperliquid agent key',
      sends: `Two signed requests to the exchange: a withdrawal of ${HYPERLIQUID_PROBE_USD} USDC and a transfer of ${HYPERLIQUID_PROBE_USD} USDC.`,
      to: { what: 'The team’s own Hyperliquid account', address: facts.hyperliquidAccount },
      expected: 'The exchange turns both down. Its answers are kept word for word. No transaction exists either way.',
      cost: 'Nothing. A refused request to the exchange carries no fee.',
      blocked: null,
    },
    {
      kind: 'tempo_over_limit',
      title: 'Pay over the Tempo limit',
      signer: 'The Tempo access key',
      sends: `One transaction calling transferWithMemo on ${tempoToken} for the largest amount there is, sent without simulation so that the chain records what happens.`,
      to:
        firstRecipient !== null
          ? { what: 'The first recipient the key lists', address: firstRecipient }
          : { what: 'The first recipient the key lists, or the team’s own Tempo account when it lists none', address: facts.tempo.account },
      expected: 'Tempo includes the transaction and reverts it with SpendingLimitExceeded.',
      cost: 'One transaction fee on Tempo, paid by the service’s sponsor account. Nothing is taken from the key’s limit.',
      blocked: noTempo,
    },
    {
      kind: 'tempo_out_of_scope',
      title: 'Call outside the Tempo scope',
      signer: 'The Tempo access key',
      sends: `One transaction calling a plain transfer of one base unit of ${tempoToken}, sent without simulation. A plain transfer is not transferWithMemo, the only call the key is scoped for.`,
      to: { what: 'The team’s own Tempo account', address: facts.tempo.account },
      expected: 'Tempo includes the transaction and reverts it with CallNotAllowed.',
      cost: 'One transaction fee on Tempo, paid by the service’s sponsor account. Nothing is taken from the key’s limit.',
      blocked: noTempo,
    },
    {
      kind: 'solana_over_allowance',
      title: 'Transfer over the Solana allowance',
      signer: 'The Solana delegate key',
      sends: `One transaction transferring one base unit of ${facts.solana.token.symbol} more than the allowance out of the team’s token account, with preflight skipped so that the chain records what happens.`,
      to: { what: 'The team’s own Solana wallet', address: facts.solana.owner },
      expected: 'Solana includes the transaction and the Token program fails it.',
      cost: 'One transaction fee on Solana, paid by the delegate key out of the SOL the service gives it.',
      blocked: noSolana,
    },
  ];
}
