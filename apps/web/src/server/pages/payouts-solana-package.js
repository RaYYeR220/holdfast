// The address derivations of the Solana package that the payouts pages show,
// re-exported through plain JavaScript with their types written out beside
// them in payouts-solana-package.d.ts, the way adapters/solana-package.js
// re-exports the rail: the application is compiled against the declaration
// and bundles the package itself.
export { associatedTokenAddress, runMarker, runMarkerSeed } from '@holdfast/solana';
