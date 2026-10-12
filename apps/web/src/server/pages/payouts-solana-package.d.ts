/**
 * What the payouts pages use of `@holdfast/solana`, as that package declares
 * it: three derivations of addresses, none of which reads the chain.
 */

/** The associated token account of a wallet for a mint under the Token program. */
export function associatedTokenAddress(owner: string, mint: string): Promise<string>;

/** The seed that stands for a run of a team wallet in a mint. */
export function runMarkerSeed(owner: string, mint: string, runId: string): Promise<string>;

/** The marker of a run under a given service key. */
export function runMarker(delegate: string, seed: string): Promise<{ address: string; seed: string }>;
