import { formatSeconds, useNow } from '../lib/time';

export interface CountdownProps {
  /** Server epoch ms. */
  endsAt: number;
  startedAt?: number;
  clockOffset: number;
  paused?: boolean;
  size?: 'sm' | 'lg';
  label?: string;
}

/** Counts down to a server timestamp using the estimated clock offset (FR-22). */
export function Countdown({ endsAt, startedAt, clockOffset, paused = false, size = 'sm', label }: CountdownProps) {
  const now = useNow(paused ? 1000 : 200);
  const remainingMs = endsAt - (now + clockOffset);
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const total = startedAt !== undefined ? endsAt - startedAt : undefined;
  const ratio = total && total > 0 ? Math.min(1, Math.max(0, remainingMs / total)) : undefined;
  const urgent = !paused && seconds > 0 && seconds <= 5;
  const text = paused ? 'Paused' : formatSeconds(seconds);

  return (
    <div
      className={`countdown countdown-${size}${urgent ? ' is-urgent' : ''}${paused ? ' is-paused' : ''}`}
      role="timer"
      aria-live="off"
      aria-label={label ? `${label}: ${paused ? 'paused' : `${seconds} seconds left`}` : paused ? 'Timer paused' : `${seconds} seconds left`}
    >
      {label && <span className="countdown-label">{label}</span>}
      <span className="countdown-value">{text}</span>
      {ratio !== undefined && (
        <span className="countdown-bar" aria-hidden="true">
          <span className="countdown-bar-fill" style={{ width: `${ratio * 100}%` }} />
        </span>
      )}
    </div>
  );
}
