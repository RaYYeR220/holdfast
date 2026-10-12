import { sessionEndpoint } from '../http/endpoint';
import { chainTip } from '../zcash/service';

/** GET /api/zcash/tip: the height of the Zcash chain, read now. For whoever is signed in; it is about no organisation. */
export const getZcashTip = sessionEndpoint({}, async ({ deps }) => chainTip(deps));
