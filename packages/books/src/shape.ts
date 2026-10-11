/**
 * A small structural checker for data read from a file. A check walks a
 * value and appends what is wrong with it, by path, so one pass reports every
 * fault instead of stopping at the first.
 */
export type Check = (value: unknown, path: string, faults: string[]) => void;

const typed =
  (name: string, test: (value: unknown) => boolean): Check =>
  (value, path, faults) => {
    if (!test(value)) faults.push(`${path}: expected ${name}`);
  };

export const text = typed('a string', (v) => typeof v === 'string');
export const flag = typed('true or false', (v) => typeof v === 'boolean');
export const number = typed('a number', (v) => typeof v === 'number' && Number.isFinite(v));
export const integer = typed('a whole number', (v) => typeof v === 'number' && Number.isSafeInteger(v));
export const amount = typed('an amount', (v) => typeof v === 'bigint');
export const anything: Check = () => {};

export const oneOf = (values: readonly string[]): Check =>
  typed(`one of ${values.join(', ')}`, (v) => typeof v === 'string' && values.includes(v));

export const nullable =
  (check: Check): Check =>
  (value, path, faults) => {
    if (value !== null) check(value, path, faults);
  };

export const list =
  (check: Check): Check =>
  (value, path, faults) => {
    if (!Array.isArray(value)) faults.push(`${path}: expected a list`);
    else value.forEach((item, i) => check(item, `${path}[${i}]`, faults));
  };

/** Fields beyond the ones named are left alone; a later version of a record may add some. */
export const record =
  (fields: Record<string, Check>): Check =>
  (value, path, faults) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      faults.push(`${path}: expected an object`);
      return;
    }
    const given = value as Record<string, unknown>;
    for (const [name, check] of Object.entries(fields)) {
      if (!Object.hasOwn(given, name)) faults.push(`${path}.${name}: missing`);
      else check(given[name], `${path}.${name}`, faults);
    }
  };
