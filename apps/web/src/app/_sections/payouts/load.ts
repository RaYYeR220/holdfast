import type { OrgRecord } from '@holdfast/db';
import { headers } from 'next/headers';
import { cache } from 'react';
import { readConfig } from '@/server/config';
import { demoOrg } from '@/server/demo/service';
import { ApiError, ConfigError } from '@/server/errors';
import { type Audience, type ReceiptShown, type RunPageShown, type RunShown, type SolanaRailShown, type TempoRailShown, payoutRunShown, payoutRunsShown, receiptShown, solanaRailShown, tempoRailShown } from '@/server/pages/payouts';
import { type SolanaReads, solanaReads } from '@/server/pages/payouts-solana';
import { messageOf } from '@/server/redact';
import { runtime } from '@/server/runtime';
import { loadDemo } from '../../_lib/demo';

/**
 * What the Payouts pages and the receipt page read, straight from the
 * services on the real dependencies. Nothing here throws: a chain, a node or
 * a database that cannot be read comes back as a state the page can show,
 * and each part of a page fails on its own.
 */

export interface Failure {
  /** Which source failed: "tempo", "solana", "database" or "configuration". */
  source: string;
  reason: string;
  /** When the read was attempted. */
  at: number;
}

export type Loaded<T> = { status: 'ok'; value: T } | ({ status: 'unavailable' } & Failure);

/** How long a page waits for one of its sources before it shows that part as unavailable. */
const PATIENCE_MS = 15_000;

class Slow extends Error {}

function within<T>(ms: number, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Slow()), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function failureOf(error: unknown, source: string, at: number): Failure {
  const deps = runtime();
  // A missing or malformed setting names its variable and never its value.
  if (error instanceof ConfigError) return { source: error.variable === 'DATABASE_URL' ? 'database' : 'configuration', reason: error.message, at };
  if (error instanceof Slow) return { source, reason: `no answer within ${PATIENCE_MS / 1000} s`, at };
  if (error instanceof ApiError) return { source: String(error.details.source ?? source), reason: deps.redact(error.message), at };
  deps.report(deps.redact(error instanceof Error ? (error.stack ?? error.message) : messageOf(error)));
  return { source, reason: source === 'database' ? 'the database could not be read' : `${source} could not be read`, at };
}

async function attempt<T>(source: string, work: () => Promise<T>): Promise<Loaded<T>> {
  const at = Date.now();
  try {
    return { status: 'ok', value: await within(PATIENCE_MS, work()) };
  } catch (error) {
    return { status: 'unavailable', ...failureOf(error, source, at) };
  }
}

let nodeReads: SolanaReads | undefined;

/** The reads of the configured Solana node, made the first time a page needs them. */
function reads(): SolanaReads {
  nodeReads ??= solanaReads(readConfig(process.env).solana());
  return nodeReads;
}

export type DemoOrgRead = { status: 'ok'; org: OrgRecord } | ({ status: 'empty' } & Failure) | ({ status: 'unavailable' } & Failure);

/** The organisation behind the public demo, read once for a request. */
export const loadDemoOrg = cache(async (): Promise<DemoOrgRead> => {
  const demo = await loadDemo();
  if (demo.status !== 'ok') return { status: demo.status, source: demo.source, reason: demo.reason, at: demo.at };
  const org = await attempt('database', () => demoOrg(runtime(), demo.org.id));
  return org.status === 'ok' ? { status: 'ok', org: org.value } : org;
});

export interface PayoutsData {
  tempo: Loaded<TempoRailShown>;
  solana: Loaded<SolanaRailShown>;
  runs: Loaded<RunShown[]>;
}

/** The two rails as their chains report them now, and the runs. */
export async function loadPayouts(org: OrgRecord, audience: Audience): Promise<PayoutsData> {
  const deps = runtime();
  const [tempo, solana, runs] = await Promise.all([
    attempt('tempo', () => tempoRailShown(deps, org)),
    attempt('solana', () => solanaRailShown(deps, org, reads())),
    attempt('database', () => payoutRunsShown(deps, org, audience)),
  ]);
  return { tempo, solana, runs };
}

export interface RunData {
  /** A null value when the reader has no such run. */
  page: Loaded<RunPageShown | null>;
  /** The rail the run is paid through, for a run of the owner's that is not paid yet; null otherwise. */
  tempo: Loaded<TempoRailShown> | null;
  solana: Loaded<SolanaRailShown> | null;
}

export async function loadRun(org: OrgRecord, runId: string, audience: Audience): Promise<RunData> {
  const deps = runtime();
  const page = await attempt('database', () => payoutRunShown(deps, org, runId, audience, reads()));
  const unpaid = audience === 'owner' && page.status === 'ok' && page.value !== null && page.value.run.status !== 'paid' ? page.value.run.chain : null;
  return {
    page,
    tempo: unpaid === 'tempo' ? await attempt('tempo', () => tempoRailShown(deps, org)) : null,
    solana: unpaid === 'solana' ? await attempt('solana', () => solanaRailShown(deps, org, reads())) : null,
  };
}

/** The receipt behind a token; a null value when there is none. */
export async function loadReceipt(token: string): Promise<Loaded<ReceiptShown | null>> {
  return attempt('database', () => receiptShown(runtime(), token));
}

/**
 * The address the pages are served from, for a link that is copied and sent
 * to somebody else. It is the configured host where there is one, and the
 * host the request named otherwise.
 */
export async function siteOrigin(): Promise<string> {
  const asked = await headers();
  let host: string | null = null;
  try {
    host = runtime().publicHost;
  } catch {
    host = null;
  }
  host ??= asked.get('x-forwarded-host') ?? asked.get('host') ?? 'localhost';
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  return `${asked.get('x-forwarded-proto') ?? (local ? 'http' : 'https')}://${host}`;
}
