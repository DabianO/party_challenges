import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import type { StopwatchNode } from '@challenge/contract';

/** A second tap this soon after Start is a double tap, not a Stop. */
const MIN_RUN_MS = 300;

/**
 * When the touch happened, on the page's high-resolution clock. Input events carry their own
 * timestamp (taken when the touch arrived, before any rendering delay); fall back to now
 * when a browser reports something else (0, or an epoch-based value).
 */
function eventTime(e: { timeStamp: number }): number {
  const now = performance.now();
  const t = e.timeStamp;
  return t > 0 && t <= now + 5 && now - t < 1000 ? t : now;
}

function clock(ms: number, decimals: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(decimals)}`;
}

/**
 * A stopwatch timed on this device: Start and Stop are pointer-down timestamps, so neither the
 * network nor the screen refresh adds to the measured time. Start tells the module through a
 * live action; Stop submits the elapsed whole milliseconds.
 */
export function Stopwatch({
  node,
  enabled,
  submitting,
  onStart,
  onStop,
}: {
  node: StopwatchNode;
  enabled: boolean;
  submitting: boolean;
  onStart?: (payload: Record<string, unknown>) => void;
  onStop: (payload: Record<string, unknown>) => void;
}) {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [result, setResult] = useState<number | null>(null);
  const [, setFrame] = useState(0);
  const hideMs = node.hideAfterSeconds === undefined ? Infinity : Math.max(0, node.hideAfterSeconds * 1000);
  const running = startedAt !== null && result === null;
  const elapsed = startedAt === null ? 0 : (result ?? performance.now() - startedAt);
  const hidden = running && elapsed >= hideMs;
  const wasSubmitting = useRef(false);

  // Redraw every frame while the time is on screen; once it is hidden nothing changes.
  useEffect(() => {
    if (!running || startedAt === null) return;
    let raf = 0;
    const tick = () => {
      setFrame((f) => f + 1);
      if (performance.now() - startedAt < hideMs) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // Hide on time even when frames are not drawn (a backgrounded tab gets none).
    const left = startedAt + hideMs - performance.now();
    const hide = Number.isFinite(left) ? window.setTimeout(() => setFrame((f) => f + 1), Math.max(0, left)) : undefined;
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(hide);
    };
  }, [running, startedAt, hideMs]);

  // A stop the server did not take (the screen is still here): allow another run.
  useEffect(() => {
    const was = wasSubmitting.current;
    wasSubmitting.current = submitting;
    if (!was || submitting || result === null) return undefined;
    const id = window.setTimeout(() => {
      setStartedAt(null);
      setResult(null);
    }, 2500);
    return () => window.clearTimeout(id);
  }, [submitting, result]);

  const start = (at: number) => {
    if (!enabled || running) return;
    setResult(null);
    setStartedAt(at);
    onStart?.({ [node.name]: 'start' });
    navigator.vibrate?.(10);
  };
  const stop = (at: number) => {
    if (!enabled || startedAt === null || result !== null) return;
    const ms = at - startedAt;
    if (ms < MIN_RUN_MS) return;
    setResult(ms);
    onStop({ [node.name]: Math.round(ms) });
    navigator.vibrate?.(10);
  };
  // Touches act on pointer-down (the moment the finger lands); clicks only for the keyboard.
  const press = (action: (at: number) => void) => ({
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      action(eventTime(e));
    },
    onClick: (e: MouseEvent<HTMLButtonElement>) => {
      if (e.detail === 0) action(eventTime(e));
    },
  });

  let readout: string;
  if (result !== null) readout = `${clock(result, 3)} s`;
  else if (hidden) readout = '??.??';
  else readout = clock(elapsed, 2);

  return (
    <div className={`stopwatch${running ? ' is-running' : ''}${hidden ? ' is-hidden' : ''}${result !== null ? ' is-stopped' : ''}`}>
      <div className="stopwatch-face" aria-live="off">
        <span className="stopwatch-digits">{readout}</span>
        <span className="stopwatch-caption">
          {result !== null
            ? submitting
              ? 'Sending…'
              : 'Your time'
            : hidden
              ? 'The clock is hidden: count in your head!'
              : running
                ? 'Running…'
                : node.hideAfterSeconds !== undefined
                  ? node.hideAfterSeconds > 0
                    ? `The time disappears after ${node.hideAfterSeconds} s`
                    : 'You will not see the time'
                  : 'Tap Start when you are ready'}
        </span>
      </div>
      {/* One button for both, so keyboard focus stays on it. */}
      <button type="button" className={`stopwatch-btn ${running ? 'is-stop' : 'is-start'}`} disabled={!enabled || result !== null} {...press(running ? stop : start)}>
        {running ? (node.stopLabel ?? 'STOP') : (node.startLabel ?? 'START')}
      </button>
    </div>
  );
}
