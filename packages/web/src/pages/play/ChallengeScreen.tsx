import { useState } from 'react';
import type { BoardEntry } from '@challenge/contract';
import { Countdown } from '../../components/Countdown';
import { EvaluationBadge, evaluationHelp } from '../../components/PhaseBadge';
import { useToast } from '../../components/Toast';
import { UIView } from '../../components/UIRenderer';
import { formatDuration, formatPoints } from '../../lib/time';
import type { PlayCtx } from '../Play';
import { lockTimer } from './BoardScreen';

export function ChallengeScreen({ ctx, instanceId }: { ctx: PlayCtx; instanceId: string }) {
  const entry = ctx.snapshot.board.find((b) => b.instanceId === instanceId);

  if (!entry) {
    // The host reset or removed the challenge, or it is not visible to this player any more.
    return (
      <section className="stack gap-md center-text">
        <BackBar ctx={ctx} title="Challenge" />
        <h1>This challenge is no longer available</h1>
        <p className="muted">The host may have reset or removed it.</p>
        <button type="button" className="btn btn-primary" onClick={ctx.closeChallenge}>
          Back to board
        </button>
      </section>
    );
  }

  switch (entry.status) {
    case 'available':
      return <Intro ctx={ctx} entry={entry} />;
    case 'in_progress':
      return <Live ctx={ctx} entry={entry} />;
    case 'submitted':
      return <Waiting ctx={ctx} entry={entry} />;
    case 'scored':
    case 'missed':
    case 'closed':
      return <Outcome ctx={ctx} entry={entry} />;
    case 'locked':
      return (
        <section className="stack gap-md center-text">
          <BackBar ctx={ctx} title={entry.moduleName} />
          <div className="big-emoji" aria-hidden="true">
            🔒
          </div>
          <h1>Not unlocked yet</h1>
          <p className="muted">The host will unlock this challenge later.</p>
          <button type="button" className="btn btn-secondary" onClick={ctx.closeChallenge}>
            Back to board
          </button>
        </section>
      );
  }
}

function BackBar({ ctx, title, children }: { ctx: PlayCtx; title: string; children?: React.ReactNode }) {
  return (
    <div className="challenge-top">
      <button type="button" className="btn btn-ghost btn-sm" onClick={ctx.closeChallenge} aria-label="Back to board">
        ← Board
      </button>
      <span className="challenge-top-title">{title}</span>
      {children}
    </div>
  );
}

function Intro({ ctx, entry }: { ctx: PlayCtx; entry: BoardEntry }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const paused = ctx.snapshot.game.paused;

  const start = async () => {
    setBusy(true);
    const res = await ctx.sock.start(entry.instanceId);
    setBusy(false);
    if (!res.ok) toast(res.reason ?? 'Could not start', 'danger');
  };

  return (
    <section className="stack gap-md">
      <BackBar ctx={ctx} title={entry.moduleName} />
      <div className="stack gap-xs">
        <span className="row gap-sm wrap">
          <span className="badge tone-muted">{entry.moduleCategory}</span>
          <EvaluationBadge mode={entry.evaluationMode} />
        </span>
        <h1>{entry.moduleName}</h1>
        <p className="muted">{entry.description}</p>
      </div>
      {entry.intro && (
        <div className="card card-flat">
          <UIView key={`${entry.instanceId}-intro`} node={entry.intro} />
        </div>
      )}
      <dl className="stats-grid intro-facts">
        <div>
          <dt>Time</dt>
          <dd>~{formatDuration(entry.typicalSeconds)}</dd>
        </div>
        <div>
          <dt>Scoring</dt>
          <dd className="small-dd">{entry.results === 'immediate' ? 'Right after you submit' : 'When the host closes it'}</dd>
        </div>
      </dl>
      <p className="muted small">{evaluationHelp(entry.evaluationMode)}</p>
      <button type="button" className="btn btn-primary btn-lg" disabled={busy || paused} onClick={() => void start()} aria-busy={busy || undefined}>
        {paused ? 'Paused' : busy ? 'Starting…' : '▶ Start'}
      </button>
      <p className="muted small center-text">Your timer starts when you press Start.</p>
    </section>
  );
}

function Live({ ctx, entry }: { ctx: PlayCtx; entry: BoardEntry }) {
  const toast = useToast();
  const [finishing, setFinishing] = useState(false);
  const paused = ctx.snapshot.game.paused;
  const timer = lockTimer(entry, ctx.meId);

  const onSubmit = async (payload: Record<string, unknown>) => {
    const res = await ctx.sock.submit(entry.instanceId, payload);
    // Whether the answer is final depends on the module's resubmission policy, which the
    // board entry only reveals after the first submit (`canFinish`); the status text says the rest.
    if (res.ok) toast(entry.canFinish ? 'Answer updated' : 'Answer sent!', 'success');
    else toast(res.reason ?? 'Not accepted', 'danger');
  };

  const finish = async () => {
    if (!window.confirm('Lock in your answer now? You will not be able to change it.')) return;
    setFinishing(true);
    const res = await ctx.sock.finish(entry.instanceId);
    setFinishing(false);
    if (res.ok) toast('Locked in!', 'success');
    else toast(res.reason ?? 'Could not finish', 'danger');
  };

  return (
    <section className="stack gap-md">
      <BackBar ctx={ctx} title={entry.moduleName}>
        {timer && <Countdown endsAt={timer.endsAt} startedAt={timer.startedAt} clockOffset={ctx.sock.clockOffset} paused={paused} size="sm" label="Time left" />}
      </BackBar>
      <UIView
        key={entry.instanceId}
        node={entry.view}
        onSubmit={onSubmit}
        disabled={!entry.canSubmit || paused}
        timers={entry.timers}
        clockOffset={ctx.sock.clockOffset}
        paused={paused}
        uploadEvidence={ctx.uploadEvidence}
      />
      {entry.statusText && (
        <p className="status-line" role="status">
          {entry.statusText}
        </p>
      )}
      {entry.canFinish && (
        <button type="button" className="btn btn-secondary" disabled={finishing || paused} onClick={() => void finish()}>
          ✓ I'm done — lock my answer
        </button>
      )}
    </section>
  );
}

function Waiting({ ctx, entry }: { ctx: PlayCtx; entry: BoardEntry }) {
  const who =
    entry.evaluationMode === 'peer'
      ? 'Another player is judging your submission.'
      : entry.evaluationMode === 'host'
        ? 'The host is judging your submission.'
        : entry.evaluationMode === 'hybrid'
          ? 'Another player (or the host) is judging your submission.'
          : entry.results === 'onClose'
            ? 'Scores are revealed when the host closes this challenge.'
            : 'Your answer is being scored.';
  return (
    <section className="stack gap-md center-text">
      <BackBar ctx={ctx} title={entry.moduleName} />
      <div className="big-emoji" aria-hidden="true">
        ⏳
      </div>
      <h1>Submitted</h1>
      <p className="muted">{entry.statusText ?? who}</p>
      {entry.statusText && <p className="muted small">{who}</p>}
      <button type="button" className="btn btn-secondary" onClick={ctx.closeChallenge}>
        Back to board
      </button>
    </section>
  );
}

function Outcome({ ctx, entry }: { ctx: PlayCtx; entry: BoardEntry }) {
  const heading = entry.status === 'scored' ? 'Your result' : entry.status === 'missed' ? 'Time ran out' : 'Closed';
  return (
    <section className="stack gap-md">
      <BackBar ctx={ctx} title={entry.moduleName} />
      <div className="stack gap-xs center-text">
        <p className="eyebrow">{heading}</p>
        <h1>{entry.moduleName}</h1>
        {entry.points !== null && (
          <p>
            <span className={`points-badge points-badge-lg ${entry.points > 0 ? 'is-positive' : ''}`}>
              {entry.points > 0 ? '+' : ''}
              {formatPoints(entry.points)} pts
            </span>
          </p>
        )}
        {entry.status === 'missed' && <p className="muted">You did not submit before your time ran out.</p>}
        {entry.status === 'closed' && !entry.result && <p className="muted">The host closed this challenge before you played it.</p>}
      </div>
      {entry.result && (
        <div className="card card-flat">
          <UIView key={`${entry.instanceId}-result`} node={entry.result} />
        </div>
      )}
      {!entry.result && entry.statusText && (
        <p className="status-line" role="status">
          {entry.statusText}
        </p>
      )}
      <button type="button" className="btn btn-primary" onClick={ctx.closeChallenge}>
        Back to board
      </button>
    </section>
  );
}
