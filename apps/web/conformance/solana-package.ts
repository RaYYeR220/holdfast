/**
 * Holds the declaration the application is compiled against up to the Solana
 * package itself. It is not part of the application's own type check, which
 * must not depend on that package's sources; run it with
 *
 *   pnpm --filter @holdfast/web typecheck:solana
 *
 * It fails when the package no longer offers what the declaration promises.
 */
import type * as actual from '@holdfast/solana';
import type * as declared from '../src/server/adapters/solana-package.js';

type Declared = typeof declared;
type Offered = Pick<typeof actual, keyof Declared>;

/** Each function of the package must be usable wherever the declared one is. */
type Conforms = Offered extends Declared ? true : { missing: Exclude<keyof Declared, keyof typeof actual> };

export const conforms: Conforms = true;
