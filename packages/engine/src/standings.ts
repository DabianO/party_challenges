import type { PublishedStanding, StandingsFeedItem } from '@challenge/contract';
import { newId } from './ids.ts';

/** How many feed items a game keeps. */
export const STANDINGS_FEED_LIMIT = 30;

function names(list: string[]): string {
  if (list.length <= 2) return list.join(' and ');
  if (list.length === 3) return `${list[0]}, ${list[1]} and ${list[2]}`;
  return `${list[0]}, ${list[1]} and ${list.length - 2} others`;
}

/**
 * What changed between two published rankings, for the big screen's feed:
 *  - `lead`:     someone is now #1 who was not before ("Bea takes the lead from Cyd")
 *  - `overtake`: someone moved up past players who were ahead of them ("Dex moves up to #3, passing Eve")
 *  - `enter`:    a player published for the first time with points ("Gus joins the race at #4")
 * Drawing level counts too. Rank changes caused only by others dropping out produce nothing. Without a previous
 * ranking, the first publication announces the leader. Items come best rank first.
 */
export function diffStandings(prev: PublishedStanding[] | null, next: PublishedStanding[], at: number): StandingsFeedItem[] {
  const item = (kind: StandingsFeedItem['kind'], e: PublishedStanding, text: string, previousRank: number | null, passed: string[]): StandingsFeedItem => ({
    id: newId('sf'),
    at,
    kind,
    text,
    playerId: e.playerId,
    rank: e.rank,
    previousRank,
    passed,
  });
  if (!prev) {
    const leaders = next.filter((e) => e.rank === 1 && e.total > 0);
    if (leaders.length === 0) return [];
    const text = leaders.length === 1 ? `${leaders[0]!.displayName} leads the race` : `${names(leaders.map((l) => l.displayName))} share the lead`;
    return [item('lead', leaders[0]!, text, null, [])];
  }

  const before = new Map(prev.map((e) => [e.playerId, e] as const));
  const after = new Map(next.map((e) => [e.playerId, e] as const));
  const prevLeaders = prev.filter((e) => e.rank === 1 && after.has(e.playerId));
  const out: StandingsFeedItem[] = [];
  for (const e of [...next].sort((a, b) => a.rank - b.rank)) {
    const was = before.get(e.playerId);
    if (!was) {
      if (e.total > 0) out.push(item('enter', e, `${e.displayName} joins the race at #${e.rank}`, null, []));
      continue;
    }
    if (e.rank >= was.rank) continue;
    // Who was ahead of them and is now behind them?
    const passed = prev
      .filter((p) => p.playerId !== e.playerId && p.rank < was.rank && (after.get(p.playerId)?.rank ?? 0) > e.rank)
      .sort((a, b) => a.rank - b.rank)
      .map((p) => p.displayName);
    const tookLead = e.rank === 1 && !prevLeaders.some((l) => l.playerId === e.playerId);
    const level = next.filter((x) => x.rank === e.rank && x.playerId !== e.playerId).map((x) => x.displayName);
    // Moving up without passing anyone is only news when it means drawing level with someone.
    if (passed.length === 0 && level.length === 0) continue;
    const text =
      passed.length === 0
        ? tookLead
          ? `${e.displayName} draws level for the lead with ${names(level)}`
          : `${e.displayName} draws level with ${names(level)} at #${e.rank}`
        : tookLead
          ? `${e.displayName} takes the lead from ${names(passed)}`
          : `${e.displayName} moves up to #${e.rank}${level.length ? ' (shared)' : ''}, passing ${names(passed)}`;
    out.push(item(tookLead ? 'lead' : 'overtake', e, text, was.rank, passed));
  }
  return out;
}
