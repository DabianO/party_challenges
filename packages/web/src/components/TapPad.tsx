import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import type { TapPadNode } from '@challenge/contract';

/**
 * A big tap target for rapid taps. Taps are counted on the device and sent as one live
 * action every `batchMs` ({ [action]: count }) so the server is not flooded.
 */
export function TapPad({ node, onAction }: { node: TapPadNode; onAction?: (payload: Record<string, unknown>) => void }) {
  const pending = useRef(0);
  const sendRef = useRef(onAction);
  sendRef.current = onAction;
  const [taps, setTaps] = useState(0);
  const [ripples, setRipples] = useState<number[]>([]);
  const color = /^#[0-9a-f]{6}$/i.test(node.color ?? '') ? node.color! : 'var(--accent)';
  const batchMs = Math.max(100, Math.min(2000, node.batchMs ?? 300));
  const enabled = typeof onAction === 'function';

  useEffect(() => {
    const flush = () => {
      if (pending.current <= 0 || !sendRef.current) return;
      const n = Math.min(60, pending.current);
      pending.current -= n;
      sendRef.current({ [node.action]: n });
    };
    const id = window.setInterval(flush, batchMs);
    return () => {
      window.clearInterval(id);
      flush();
    };
  }, [node.action, batchMs]);

  const tap = (e: PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    if (!enabled) return;
    pending.current += 1;
    setTaps((t) => t + 1);
    const id = performance.now();
    setRipples((r) => [...r.slice(-5), id]);
    window.setTimeout(() => setRipples((r) => r.filter((x) => x !== id)), 600);
    navigator.vibrate?.(8);
  };

  return (
    <div className="tap-pad-wrap">
      <button
        type="button"
        className="tap-pad"
        style={{ '--pad-color': color } as CSSProperties}
        disabled={!enabled}
        onPointerDown={tap}
        onKeyDown={(e) => {
          if (e.key === ' ' || e.key === 'Enter') tap(e as unknown as PointerEvent<HTMLButtonElement>);
        }}
        aria-label={node.label ?? 'Tap'}
      >
        {ripples.map((id) => (
          <span key={id} className="tap-pad-ripple" aria-hidden="true" />
        ))}
        <span className="tap-pad-label">{node.label ?? 'TAP'}</span>
        {node.sublabel && <span className="tap-pad-sub">{node.sublabel}</span>}
      </button>
      <span className="tap-pad-count muted" aria-live="off">
        {taps > 0 ? `${taps} ${taps === 1 ? 'pump' : 'pumps'}` : 'Tap the circle!'}
      </span>
    </div>
  );
}
