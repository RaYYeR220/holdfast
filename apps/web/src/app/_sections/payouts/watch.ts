/**
 * A signer as the client's flows take one, with one of its methods watched:
 * `onCall` runs when the flow reaches the signature, which is when the
 * wallet or the passkey prompt opens, and `onReturn` once it has signed. The
 * flow itself is the client's and runs unchanged; this only lets a page say
 * which of its steps it is waiting on.
 *
 * The copy keeps the other properties of the signer as they are. The signers
 * of the client keep their state in closures, not in `this`, so a copy signs
 * as the original does.
 */
export function watched<T extends object, K extends keyof T>(signer: T, method: K, onCall: () => void, onReturn: () => void): T {
  const original = signer[method];
  if (typeof original !== 'function') throw new TypeError(`${String(method)} is not something the signer can be asked to do`);
  const wrapped = async (...parameters: unknown[]): Promise<unknown> => {
    onCall();
    const result: unknown = await (original as (...parameters: unknown[]) => Promise<unknown>).apply(signer, parameters);
    onReturn();
    return result;
  };
  return { ...signer, [method]: wrapped };
}
