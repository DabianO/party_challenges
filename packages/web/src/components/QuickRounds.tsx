import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from 'react';
import type { QuickRoundsNode } from '@challenge/contract';

/** "3, 2, 1" before the first round (well under the 3 s modules allow for it). */
const COUNTDOWN = [3, 2, 1];
const COUNTDOWN_STEP_MS = 700;
/** The tapped button lights up this long before the next round (modules allow 250 ms). */
const GAP_MS = 180;
/** Give up waiting for the module to deal the rounds after this. */
const DEAL_TIMEOUT_MS = 6000;

type Answer = { choice: string | null; ms: number };

type Phase =
  | { kind: 'idle'; error?: string }
  | { kind: 'dealing'; from: string | null; since: number }
  | { kind: 'countdown'; runId: string; n: number }
  | { kind: 'round'; runId: string; i: number; answers: Answer[]; chosen: string | null }
  | { kind: 'done'; runId: string; answers: Answer[] };

/** When the touch happened, on the page's high-resolution clock (see Stopwatch). */
function eventTime(e: { timeStamp: number }): number {
  const now = performance.now();
  const t = e.timeStamp;
  return t > 0 && t <= now + 5 && now - t < 1000 ? t : now;
}

/**
 * Short timed rounds played on this device (`quick-rounds`): Start asks the module to deal
 * the rounds (a live action), then a countdown, then every round until its button is tapped
 * or its time runs out; the answers are submitted at the end. Times are measured from the
 * frame the round appears to the moment the finger lands.
 */
export function QuickRounds({
  node,
  enabled,
  submitting,
  onStart,
  onDone,
}: {
  node: QuickRoundsNode;
  enabled: boolean;
  submitting: boolean;
  onStart?: (payload: Record<string, unknown>) => void;
  onDone: (payload: Record<string, unknown>) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const shownAt = useRef(0);
  const limitMs = Math.max(200, node.secondsPerRound * 1000);
  const wasSubmitting = useRef(false);
  // The latest callback, without restarting the round timers whenever the page re-renders.
  const done = useRef(onDone);
  done.current = onDone;

  // The module dealt new rounds: count down, then play them.
  useEffect(() => {
    if (phase.kind !== 'dealing') return undefined;
    if (node.runId !== null && node.runId !== phase.from && node.rounds.length > 0) {
      setPhase({ kind: 'countdown', runId: node.runId, n: 0 });
      return undefined;
    }
    const id = window.setTimeout(() => setPhase({ kind: 'idle', error: 'That did not start. Try again.' }), Math.max(0, phase.since + DEAL_TIMEOUT_MS - Date.now()));
    return () => window.clearTimeout(id);
  }, [phase, node.runId, node.rounds.length]);

  useEffect(() => {
    if (phase.kind !== 'countdown') return undefined;
    const id = window.setTimeout(() => {
      setPhase(phase.n + 1 < COUNTDOWN.length ? { ...phase, n: phase.n + 1 } : { kind: 'round', runId: phase.runId, i: 0, answers: [], chosen: null });
    }, COUNTDOWN_STEP_MS);
    return () => window.clearTimeout(id);
  }, [phase]);

  const round = phase.kind === 'round' ? phase : null;
  // The round is on screen from this frame on; its time runs out after the limit.
  useLayoutEffect(() => {
    if (!round || round.chosen !== null) return undefined;
    shownAt.current = performance.now();
    const id = window.setTimeout(() => answer(null, performance.now()), limitMs);
    return () => window.clearTimeout(id);
    // Only a new round restarts the clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round?.runId, round?.i]);

  useEffect(() => {
    if (!round || round.chosen === null) return undefined;
    const id = window.setTimeout(() => {
      const next = round.i + 1;
      if (next < node.rounds.length) setPhase({ ...round, i: next, chosen: null });
      else {
        setPhase({ kind: 'done', runId: round.runId, answers: round.answers });
        done.current({ [node.name]: { runId: round.runId, answers: round.answers } });
      }
    }, GAP_MS);
    return () => window.clearTimeout(id);
  }, [round, node.rounds.length, node.name]);

  // Answers the server did not take (the screen is still here): allow another go.
  useEffect(() => {
    const was = wasSubmitting.current;
    wasSubmitting.current = submitting;
    if (!was || submitting || phase.kind !== 'done') return undefined;
    const id = window.setTimeout(() => setPhase({ kind: 'idle' }), 2500);
    return () => window.clearTimeout(id);
  }, [submitting, phase.kind]);

  function answer(choice: string | null, at: number) {
    setPhase((p) => {
      if (p.kind !== 'round' || p.chosen !== null) return p;
      const ms = Math.min(limitMs, Math.max(0, Math.round(at - shownAt.current)));
      return { ...p, chosen: choice ?? '', answers: [...p.answers, { choice: ms >= limitMs ? null : choice, ms }] };
    });
    if (choice) navigator.vibrate?.(8);
  }

  const start = (choice?: string) => {
    if (!enabled || (phase.kind !== 'idle' && phase.kind !== 'done')) return;
    setPhase({ kind: 'dealing', from: node.runId, since: Date.now() });
    onStart?.(choice === undefined ? { [node.name]: 'start' } : { [node.name]: 'start', choice });
  };

  if (phase.kind === 'idle' || phase.kind === 'dealing') {
    const choices = node.choices ?? [];
    return (
      <div className="quick-rounds">
        {phase.kind === 'dealing' ? (
          <button type="button" className="btn btn-primary btn-huge quick-start" disabled>
            Get ready…
          </button>
        ) : choices.length > 0 ? (
          <div className="quick-choices">
            {choices.map((c) => (
              <button key={c.id} type="button" className="btn btn-primary quick-choice" disabled={!enabled} onClick={() => start(c.id)}>
                <span className="quick-choice-label">{c.label}</span>
                {c.detail && <span className="quick-choice-detail">{c.detail}</span>}
              </button>
            ))}
          </div>
        ) : (
          <button type="button" className="btn btn-primary btn-huge quick-start" disabled={!enabled} onClick={() => start()}>
            {node.startLabel ?? 'START'}
          </button>
        )}
        {phase.kind === 'idle' && phase.error && (
          <p className="field-error" role="alert">
            {phase.error}
          </p>
        )}
      </div>
    );
  }
  if (phase.kind === 'countdown') {
    return (
      <div className="quick-rounds">
        <div className="quick-countdown" key={phase.n} aria-live="assertive">
          {COUNTDOWN[phase.n]}
        </div>
      </div>
    );
  }
  if (phase.kind === 'done') {
    return (
      <div className="quick-rounds">
        <div className="quick-done" role="status">
          {submitting ? 'Sending…' : 'Done!'}
        </div>
      </div>
    );
  }

  const r = node.rounds[phase.i];
  if (!r) return null;
  const press = (id: string) => ({
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      answer(id, eventTime(e));
    },
    onClick: (e: MouseEvent<HTMLButtonElement>) => {
      if (e.detail === 0) answer(id, eventTime(e));
    },
  });
  const timeStyle = { animationDuration: `${limitMs}ms`, '--round-ms': `${limitMs}ms` } as CSSProperties;
  return (
    <div className="quick-rounds is-playing">
      <div className="quick-head">
        <span className="quick-round-no mono">
          {phase.i + 1} / {node.rounds.length}
        </span>
        <span className="quick-time" aria-hidden="true">
          <span key={`${phase.runId}-${phase.i}`} style={timeStyle} className={phase.chosen !== null ? 'is-stopped' : undefined} />
        </span>
      </div>
      <div className="quick-prompt" aria-live="assertive">
        <span style={r.prompt.color ? { color: r.prompt.color } : undefined}>{r.prompt.text}</span>
      </div>
      <div className={`quick-options cols-${r.options.length <= 4 ? 2 : 3}`}>
        {r.options.map((o) => (
          <button
            key={o.id}
            type="button"
            className={`quick-option${phase.chosen === o.id ? ' is-chosen' : ''}`}
            disabled={phase.chosen !== null}
            {...press(o.id)}
          >
            {o.color && <span className="quick-swatch" style={{ background: o.color }} aria-hidden="true" />}
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
