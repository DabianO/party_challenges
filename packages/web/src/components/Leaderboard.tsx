import type { LeaderboardEntry } from '@challenge/contract';
import { formatPoints } from '../lib/time';

export interface LeaderboardProps {
  entries: LeaderboardEntry[];
  /** Highlight this player's row. */
  meId?: string | null;
  showDelta?: boolean;
  showConnection?: boolean;
  /** Show how many challenges each player has completed. */
  showCompleted?: boolean;
  limit?: number;
  size?: 'md' | 'lg';
}

export function rankClass(rank: number): string {
  return rank >= 1 && rank <= 3 ? `rank-${rank}` : 'rank-n';
}

export function Leaderboard({ entries, meId, showDelta = true, showConnection = true, showCompleted = false, limit, size = 'md' }: LeaderboardProps) {
  const rows = limit ? entries.slice(0, limit) : entries;
  if (rows.length === 0) return <p className="muted">No players yet.</p>;
  return (
    <ol className={`leaderboard leaderboard-${size}`} aria-label="Leaderboard">
      {rows.map((e) => {
        const me = meId !== undefined && meId !== null && e.playerId === meId;
        return (
          <li key={e.playerId} className={`lb-row ${rankClass(e.rank)}${me ? ' is-me' : ''}`}>
            <span className="lb-rank" aria-label={`Rank ${e.rank}`}>
              {e.rank}
            </span>
            <span className="lb-name">
              {showConnection && <ConnectionDot connected={e.connected} />}
              <span className="lb-name-text">{e.displayName}</span>
              {me && <span className="tag">you</span>}
            </span>
            {showCompleted && (
              <span className="lb-completed muted" title={`${e.completed} challenges completed`} aria-label={`${e.completed} completed`}>
                <span aria-hidden="true">✓</span> {e.completed}
              </span>
            )}
            {showDelta && e.lastDelta !== 0 && (
              <span className={`delta ${e.lastDelta > 0 ? 'delta-up' : 'delta-down'}`}>
                {e.lastDelta > 0 ? '+' : '−'}
                {formatPoints(Math.abs(e.lastDelta))}
              </span>
            )}
            <span className="lb-total">
              {formatPoints(e.total)} <small>pts</small>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function ConnectionDot({ connected }: { connected: boolean }) {
  const title = connected ? 'Connected' : 'Disconnected';
  return (
    <span className={`dot ${connected ? 'dot-on' : 'dot-off'}`} title={title} role="img" aria-label={title}>
      <span className="sr-only">{title}</span>
    </span>
  );
}
