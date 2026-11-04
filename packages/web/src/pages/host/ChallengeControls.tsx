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

type Order = 'board' | 'category';
const ORDER_KEY = 'run-challenge-order';

function savedOrder(): Order {
  try {
    return localStorage.getItem(ORDER_KEY) === 'category' ? 'category' : 'board';
  } catch {
    return 'board';
  }
}

/** Challenges by the host's category (alphabetical, none last), board order inside each. */
export function byCategory(challenges: ChallengeInstanceSummary[]): { category: string; items: { c: ChallengeInstanceSummary; index: number }[] }[] {
  const groups = new Map<string, { c: ChallengeInstanceSummary; index: number }[]>();
  challenges.forEach((c, index) => groups.set(c.category, [...(groups.get(c.category) ?? []), { c, index }]));
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? 1 : 0) - (b === '' ? 1 : 0) || a.localeCompare(b))
    .map(([category, items]) => ({ category, items }));
}

export function ChallengeControls({ ctx, act, busy }: { ctx: HostCtx; act: Act; busy: boolean }) {
  const { challenges, game } = ctx.snapshot;
  const [order, setOrder] = useState<Order>(savedOrder);
  if (challenges.length === 0) return <p className="muted">No challenges in this game. Add some in Setup.</p>;
  const running = game.status === 'IN_PROGRESS';
  const closedCount = challenges.filter((c) => c.phase === 'LOCKED' || c.phase === 'EVALUATING' || c.phase === 'RESULTS').length;
  const choose = (next: Order) => {
    setOrder(next);
    try {
      localStorage.setItem(ORDER_KEY, next);
    } catch {
      // Only a convenience.
    }
  };
  const row = (c: ChallengeInstanceSummary, index: number) => <ChallengeRow key={c.id} ctx={ctx} c={c} index={index} act={act} busy={busy} running={running} />;

  return (
    <div className="stack gap-sm">
      <div className="row gap-sm wrap align-center challenge-toolbar">
        <div className="segmented" role="group" aria-label="Sort challenges">
          <button type="button" className={`btn btn-sm ${order === 'board' ? 'btn-primary' : 'btn-secondary'}`} aria-pressed={order === 'board'} onClick={() => choose('board')}>
            Board order
          </button>
          <button type="button" className={`btn btn-sm ${order === 'category' ? 'btn-primary' : 'btn-secondary'}`} aria-pressed={order === 'category'} onClick={() => choose('category')}>
            By category
          </button>
        </div>
        <span className="grow" />
        {running && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy || closedCount === 0}
            title="Open every closed challenge again. Players who played keep their result; Hot Takes and Blob War carry on where they were and are scored again when you close them."
            onClick={() => void act({ action: 'reopen-all-challenges' }, `Open all ${closedCount} closed challenges again?`)}
          >
            ▶ Reopen all closed ({closedCount})
          </button>
        )}
        <button
          type="button"
          className="btn btn-danger btn-ghost btn-sm"
          disabled={busy}
          onClick={() =>
            void act(
              { action: 'reset-all-challenges' },
              `Reset all ${challenges.length} challenges? Every attempt is discarded and all points from challenges are reversed. Players stay in the game.`,
            )
          }
        >
          ↺ Reset all
        </button>
      </div>
      {order === 'category' ? (
        byCategory(challenges).map((g) => (
          <section key={g.category} className="stack gap-xs" aria-label={g.category || 'No category'}>
            <h3 className="run-group-title">
              {g.category || 'No category'} <span className="muted">({g.items.length})</span>
            </h3>
            <ol className="plain-list stack gap-xs">{g.items.map(({ c, index }) => row(c, index))}</ol>
          </section>
        ))
      ) : (
        <ol className="plain-list stack gap-xs">{challenges.map((c, i) => row(c, i))}</ol>
      )}
    </div>
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
    <li className={`card card-flat stack gap-xs challenge-control phase-${c.phase}`}>
      <div className="challenge-control-main">
        <span className="challenge-index mono" aria-hidden="true">
          {index + 1}
        </span>
        <div className="grow stack gap-xs challenge-control-info">
          <span className="row gap-xs align-center wrap">
            <strong>{c.title}</strong>
            <PhaseBadge phase={c.phase} availability={c.availability} started={ctx.snapshot.game.startedAt !== null} />
            {c.category && <span className="badge tone-neutral">{c.category}</span>}
            <AvailabilityBadge availability={c.availability} assignedCount={c.assignedPlayerIds?.length} />
            <EvaluationBadge mode={c.evaluationMode} />
            {c.allowReplay && <span className="badge tone-primary">↻ Replays</span>}
          </span>
          <span className="muted small clamp" title={subtitleOf(c) ?? undefined}>
            {[subtitleOf(c), c.results === 'immediate' ? 'scored on submit' : 'scored when closed', statsLine(c)].filter(Boolean).join(' · ')}
          </span>
          {running && c.closedFor && c.closedFor.length > 0 && (
            <span className="row gap-xs wrap align-center closed-for">
              <span className="small">Closed for:</span>
              {c.closedFor.map((pid) => {
                const name = players.find((p) => p.id === pid)?.displayName ?? 'a player';
                return (
                  <button
                    key={pid}
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busy}
                    title={`Let ${name} play "${c.title}" again (points already deducted stay)`}
                    onClick={() => void act({ action: 'reopen-for-player', instanceId: id, playerId: pid })}
                  >
                    ▶ {name}
                  </button>
                );
              })}
            </span>
          )}
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
