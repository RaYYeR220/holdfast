import { orchardAddressFromUfvk } from '@ledgerhq/zcash-utils';
import type { ZcashNetwork } from './scanner';

export type UfvkCheck =
  | { ok: true; network: ZcashNetwork; /** Unified address this key receives on. */ address: string }
  | { ok: false; error: string };

const HRP: Record<ZcashNetwork, string> = { mainnet: 'uview1', testnet: 'uviewtest1' };

/**
 * A unified full viewing key lets its holder see every payment in and out of
 * an account and nothing more: it cannot authorise a spend. This is the only
 * Zcash key Holdfast ever asks for.
 */
export function checkUfvk(ufvk: string, network: ZcashNetwork): UfvkCheck {
  const key = ufvk.trim();
  if (/^(secret-extended-key|uskprivate|zxviews?secret)/i.test(key) || /\s/.test(key)) {
    return { ok: false, error: 'this looks like a spending key or a seed phrase — never paste those here' };
  }
  if (!key.startsWith(HRP[network])) {
    const other = network === 'mainnet' ? 'testnet' : 'mainnet';
    return {
      ok: false,
      error: key.startsWith(HRP[other]) ? `this is a ${other} viewing key` : `a ${network} viewing key starts with ${HRP[network]}`,
    };
  }
  if (!/^[02-9ac-hj-np-z]+$/.test(key.slice(HRP[network].length))) {
    return { ok: false, error: 'the key contains characters that cannot appear in a viewing key' };
  }
  try {
    return { ok: true, network, address: orchardAddressFromUfvk(key) };
  } catch (e) {
    return { ok: false, error: `the key does not decode: ${e instanceof Error ? e.message : String(e)}` };
  }
}
