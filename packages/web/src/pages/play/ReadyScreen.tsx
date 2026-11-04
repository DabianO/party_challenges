import { useEffect } from 'react';
import { UIView } from '../../components/UIRenderer';
import type { PlayCtx } from '../Play';
import { useStartChallenge } from './BoardScreen';

/** "45 seconds", "2 minutes", "1 minute 30 seconds". */
export function formatSeconds(total: number): string {
  const s = Math.max(0, Math.round(total));
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (s < 60) return unit(s, 'second');
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${unit(m, 'minute')} ${unit(rest, 'second')}` : unit(m, 'minute');
}

/**
 * Before a timed challenge starts: how long the player will have, with the module's
 * instructions. Start begins the attempt (and the clock); Back returns to the board.
 */
export function ReadyScreen({ ctx, instanceId }: { ctx: PlayCtx; instanceId: string }) {
  const entry = ctx.snapshot.board.find((b) => b.instanceId === instanceId);
  const { starting, start } = useStartChallenge(ctx);
  const paused = ctx.snapshot.game.paused;
  const startable = entry !== undefined && (entry.status === 'available' || entry.canReplay) && entry.timeLimit !== null;
  const { closeChallenge, openChallenge } = ctx;
  const live = entry?.status === 'in_progress';

  // Started: on to the challenge. Nothing to start any more (closed meanwhile): back to the board.
  useEffect(() => {
    if (live) openChallenge(instanceId);
    else if (!startable && !starting) closeChallenge();
  }, [live, startable, starting, instanceId, openChallenge, closeChallenge]);

  if (!entry || !startable) return null;
  return (
    <section className="stack gap-md ready-screen">
      <div className="challenge-top">
        <button type="button" className="btn btn-ghost btn-sm" onClick={closeChallenge} aria-label="Back to challenges">
          ← Back
        </button>
        <span className="challenge-top-title">{entry.title}</span>
      </div>
      <div className="card ready-card stack gap-sm center-text">
        <p className="eyebrow">Timed challenge</p>
        <h1>{entry.title}</h1>
        <p className="ready-time">
          <span aria-hidden="true">⏱ </span>
          {formatSeconds(entry.timeLimit!)}
        </p>
        <p className="muted">The clock starts when you press Start, and keeps running if you leave the screen.</p>
      </div>
      {entry.intro && (
        <div className="card card-flat">
          <UIView key={`${entry.instanceId}-intro`} node={entry.intro} />
        </div>
      )}
      <button type="button" className="btn btn-primary btn-lg" disabled={starting !== null || paused} onClick={() => void start(entry.instanceId, true)}>
        {starting ? 'Starting…' : '▶ Start'}
      </button>
      <button type="button" className="btn btn-secondary" onClick={closeChallenge}>
        Not now: back to challenges
      </button>
    </section>
  );
}
