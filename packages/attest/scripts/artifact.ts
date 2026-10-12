import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Where `forge build` leaves the compiled contract. The directory is not kept in the repository. */
export const ARTIFACT_PATH = fileURLToPath(
  new URL('../../../contracts/out/HedgeAttestor.sol/HedgeAttestor.json', import.meta.url),
);

function withoutInternalTypes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutInternalTypes);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'internalType')
      .map(([key, inner]) => [key, withoutInternalTypes(inner)]),
  );
}

/**
 * The ABI of the compiled contract, without the compiler's `internalType`
 * notes, which say nothing about encoding. Null when the contract has not
 * been built.
 */
export function readArtifactAbi(): unknown[] | null {
  if (!existsSync(ARTIFACT_PATH)) return null;
  const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')) as { abi?: unknown };
  if (!Array.isArray(artifact.abi)) throw new Error(`${ARTIFACT_PATH} has no ABI`);
  return artifact.abi.map(withoutInternalTypes);
}
