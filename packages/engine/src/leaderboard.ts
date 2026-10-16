import type { LeaderboardEntry, ScoreLedgerEntry, TieBreak } from '@challenge/contract';
import type { PersistedAttempt, PersistedInstance, PersistedPlayer, PersistedSubmission } from './persistence.ts';

export interface LeaderboardInput {
  players: PersistedPlayer[];
  ledger: ScoreLedgerEntry[];
  instances: PersistedInstance[];
  attempts: PersistedAttempt[];
  submissions: PersistedSubmission[];
  tieBreak: TieBreak;
  connected: (playerId: string) => boolean;
}

/**
 * FR-41/FR-42: rank players by total points with configurable tie-breaking.
 *  - shared:   equal totals share a rank (default)
 *  - wins:     more challenge wins ranks higher, then shared
 *  - earliest: earlier average submission time ranks higher, then shared
 */
export function computeLeaderboard(input: LeaderboardInput): LeaderboardEntry[] {
  const active = input.players.filter((p) => p.removedAt === null);
  const totals = new Map<string, number>();
  const last = new Map<string, { points: number; at: number }>();
  for (const p of active) totals.set(p.id, 0);
  for (const row of input.ledger) {
    if (!totals.has(row.playerId)) continue;
    totals.set(row.playerId, totals.get(row.playerId)! + row.points);
    if (row.source === 'module' && row.reason !== 'reset-reversal' && row.reason !== 'override-reversal') {
      const prev = last.get(row.playerId);
      if (!prev || row.createdAt >= prev.at) last.set(row.playerId, { points: row.points, at: row.createdAt });
    }
  }

  const wins = computeWins(input.ledger, input.instances, new Set(totals.keys()));
  const avgTimes = computeAverageSubmissionSeconds(input.attempts, input.submissions);
  const completed = new Map<string, number>();
  for (const a of input.attempts) if (a.status === 'scored') completed.set(a.playerId, (completed.get(a.playerId) ?? 0) + 1);

  const entries = active.map((p) => ({
    playerId: p.id,
    displayName: p.displayName,
    total: round(totals.get(p.id) ?? 0),
    lastDelta: round(last.get(p.id)?.points ?? 0),
    wins: wins.get(p.id) ?? 0,
    completed: completed.get(p.id) ?? 0,
    avg: avgTimes.get(p.id) ?? Number.POSITIVE_INFINITY,
    connected: input.connected(p.id),
  }));

  const cmp = (a: (typeof entries)[number], b: (typeof entries)[number]): number => {
    if (b.total !== a.total) return b.total - a.total;
    if (input.tieBreak === 'wins' && b.wins !== a.wins) return b.wins - a.wins;
    if (input.tieBreak === 'earliest' && a.avg !== b.avg) return a.avg - b.avg;
    return 0;
  };
  entries.sort((a, b) => cmp(a, b) || a.displayName.localeCompare(b.displayName));

  const out: LeaderboardEntry[] = [];
  let rank = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const prev = entries[i - 1];
    if (!prev || cmp(prev, e) !== 0) rank = i + 1;
    out.push({
      rank,
      playerId: e.playerId,
      displayName: e.displayName,
      total: e.total,
      lastDelta: e.lastDelta,
      wins: e.wins,
      completed: e.completed,
      connected: e.connected,
    });
  }
  return out;
}

/** A "win" = highest positive module score in a challenge instance (ties all win). */
export function computeWins(
  ledger: ScoreLedgerEntry[],
  instances: PersistedInstance[],
  playerIds: Set<string>,
): Map<string, number> {
  const wins = new Map<string, number>();
  for (const inst of instances) {
    const perPlayer = new Map<string, number>();
    for (const row of ledger) {
      if (row.challengeInstanceId !== inst.id || row.source !== 'module' || !playerIds.has(row.playerId)) continue;
      perPlayer.set(row.playerId, (perPlayer.get(row.playerId) ?? 0) + row.points);
    }
    let best = 0;
    for (const v of perPlayer.values()) best = Math.max(best, v);
    if (best <= 0) continue;
    for (const [pid, v] of perPlayer) if (v === best) wins.set(pid, (wins.get(pid) ?? 0) + 1);
  }
  return wins;
}

function computeAverageSubmissionSeconds(attempts: PersistedAttempt[], submissions: PersistedSubmission[]): Map<string, number> {
  const startedAt = new Map(attempts.map((a) => [`${a.challengeInstanceId}:${a.playerId}`, a.startedAt] as const));
  const sums = new Map<string, { total: number; n: number }>();
  for (const s of submissions) {
    if (s.supersededBy) continue;
    const start = startedAt.get(`${s.challengeInstanceId}:${s.playerId}`);
    if (start == null) continue;
    const cur = sums.get(s.playerId) ?? { total: 0, n: 0 };
    cur.total += Math.max(0, (s.submittedAt - start) / 1000);
    cur.n += 1;
    sums.set(s.playerId, cur);
  }
  const out = new Map<string, number>();
  for (const [pid, { total, n }] of sums) out.set(pid, total / n);
  return out;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
