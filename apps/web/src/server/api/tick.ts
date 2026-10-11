import { scheduledEndpoint } from '../http/endpoint';
import { runTick } from '../tick/service';

/**
 * POST /api/tick, with `Authorization: Bearer <TICK_SECRET>`.
 * Ticks every organisation and refreshes the swaps that have not settled.
 */
export const postTick = scheduledEndpoint(({ deps }) => runTick(deps));
