import { useState } from 'react';
import type { JudgeTask } from '@challenge/contract';
import { Countdown } from '../../components/Countdown';
import { useToast } from '../../components/Toast';
import { UIView } from '../../components/UIRenderer';
import type { PlayCtx } from '../Play';

const NOTE_MAX = 140;

export function JudgeScreen({ ctx }: { ctx: PlayCtx }) {
  const tasks = ctx.snapshot.judging;
  const task = tasks[0];
  const ownInProgress = ctx.snapshot.board.some((b) => b.status === 'in_progress');

  if (!task) {
    return (
      <section className="stack gap-md center-text">
        <div className="big-emoji" aria-hidden="true">
          ⚖
        </div>
        <h1>Nothing to judge</h1>
        <p className="muted">All judging tasks are done. Thanks!</p>
        <button type="button" className="btn btn-primary" onClick={ctx.closeJudging}>
          Back
        </button>
      </section>
    );
  }

  return (
    <section className="stack gap-md judge">
      <div className="challenge-top">
        <button type="button" className="btn btn-ghost btn-sm" onClick={ctx.closeJudging} aria-label="Back">
          ← Back
        </button>
        <span className="challenge-top-title">
          Judging {tasks.length > 1 ? `· ${tasks.length} waiting` : ''}
        </span>
        <Countdown endsAt={task.deadlineAt} clockOffset={ctx.sock.clockOffset} paused={ctx.snapshot.game.paused} size="sm" label="Decide in" />
      </div>
      {ownInProgress && (
        <p className="muted small" role="note">
          Your own challenge timer keeps running while you judge.
        </p>
      )}
      <JudgeTaskCard key={task.assignmentId} ctx={ctx} task={task} remaining={tasks.length} />
    </section>
  );
}

function JudgeTaskCard({ ctx, task, remaining }: { ctx: PlayCtx; task: JudgeTask; remaining: number }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);

  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(decision);
    const res = await ctx.sock.judge(task.assignmentId, decision, note);
    setBusy(null);
    if (res.ok) {
      toast(decision === 'approve' ? 'Approved — thanks for judging!' : 'Rejected — thanks for judging!', 'success');
      if (remaining <= 1) ctx.closeJudging();
    } else {
      toast(res.reason ?? 'Your decision was not accepted', 'danger');
    }
  };

  return (
    <div className="stack gap-md">
      <div className="stack gap-xs">
        <p className="eyebrow">Judge this submission</p>
        <h1>{task.title}</h1>
      </div>
      <blockquote className="criteria">
        <span className="criteria-label">What to check</span>
        <p>“{task.criteria}”</p>
      </blockquote>
      <div className="card card-flat judge-presentation">
        <UIView key={`${task.assignmentId}-presentation`} node={task.presentation} />
      </div>
      <label className="field">
        <span className="field-label">
          Note <span className="muted">(optional)</span>
        </span>
        <input className="input" type="text" maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why? (the host can see this)" autoComplete="off" />
        <span className="field-help mono">
          {note.length}/{NOTE_MAX}
        </span>
      </label>
      <div className="judge-actions">
        <button type="button" className="btn btn-danger btn-lg" disabled={busy !== null} onClick={() => void decide('reject')} aria-busy={busy === 'reject' || undefined}>
          <span aria-hidden="true">✕</span> Reject
        </button>
        <button type="button" className="btn btn-success btn-lg" disabled={busy !== null} onClick={() => void decide('approve')} aria-busy={busy === 'approve' || undefined}>
          <span aria-hidden="true">✓</span> Approve
        </button>
      </div>
      <p className="muted small center-text">Judges stay anonymous — the player will not see who decided.</p>
    </div>
  );
}
