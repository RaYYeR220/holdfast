import { run } from '../src/cli';
import { type Env, nodeEnv, type Sources } from '../src/env';
import type { StepId, StepResult, StepStatus } from '../src/verify/report';

/** Sources for a test that must not reach the network at all. */
export const NO_NETWORK: Sources = {
  describeKey: async () => {
    throw new Error('the test reached for the key library');
  },
  zcash: async () => {
    throw new Error('the test reached for the Zcash network');
  },
  hyperliquid: async () => {
    throw new Error('the test reached for Hyperliquid');
  },
};

/** When the reader runs the tool: five minutes after the demo statement was made. */
export const READING_AT = Date.parse('2026-10-09T16:35:30Z');

export interface Outcome {
  code: number;
  out: string;
  err: string;
}

/** Run the tool against files held in memory. */
export async function holdfast(argv: string[], files: Record<string, string> = {}, sources: Sources = NO_NETWORK, over: Partial<Env> = {}): Promise<Outcome> {
  const out: string[] = [];
  const err: string[] = [];
  const env: Env = {
    ...nodeEnv(),
    out: (line) => void out.push(line),
    err: (line) => void err.push(line),
    readFile: async (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      return content;
    },
    sources,
    now: () => READING_AT,
    ...over,
  };
  const code = await run(argv, env);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

export interface VerifyReport {
  ok: boolean;
  verdict: 'verified' | 'not verified' | 'failed';
  ageMs: number;
  steps: (StepResult & { title: string })[];
}

export const report = (outcome: Outcome): VerifyReport => JSON.parse(outcome.out) as VerifyReport;

export function statuses(outcome: Outcome): Record<StepId, StepStatus> {
  return Object.fromEntries(report(outcome).steps.map((step) => [step.id, step.status])) as Record<StepId, StepStatus>;
}

export function stepOf(outcome: Outcome, id: StepId): StepResult {
  const step = report(outcome).steps.find((s) => s.id === id);
  if (step === undefined) throw new Error(`no step ${id}`);
  return step;
}
