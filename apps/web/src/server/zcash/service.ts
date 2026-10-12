import type { Deps } from '../deps';
import { unavailable } from '../errors';
import { messageOf } from '../redact';

const CHAIN = 'Zcash';

export interface ChainTip {
  /** The height of the newest block the deployment's Zcash endpoints have. */
  height: number;
  /** When it was read, ms. */
  readAt: number;
}

/**
 * The height of the Zcash chain, read now from the endpoints the deployment
 * scans with, or "unavailable". No earlier height stands in for one that
 * could not be read: a birthday or a scan range worked out from a height that
 * is not the chain's would be wrong without looking wrong.
 */
export async function chainTip(deps: Pick<Deps, 'zcash' | 'now' | 'redact'>): Promise<ChainTip> {
  let height: number;
  try {
    height = await deps.zcash.scanner().tip();
  } catch (error) {
    throw unavailable(CHAIN, deps.redact(messageOf(error)));
  }
  if (!Number.isSafeInteger(height) || height <= 0) throw unavailable(CHAIN, 'the endpoints answered with something that is not a block height');
  return { height, readAt: deps.now() };
}
