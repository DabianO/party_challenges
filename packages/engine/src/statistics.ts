import type { GenericStatistics, ScoreAward } from '@challenge/contract';
import type { PersistedAttempt, PersistedSubmission } from './persistence.ts';

/**
 * FR-45: generic per-challenge statistics computed by the engine without module
 * involvement: participation rate, submission times, points distribution.
 */
export function computeGenericStatistics(input: {
  participantIds: string[];
  attempts: PersistedAttempt[];
  submissions: PersistedSubmission[];
  scores: ScoreAward[];
}): GenericStatistics {
  const latest = input.submissions.filter((s) => !s.supersededBy);
  const submitters = new Set(latest.map((s) => s.playerId));
  const participants = input.participantIds.length;
  const startedAt = new Map(input.attempts.map((a) => [a.playerId, a.startedAt] as const));

  const times = latest
    .map((s) => {
      const start = startedAt.get(s.playerId);
      return start == null ? null : Math.max(0, (s.submittedAt - start) / 1000);
    })
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b);

  const pointsCount = new Map<number, number>();
  for (const award of input.scores) pointsCount.set(award.points, (pointsCount.get(award.points) ?? 0) + 1);
  const pointsDistribution = [...pointsCount.entries()]
    .map(([points, count]) => ({ points, count }))
    .sort((a, b) => b.points - a.points);

  return {
    participants,
    submissions: latest.length,
    participationRate: participants === 0 ? 0 : round(submitters.size / participants),
    submissionTime: {
      min: times.length ? round(times[0]!) : null,
      max: times.length ? round(times[times.length - 1]!) : null,
      average: times.length ? round(times.reduce((a, b) => a + b, 0) / times.length) : null,
      median: times.length ? round(median(times)) : null,
    },
    pointsDistribution,
  };
}

export function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
