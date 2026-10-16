import type { ActivityItem } from '@challenge/contract';
import { formatPoints, relativeTime, useNow } from '../lib/time';

const ICONS: Record<ActivityItem['kind'], { icon: string; label: string }> = {
  joined: { icon: '👋', label: 'Joined' },
  started: { icon: '▶', label: 'Started' },
  submitted: { icon: '📨', label: 'Submitted' },
  scored: { icon: '🏅', label: 'Scored' },
  unlocked: { icon: '🔓', label: 'Unlocked' },
  closed: { icon: '■', label: 'Closed' },
  results: { icon: '★', label: 'Results' },
};

export interface ActivityFeedProps {
  items: ActivityItem[];
  clockOffset?: number;
  limit?: number;
  size?: 'md' | 'lg';
  emptyText?: string;
}

/** Live activity list (newest first), shared by the main display and the host panel. */
export function ActivityFeed({ items, clockOffset = 0, limit = 30, size = 'md', emptyText = 'Nothing has happened yet.' }: ActivityFeedProps) {
  const now = useNow(5000) + clockOffset;
  const rows = items.slice(0, limit);
  if (rows.length === 0) return <p className="muted">{emptyText}</p>;
  return (
    <ol className={`activity activity-${size}`} aria-label="Activity" aria-live="polite" aria-relevant="additions">
      {rows.map((a) => {
        const meta = ICONS[a.kind] ?? { icon: '•', label: a.kind };
        return (
          <li key={a.id} className={`activity-row kind-${a.kind}`}>
            <span className="activity-icon" role="img" aria-label={meta.label}>
              {meta.icon}
            </span>
            <span className="activity-text">
              {a.text}
              {a.points !== undefined && a.points !== 0 && (
                <span className={`delta ${a.points > 0 ? 'delta-up' : 'delta-down'}`}>
                  {a.points > 0 ? '+' : '−'}
                  {formatPoints(Math.abs(a.points))}
                </span>
              )}
            </span>
            <time className="activity-time" dateTime={new Date(a.at).toISOString()}>
              {relativeTime(a.at, now)}
            </time>
          </li>
        );
      })}
    </ol>
  );
}
