import { useEffect, useRef } from 'react';
import type { DPadNode } from '@challenge/contract';

type Dir = 'up' | 'down' | 'left' | 'right';
const DELTA: Record<Dir, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const KEYS: Record<string, Dir> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
/** Shots closer together than this are dropped on the phone (the module reloads after a miss anyway). */
const FIRE_GAP_MS = 250;
/** A batch holds at most this many presses per direction (`DPadNode`). */
const MAX_BATCH = 20;

/**
 * Four arrows around a fire button (`d-pad`). Presses are counted here and sent in batches as
 * one live action, `{ move: [dx, dy] }`; Shoot sends what is still waiting first, then
 * `{ fire: true }`. Buttons react on touch-down, so fast tapping is not slowed by click delays.
 */
export function DPad({ node, onAction }: { node: DPadNode; onAction?: (payload: Record<string, unknown>) => void }) {
  const enabled = typeof onAction === 'function' && node.disabled !== true;
  const pending = useRef<[number, number]>([0, 0]);
  const timer = useRef<number | undefined>(undefined);
  const lastFire = useRef(0);
  const send = useRef(onAction);
  send.current = onAction;

  const flush = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    const [dx, dy] = pending.current;
    pending.current = [0, 0];
    if (dx !== 0 || dy !== 0) send.current?.({ [node.action]: { move: [dx, dy] } });
  };

  const press = (dir: Dir) => {
    if (!enabled) return;
    const [dx, dy] = DELTA[dir];
    pending.current = [pending.current[0] + dx, pending.current[1] + dy];
    if (Math.abs(pending.current[0]) >= MAX_BATCH || Math.abs(pending.current[1]) >= MAX_BATCH) flush();
    else if (timer.current === undefined) timer.current = window.setTimeout(flush, node.batchMs ?? 120);
  };

  const fire = () => {
    if (!enabled) return;
    const now = Date.now();
    if (now - lastFire.current < FIRE_GAP_MS) return;
    lastFire.current = now;
    flush();
    send.current?.({ [node.action]: { fire: true } });
  };

  // Arrow keys and the space bar on a computer.
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const dir = KEYS[e.key];
      if (dir) {
        e.preventDefault();
        press(dir);
      } else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (!e.repeat) fire();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Whatever is still waiting goes out when the pad goes away.
  useEffect(() => () => flush(), []);

  const arrow = (dir: Dir, label: string, symbol: string) => (
    <button
      type="button"
      className={`dpad-btn dpad-${dir}`}
      aria-label={label}
      disabled={!enabled}
      onPointerDown={(e) => {
        e.preventDefault();
        press(dir);
      }}
    >
      {symbol}
    </button>
  );

  return (
    <div className={`dpad${enabled ? '' : ' is-disabled'}`} role="group" aria-label="Steer and shoot">
      {arrow('up', 'Up', '▲')}
      {arrow('left', 'Left', '◀')}
      <button
        type="button"
        className="dpad-btn dpad-fire"
        disabled={!enabled}
        onPointerDown={(e) => {
          e.preventDefault();
          fire();
        }}
      >
        {node.fireLabel ?? 'Fire'}
      </button>
      {arrow('right', 'Right', '▶')}
      {arrow('down', 'Down', '▼')}
    </div>
  );
}
