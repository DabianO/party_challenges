import { useEffect, useRef, useState } from 'react';
import type { LiveAnswerNode } from '@challenge/contract';

/** Wait this long after the last slider movement before sending (the release sends at once). */
const SEND_DELAY_MS = 350;

function num(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/**
 * An answer that is sent the moment it changes (a live action, no submit button), so players
 * can come back and change their minds. A slider, or one button per option.
 */
export function LiveAnswer({ node, onAction }: { node: LiveAnswerNode; onAction?: (payload: Record<string, unknown>) => void }) {
  const enabled = typeof onAction === 'function';
  const step = node.step && node.step > 0 ? node.step : 1;
  const start = node.start ?? node.min + Math.round((node.max - node.min) / 2 / step) * step;
  const [local, setLocal] = useState<number | null>(node.value);
  // What was sent last, so the server's echo does not fight a slider that is still moving.
  const sent = useRef<number | null>(node.value);
  const pending = useRef<number | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const sendRef = useRef(onAction);
  sendRef.current = onAction;

  const send = (value: number) => {
    window.clearTimeout(timer.current);
    pending.current = null;
    if (sent.current === value) return;
    sent.current = value;
    sendRef.current?.({ [node.action]: { id: node.id, value } });
  };

  // The server's value wins whenever nothing is waiting to be sent.
  useEffect(() => {
    if (pending.current === null) {
      sent.current = node.value;
      setLocal(node.value);
    }
  }, [node.value]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const words = (v: number | null): string => {
    if (v === null) return node.options ? 'Not answered yet' : 'Not answered yet: drag or tap the slider';
    const option = node.options?.find((o) => o.value === v);
    if (option) return option.label;
    const label = node.stepLabels?.[Math.round((v - node.min) / step)];
    if (label) return label;
    return node.unit ? `${num(v)} ${node.unit}` : num(v);
  };

  if (node.options) {
    return (
      <div className="live-answer live-answer-options" role="radiogroup" aria-label="Your answer">
        {node.options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={local === o.value}
            className={`choice tone-${o.tone ?? 'neutral'}${local === o.value ? ' is-selected' : ''}`}
            disabled={!enabled}
            onClick={() => {
              setLocal(o.value);
              send(o.value);
            }}
          >
            <span className="choice-label">{o.label}</span>
            <span className="choice-check" aria-hidden="true">
              {local === o.value ? '✓' : ''}
            </span>
          </button>
        ))}
      </div>
    );
  }

  const shown = local ?? start;
  const move = (value: number) => {
    setLocal(value);
    pending.current = value;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => send(value), SEND_DELAY_MS);
  };
  // Releasing the slider answers, even without moving it (e.g. agreeing with the middle).
  const release = () => {
    const value = pending.current ?? local ?? start;
    setLocal(value);
    send(value);
  };

  return (
    <div className={`live-answer${local === null ? ' is-unanswered' : ''}`}>
      <output className="live-answer-value" aria-live="polite">
        {words(local)}
      </output>
      <input
        className="range"
        type="range"
        min={node.min}
        max={node.max}
        step={step}
        value={shown}
        disabled={!enabled}
        aria-label="Your answer"
        aria-valuetext={words(local)}
        onChange={(e) => move(Number(e.target.value))}
        onPointerUp={release}
        onKeyUp={release}
      />
      {node.marks && node.marks.length > 0 && (
        <div className="live-answer-marks" aria-hidden="true">
          {node.marks.map((m) => (
            <span key={m.value} style={{ left: `${((m.value - node.min) / (node.max - node.min || 1)) * 100}%` }}>
              {m.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
