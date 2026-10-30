import type { SpotlightState } from './persistence.ts';

/** How long one item stays in the big screen's spotlight. */
export const SPOTLIGHT_SECONDS = 60;
/** How often an empty spotlight looks again for something to show. */
export const SPOTLIGHT_IDLE_SECONDS = 5;

/** An item that could be shown: `key` is `<instanceId>/<itemId>`. */
export interface SpotlightCandidate {
  key: string;
  activity: number;
}

export const emptySpotlight = (): SpotlightState => ({ current: null, seen: {}, round: [] });

/**
 * Which item the spotlight shows next (null when there is nothing to show):
 *  - every item is shown once per round before any item is shown again;
 *  - within the round, the item with the most new or changed answers since it was last shown
 *    goes first (`activity` minus the activity it had then);
 *  - when no item has new answers, a random one.
 * The item on screen now is only picked again when it is the only one there is.
 * Returns the next item and the round including it.
 */
export function pickSpotlight(
  candidates: SpotlightCandidate[],
  state: SpotlightState,
  current: string | null,
  random: () => number,
): { key: string; round: string[] } | null {
  if (candidates.length === 0) return null;
  const keys = new Set(candidates.map((c) => c.key));
  let round = state.round.filter((k) => keys.has(k));
  let pool = candidates.filter((c) => !round.includes(c.key) && c.key !== current);
  if (pool.length === 0) {
    // Everything has had its turn: a new round.
    round = [];
    pool = candidates.filter((c) => c.key !== current);
    if (pool.length === 0) pool = candidates;
  }
  const fresh = (c: SpotlightCandidate) => c.activity - (state.seen[c.key] ?? 0);
  const best = Math.max(...pool.map(fresh));
  const top = best > 0 ? pool.filter((c) => fresh(c) === best) : pool;
  const pick = top[Math.min(top.length - 1, Math.floor(random() * top.length))]!;
  return { key: pick.key, round: [...round, pick.key] };
}
