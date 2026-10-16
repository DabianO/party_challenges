import type { AttemptStatus, BoardEntry } from '@challenge/contract';
import { Countdown } from '../../components/Countdown';
import { EvaluationBadge } from '../../components/PhaseBadge';
import { formatDuration, formatPoints } from '../../lib/time';
import type { PlayCtx } from '../Play';

const ORDER: Record<AttemptStatus, number> = {
  in_progress: 0,
  available: 1,
  submitted: 2,
  scored: 3,
  closed: 4,
  missed: 5,
  locked: 6,
};

export function sortBoard(board: BoardEntry[]): BoardEntry[] {
  return [...board].sort((a, b) => ORDER[a.status] - ORDER[b.status]);
}

/** The player's own `lock` timer for an attempt, if any. */
export function lockTimer(entry: BoardEntry, meId: string) {
  return entry.timers.find((t) => t.tag === 'lock' && t.playerId === meId);
}

export function BoardScreen({ ctx }: { ctx: PlayCtx }) {
  const { board, game } = ctx.snapshot;
  const sorted = sortBoard(board);
  const done = board.filter((b) => b.status === 'scored' || b.status === 'missed' || b.status === 'closed').length;
  const playable = board.filter((b) => b.status === 'available' || b.status === 'in_progress').length;

  return (
    <section className="stack gap-md">
      <div className="stack gap-xs">
        <p className="eyebrow">Challenge board</p>
        <h1>Pick a challenge</h1>
        <p className="muted small">
          {playable > 0 ? `${playable} ready to play · ` : ''}
          {done} of {board.length} done
        </p>
      </div>
      {sorted.length === 0 && <p className="muted">No challenges are available to you yet. Keep an eye on this screen.</p>}
      <ul className="plain-list board">
        {sorted.map((entry) => (
          <BoardCard key={entry.instanceId} entry={entry} ctx={ctx} paused={game.paused} />
        ))}
      </ul>
    </section>
  );
}

const STATUS_CHIP: Record<AttemptStatus, { label: string; tone: string; icon: string }> = {
  available: { label: 'Ready', tone: 'tone-success', icon: '▶' },
  in_progress: { label: 'In progress', tone: 'tone-primary', icon: '⏱' },
  submitted: { label: 'Waiting for results', tone: 'tone-warning', icon: '⏳' },
  scored: { label: 'Scored', tone: 'tone-success', icon: '✓' },
  missed: { label: 'Time ran out', tone: 'tone-danger', icon: '✕' },
  locked: { label: 'Not unlocked yet', tone: 'tone-muted', icon: '🔒' },
  closed: { label: 'Closed', tone: 'tone-muted', icon: '■' },
};

function BoardCard({ entry, ctx, paused }: { entry: BoardEntry; ctx: PlayCtx; paused: boolean }) {
  const chip = STATUS_CHIP[entry.status];
  const timer = entry.status === 'in_progress' ? lockTimer(entry, ctx.meId) : undefined;
  const open = () => ctx.openChallenge(entry.instanceId);
  const tappable = entry.status !== 'locked' && !(entry.status === 'closed' && !entry.result) && !(entry.status === 'missed' && !entry.result);

  let action: JSX.Element | null;
  switch (entry.status) {
    case 'available':
      action = (
        <button type="button" className="btn btn-primary" onClick={open}>
          ▶ Play
        </button>
      );
      break;
    case 'in_progress':
      action = (
        <button type="button" className="btn btn-primary" onClick={open}>
          Continue →
        </button>
      );
      break;
    case 'submitted':
      action = (
        <button type="button" className="btn btn-secondary" onClick={open}>
          View
        </button>
      );
      break;
    case 'scored':
      action = (
        <button type="button" className="btn btn-secondary" onClick={open} aria-label={`See your result for ${entry.moduleName}`}>
          <span className="points-badge">
            {entry.points !== null && entry.points > 0 ? '+' : ''}
            {formatPoints(entry.points ?? 0)} pts
          </span>
        </button>
      );
      break;
    case 'closed':
    case 'missed':
      action = entry.result ? (
        <button type="button" className="btn btn-secondary" onClick={open}>
          Results
        </button>
      ) : null;
      break;
    case 'locked':
      action = null;
      break;
  }

  return (
    <li className={`board-card status-${entry.status}`}>
      <div className="board-card-head">
        <span className={`badge ${chip.tone}`}>
          <span aria-hidden="true">{chip.icon}</span> {chip.label}
        </span>
        <span className="badge tone-muted">{entry.moduleCategory}</span>
      </div>
      <h2 className="board-card-title">{entry.status === 'locked' ? entry.moduleName : entry.moduleName}</h2>
      <p className="board-card-desc">{entry.description}</p>
      <div className="board-card-meta">
        <span className="muted small">~{formatDuration(entry.typicalSeconds)}</span>
        <EvaluationBadge mode={entry.evaluationMode} />
      </div>
      {timer && (
        <div className="board-card-timer">
          <Countdown endsAt={timer.endsAt} startedAt={timer.startedAt} clockOffset={ctx.sock.clockOffset} paused={paused} label="Time left" />
        </div>
      )}
      {entry.status === 'submitted' && entry.statusText && (
        <p className="muted small" role="status">
          {entry.statusText}
        </p>
      )}
      {action && <div className="board-card-action">{action}</div>}
      {!tappable && entry.status === 'locked' && <p className="muted small">The host will unlock this one later.</p>}
    </li>
  );
}
