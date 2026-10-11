import { describe, expect, it } from 'vitest';
import { parseArgs, UsageError } from '../src/args';
import { USAGE } from '../src/cli';
import { holdfast } from './harness';

const SPEC = { flags: ['--json', '--offline'], options: ['--policy', '--endpoint'] };

describe('reading the command line', () => {
  it('tells flags, options and plain arguments apart', () => {
    const args = parseArgs(['statement.json', '--json', '--policy', 'p.json', '--endpoint=https://a:443', '--endpoint', 'https://b:443'], SPEC);
    expect(args.positionals).toEqual(['statement.json']);
    expect(args.has('--json')).toBe(true);
    expect(args.has('--offline')).toBe(false);
    expect(args.one('--policy')).toBe('p.json');
    expect(args.all('--endpoint')).toEqual(['https://a:443', 'https://b:443']);
    expect(args.one('--missing')).toBeUndefined();
    expect(args.all('--missing')).toEqual([]);
  });

  it('keeps everything after -- as plain arguments', () => {
    expect(parseArgs(['--json', '--', '--policy', 'x'], SPEC).positionals).toEqual(['--policy', 'x']);
  });

  it('keeps an equals sign that belongs to the value', () => {
    expect(parseArgs(['--policy=a=b.json'], SPEC).one('--policy')).toBe('a=b.json');
    expect(parseArgs(['--policy='], SPEC).one('--policy')).toBe('');
  });

  it.each([
    [['--fast'], 'unknown option --fast'],
    [['--policy'], '--policy needs a value'],
    [['--policy', '--json'], '--policy needs a value'],
    [['--json=yes'], '--json takes no value'],
  ])('rejects %j', (argv, message) => {
    expect(() => parseArgs(argv, SPEC)).toThrow(new UsageError(message));
  });

  it('rejects an option given twice where one value is wanted', () => {
    expect(() => parseArgs(['--policy', 'a', '--policy', 'b'], SPEC).one('--policy')).toThrow('--policy was given more than once');
  });
});

describe('holdfast', () => {
  it('prints its usage when asked', async () => {
    for (const word of ['help', '--help', '-h']) {
      expect(await holdfast([word])).toEqual({ code: 0, out: USAGE, err: '' });
    }
  });

  it('exits 1 with the usage when called without a command or with an unknown one', async () => {
    expect(await holdfast([])).toEqual({ code: 1, out: '', err: `holdfast: no command given\n\n${USAGE}` });
    expect(await holdfast(['audit'])).toEqual({ code: 1, out: '', err: `holdfast: unknown command "audit"\n\n${USAGE}` });
  });

  it('reports an unexpected failure in one line instead of a stack trace', async () => {
    const outcome = await holdfast(['backtest'], {}, undefined, {
      loadBars: async () => {
        throw new Error('market data is missing');
      },
    });
    expect(outcome).toEqual({ code: 1, out: '', err: 'holdfast: market data is missing' });
  });
});
