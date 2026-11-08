import { useCallback, useEffect, useRef, useState } from 'react';
import type { AttemptStatus, BoardEntry } from '@challenge/contract';
import { Countdown } from '../../components/Countdown';
import { useToast } from '../../components/Toast';
import { UIView } from '../../components/UIRenderer';
import { formatPoints } from '../../lib/time';
import type { PlayCtx } from '../Play';
import { lockTimer, useStartChallenge } from './BoardScreen';

/**
 * A challenge opened from the board. Tapping a tile starts the attempt, so this is either
 * the live attempt or (once the host has revealed results) the player's result. As soon as
 * an attempt locks — answer sent or time up — the player goes straight back to the board,
 * except in a repeat challenge they may start again right away (e.g. the next secret word):
 * then the screen offers to continue.
 */
export function ChallengeScreen({ ctx, instanceId }: { ctx: PlayCtx; instanceId: string }) {
  const toast = useToast();
  const entry = ctx.snapshot.board.find((b) => b.instanceId === instanceId);
  const status = entry?.status;
  const previous = useRef<AttemptStatus | undefined>(status);
  const revealed = ctx.snapshot.game.resultsRevealed;
  const showOutcome = entry !== undefined && status !== 'in_progress' && revealed && (entry.result !== null || entry.points !== null);
  const { closeChallenge } = ctx;
  const note = entry?.note ?? null;
  // The module flagged a problem with the answer (e.g. above the maximum): no "Locked in ✓".
  const warning = entry?.noteTone === 'danger' || entry?.noteTone === 'warning' ? entry.noteTone : null;
  const again = entry?.repeat === true && status === 'available';
  const [offerNext, setOfferNext] = useState(false);

  useEffect(() => {
    const was = previous.current;
    previous.current = status;
    if (status === 'in_progress') setOfferNext(false);
    if (was === 'in_progress' && status !== 'in_progress') {
      // The module's personal feedback (e.g. reaction time) rides along with the lock-in message.
      if (status === 'missed') toast(note ? `Time's up! ${note}` : "Time's up!", 'warning');
      else if (warning && note) toast(note, warning);
      else if (status !== undefined) toast(note ? `Locked in ✓ ${note}` : 'Answer locked in ✓', 'success');
      // A refused answer stays on screen (with its warning) until the player leaves.
      if (again || warning) setOfferNext(true);
      else closeChallenge();
      return;
    }
    // Nothing to show here outside a live attempt, a revealed result or the offer to go on: back to the board.
    if (status !== 'in_progress' && !showOutcome && !(offerNext && (again || warning))) closeChallenge();
  }, [status, showOutcome, closeChallenge, toast, note, warning, again, offerNext]);

  if (!entry) return null;
  if (status === 'in_progress') return <Live ctx={ctx} entry={entry} />;
  if (offerNext && (again || warning)) return <Next ctx={ctx} entry={entry} canContinue={again} />;
  if (showOutcome) return <Outcome ctx={ctx} entry={entry} />;
  return null;
}

/**
 * A repeat challenge just took the player's answer and they may go again straight away, or
 * the module refused the answer (a warning note), whether or not they may go again.
 */
function Next({ ctx, entry, canContinue }: { ctx: PlayCtx; entry: BoardEntry; canContinue: boolean }) {
  const { starting, start } = useStartChallenge(ctx);
  const paused = ctx.snapshot.game.paused;
  const problem = entry.noteTone === 'danger' || entry.noteTone === 'warning';
  return (
    <section className="stack gap-md">
      <BackBar ctx={ctx} title={entry.title} />
      {problem && entry.note ? (
        <div className={`card next-warning tone-${entry.noteTone}`} role="alert">
          {/* danger: the answer was refused; warning: it counted, but went wrong (e.g. a false start). */}
          <p className="eyebrow">{entry.noteTone === 'danger' ? 'Not accepted' : 'Oops'}</p>
          <h2>{entry.note}</h2>
        </div>
      ) : (
        <div className="stack gap-xs center-text">
          <p className="eyebrow">Answer saved</p>
          {entry.note && <h2>{entry.note}</h2>}
        </div>
      )}
      {canContinue && (
        <button type="button" className="btn btn-primary btn-lg" disabled={starting !== null || paused} onClick={() => void start(entry.instanceId)}>
          {starting ? 'Starting…' : `▶ ${entry.statusText ?? 'Continue'}`}
        </button>
      )}
      <button type="button" className={`btn ${canContinue ? 'btn-secondary' : 'btn-primary btn-lg'}`} onClick={ctx.closeChallenge}>
        Back to challenges
      </button>
      {canContinue && <p className="muted small center-text">You can also come back to this later from the board.</p>}
    </section>
  );
}

function BackBar({ ctx, title, children, onBack }: { ctx: PlayCtx; title: string; children?: React.ReactNode; onBack?: () => void }) {
  return (
    <div className="challenge-top">
      <button type="button" className="btn btn-ghost btn-sm" onClick={onBack ?? ctx.closeChallenge} aria-label="Back to challenges">
        ← Back
      </button>
      <span className="challenge-top-title">{title}</span>
      {children}
    </div>
  );
}

function Live({ ctx, entry }: { ctx: PlayCtx; entry: BoardEntry }) {
  const toast = useToast();
  const paused = ctx.snapshot.game.paused;
  const timer = lockTimer(entry, ctx.meId);

  // Usually one action: the answer is locked in with the submission itself (the screen then
  // closes). A "Save" button (`final: false`) keeps the challenge open to come back to.
  const onSubmit = async (payload: Record<string, unknown>, opts: { final: boolean }) => {
    const res = await ctx.sock.submit(entry.instanceId, payload, opts.final);
    if (!res.ok) toast(res.reason ?? 'Not accepted', 'danger');
    else if (!opts.final) toast('Saved ✓ Come back any time to add more', 'success');
  };

  // Live actions (e.g. pumping): fire and forget; the next snapshot shows the effect.
  const onAction = useCallback((payload: Record<string, unknown>) => void ctx.sock.action(entry.instanceId, payload), [ctx.sock, entry.instanceId]);

  // The module locks the answer in when the player leaves (e.g. every pair linked).
  const [leaving, setLeaving] = useState(false);
  const leave = async () => {
    if (!entry.lockOnLeave || paused) return ctx.closeChallenge();
    setLeaving(true);
    const res = await ctx.sock.submit(entry.instanceId, {}, true);
    setLeaving(false);
    if (!res.ok) toast(res.reason ?? 'Not accepted', 'danger');
    ctx.closeChallenge();
  };

  return (
    <section className="stack gap-md">
      <BackBar ctx={ctx} title={entry.title} onBack={leaving ? () => undefined : () => void leave()}>
        {timer && <Countdown endsAt={timer.endsAt} startedAt={timer.startedAt} clockOffset={ctx.sock.clockOffset} paused={paused} size="sm" label="Time left" />}
      </BackBar>
      <UIView
        key={`${entry.instanceId}-${entry.attempts}`}
        node={entry.view}
        onSubmit={onSubmit}
        disabled={!entry.canSubmit || paused}
        timers={entry.timers}
        clockOffset={ctx.sock.clockOffset}
        paused={paused}
        uploadEvidence={ctx.uploadEvidence}
        onAction={onAction}
        draftKey={`${ctx.snapshot.game.id}:${ctx.meId}:${entry.instanceId}:${entry.attempts}`}
      />
      {entry.statusText && (
        <p className="status-line" role="status">
          {entry.statusText}
        </p>
      )}
    </section>
  );
}

/** Only reachable after the host revealed results. */
function Outcome({ ctx, entry }: { ctx: PlayCtx; entry: BoardEntry }) {
  const { starting, start } = useStartChallenge(ctx);
  const paused = ctx.snapshot.game.paused;
  return (
    <section className="stack gap-md">
      <BackBar ctx={ctx} title={entry.title} />
      <div className="stack gap-xs center-text">
        <p className="eyebrow">{entry.status === 'missed' ? 'Time ran out' : 'Your result'}</p>
        <h1>{entry.title}</h1>
        {entry.points !== null && (
          <p>
            <span className={`points-badge points-badge-lg ${entry.points > 0 ? 'is-positive' : ''}`}>
              {entry.points > 0 ? '+' : ''}
              {formatPoints(entry.points)} pts
            </span>
          </p>
        )}
        {entry.attempts > 1 && <p className="muted small">Best of your {entry.attempts} attempts counts.</p>}
      </div>
      {entry.result && (
        <div className="card card-flat">
          <UIView key={`${entry.instanceId}-result`} node={entry.result} />
        </div>
      )}
      {entry.canReplay && (
        <button type="button" className="btn btn-primary btn-lg" disabled={starting !== null || paused} onClick={() => void start(entry.instanceId)}>
          {starting ? 'Starting…' : '↻ Play again'}
        </button>
      )}
      <button type="button" className="btn btn-secondary" onClick={ctx.closeChallenge}>
        Back to challenges
      </button>
    </section>
  );
}
