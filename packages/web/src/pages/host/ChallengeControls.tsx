import { useState } from 'react';
import type { ChallengeInstanceSummary, HostAction } from '@challenge/contract';
import { AvailabilityBadge, EvaluationBadge, PhaseBadge } from '../../components/PhaseBadge';
import { formatPoints } from '../../lib/time';
import { subtitleOf, type HostCtx } from './hostApi';
import { PlayerPicker } from './InstanceOptionsFields';
import { ResultsDetail } from './ResultsBits';

export type Act = (action: HostAction, confirmText?: string) => Promise<boolean>;

export function statsLine(c: ChallengeInstanceSummary): string {
  const s = c.stats;
  const parts = [`${s.started} started`, `${s.submitted} submitted`, `${s.scored} scored`];
  if (s.attempts > s.started) parts.splice(1, 0, `${s.attempts} attempts`);
  if (s.pendingEvaluations > 0) parts.push(`${s.pendingEvaluations} waiting for judgement`);
  if (s.averagePoints !== null) parts.push(`avg ${formatPoints(s.averagePoints)}`);
  if (s.bestPoints !== null) parts.push(`best ${formatPoints(s.bestPoints)}`);
  return parts.join(' · ');
}

export function ChallengeControls({ ctx, act, busy }: { ctx: HostCtx; act: Act; busy: boolean }) {
  const { challenges, game } = ctx.snapshot;
  if (challenges.length === 0) return <p className="muted">No challenges in this game. Add some in Setup.</p>;
  return (
    <ol className="plain-list stack gap-sm">
      {challenges.map((c, i) => (
        <ChallengeRow key={c.id} ctx={ctx} c={c} index={i} act={act} busy={busy} running={game.status === 'IN_PROGRESS'} />
      ))}
    </ol>
  );
}

function ChallengeRow({ ctx, c, index, act, busy, running }: { ctx: HostCtx; c: ChallengeInstanceSummary; index: number; act: Act; busy: boolean; running: boolean }) {
  const { players } = ctx.snapshot;
  const results = ctx.snapshot.results[c.id];
  const [assigning, setAssigning] = useState(false);
  const [picked, setPicked] = useState<string[]>(c.assignedPlayerIds ?? []);
  const [showResults, setShowResults] = useState(false);
  const id = c.id;

  const unlock = () => act({ action: 'unlock-challenge', instanceId: id });
  const relock = () => act({ action: 'relock-challenge', instanceId: id }, `Hide "${c.title}" again? Players who have not started will no longer see it.`);
  const close = () =>
    act(
      { action: 'close-challenge', instanceId: id },
      `Close "${c.title}"? No new attempts can start; running attempts lock now${c.results === 'onClose' ? ' and everyone is scored' : ''}.`,
    );
  const reopen = () => act({ action: 'reopen-challenge', instanceId: id });
  const reset = () => act({ action: 'reset-challenge', instanceId: id }, `Reset "${c.title}"? All attempts are discarded and points from it are reversed. Until someone plays it again you can change all of its settings in the Setup tab.`);
  const retry = () => act({ action: 'retry-evaluation', instanceId: id });
  const assign = async () => {
    const ok = await act({ action: 'assign-challenge', instanceId: id, playerIds: picked });
    if (ok) setAssigning(false);
  };

  return (
    <li className={`card card-flat stack gap-sm challenge-control phase-${c.phase}`}>
      <div className="row gap-sm align-start wrap">
        <span className="challenge-index mono" aria-hidden="true">
          {index + 1}
        </span>
        <div className="grow stack gap-xs">
          <span className="row gap-sm align-center wrap">
            <strong>{c.title}</strong>
            <PhaseBadge phase={c.phase} availability={c.availability} started={ctx.snapshot.game.startedAt !== null} />
          </span>
          {subtitleOf(c) && <span className="muted small clamp">{subtitleOf(c)}</span>}
          <span className="row gap-xs wrap">
            <AvailabilityBadge availability={c.availability} assignedCount={c.assignedPlayerIds?.length} />
            <EvaluationBadge mode={c.evaluationMode} />
            <span className="badge tone-muted">{c.results === 'immediate' ? 'Scored on submit' : 'Scored when closed'}</span>
            {c.allowReplay && <span className="badge tone-primary">↻ Replays</span>}
          </span>
          <span className="muted small mono">{statsLine(c)}</span>
          {c.error && (
            <span className="row gap-sm wrap align-center">
              <span className="field-error" role="alert">
                <span aria-hidden="true">!</span> {c.error}
              </span>
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void retry()}>
                Retry evaluation
              </button>
            </span>
          )}
        </div>
      </div>

      <div className="row gap-xs wrap challenge-actions">
        {running && c.phase === 'PENDING' && (
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void unlock()}>
            🔓 Unlock
          </button>
        )}
        {running && c.phase === 'ACTIVE' && (
          <>
            <button type="button" className="btn btn-warning btn-sm" disabled={busy} onClick={() => void close()}>
              ■ Close
            </button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void relock()} title="Back to locked: hidden until you unlock it again">
              🔒 Hide again
            </button>
          </>
        )}
        {running && (c.phase === 'LOCKED' || c.phase === 'EVALUATING') && (
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void reopen()}>
            ▶ Reopen
          </button>
        )}
        {running && c.phase === 'RESULTS' && c.results === 'immediate' && (
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void reopen()} title="Let more players attempt it">
            ▶ Reopen
          </button>
        )}
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={busy}
          aria-expanded={assigning}
          onClick={() => {
            setPicked(c.assignedPlayerIds ?? []);
            setAssigning((a) => !a);
          }}
        >
          🎯 Assign to players…
        </button>
        {results && (
          <button type="button" className="btn btn-secondary btn-sm" aria-expanded={showResults} onClick={() => setShowResults((s) => !s)}>
            ★ {showResults ? 'Hide results' : 'Results'}
          </button>
        )}
        <button type="button" className="btn btn-danger btn-ghost btn-sm" disabled={busy} onClick={() => void reset()}>
          ↺ Reset
        </button>
      </div>

      {assigning && (
        <div className="stack gap-sm assign-panel">
          <span className="field-label">Only these players may start it ({picked.length} selected)</span>
          <PlayerPicker players={players} selected={picked} onChange={setPicked} disabled={busy} />
          <div className="row gap-sm wrap">
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || picked.length === 0} onClick={() => void assign()}>
              Assign
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAssigning(false)}>
              Cancel
            </button>
          </div>
          <p className="field-help">Assigned challenges stay hidden from everyone else — the big screen shows them as a secret challenge.</p>
        </div>
      )}

      {results && showResults && <ResultsDetail results={results} players={players} instanceKey={`${c.id}-run-results`} />}
    </li>
  );
}
