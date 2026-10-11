/** A mistake in how the tool was called; the message is shown with the usage text. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface ArgSpec {
  /** Options that stand alone, such as `--json`. */
  flags: readonly string[];
  /** Options that take a value: `--policy file.json` or `--policy=file.json`. May be given more than once. */
  options: readonly string[];
}

export interface Args {
  positionals: string[];
  has(flag: string): boolean;
  /** The value of an option given once; an error if it was given twice. */
  one(option: string): string | undefined;
  all(option: string): string[];
}

export function parseArgs(argv: readonly string[], spec: ArgSpec): Args {
  const positionals: string[] = [];
  const flags = new Set<string>();
  const options = new Map<string, string[]>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const equals = arg.indexOf('=');
    const name = equals < 0 ? arg : arg.slice(0, equals);
    if (spec.flags.includes(name)) {
      if (equals >= 0) throw new UsageError(`${name} takes no value`);
      flags.add(name);
    } else if (spec.options.includes(name)) {
      const value = equals < 0 ? argv[++i] : arg.slice(equals + 1);
      if (value === undefined || (equals < 0 && value.startsWith('--'))) throw new UsageError(`${name} needs a value`);
      options.set(name, [...(options.get(name) ?? []), value]);
    } else {
      throw new UsageError(`unknown option ${name}`);
    }
  }

  return {
    positionals,
    has: (flag) => flags.has(flag),
    all: (option) => options.get(option) ?? [],
    one(option) {
      const values = options.get(option) ?? [];
      if (values.length > 1) throw new UsageError(`${option} was given more than once`);
      return values[0];
    },
  };
}
