import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PairMatchNode } from '@challenge/contract';

/** A colour per link, by the left item's row, so a link keeps its colour while others change. */
const COLORS = ['#7c5cff', '#f59e0b', '#10b981', '#ef4444', '#3b82f6', '#ec4899', '#84cc16', '#06b6d4', '#f97316', '#a855f7', '#14b8a6', '#eab308'];
/** How long the screen trusts its own links over the server's before taking the server's again. */
const TRUST_MS = 2000;

type Side = 'left' | 'right';
interface Line {
  color: string;
  y1: number;
  y2: number;
}

/**
 * Two columns to link (`pair-match`): tap an item, then one on the other side; tap a linked
 * item to undo its link (and pick it again). Every change is a live action. The screen shows a
 * change at once and takes the server's links again once they catch up (or after a moment).
 */
export function PairMatch({ node, onAction }: { node: PairMatchNode; onAction?: (payload: Record<string, unknown>) => void }) {
  const enabled = typeof onAction === 'function';
  const [links, setLinks] = useState<Record<string, string>>(node.links);
  const [selected, setSelected] = useState<{ side: Side; id: string } | null>(null);
  const serverKey = JSON.stringify(node.links);
  const server = useRef(node.links);
  server.current = node.links;
  // The links this screen sent last, until the server shows them.
  const expected = useRef<string | null>(null);
  const trustTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (expected.current !== null && expected.current !== serverKey) return;
    expected.current = null;
    setLinks(node.links);
  }, [serverKey]);
  useEffect(() => () => window.clearTimeout(trustTimer.current), []);

  const send = (next: Record<string, string>, payload: { left: string; right: string | null }) => {
    setLinks(next);
    expected.current = JSON.stringify(next);
    window.clearTimeout(trustTimer.current);
    trustTimer.current = window.setTimeout(() => {
      // The server did not take it (or another change came in between): its links win.
      expected.current = null;
      setLinks(server.current);
    }, TRUST_MS);
    onAction?.({ [node.action]: payload });
  };

  const leftOf = (rightId: string) => Object.keys(links).find((l) => links[l] === rightId);

  const tap = (side: Side, id: string) => {
    if (!enabled) return;
    const linkedLeft = side === 'left' ? (links[id] !== undefined ? id : undefined) : leftOf(id);
    if (linkedLeft !== undefined) {
      const next = { ...links };
      delete next[linkedLeft];
      send(next, { left: linkedLeft, right: null });
      setSelected({ side, id });
      return;
    }
    if (!selected || selected.side === side) {
      setSelected(selected?.id === id && selected.side === side ? null : { side, id });
      return;
    }
    const left = side === 'left' ? id : selected.id;
    const right = side === 'right' ? id : selected.id;
    const next: Record<string, string> = {};
    for (const [l, r] of Object.entries(links)) if (l !== left && r !== right) next[l] = r;
    next[left] = right;
    send(next, { left, right });
    setSelected(null);
  };

  const colorOf = (leftId: string) => COLORS[Math.max(0, node.left.findIndex((l) => l.id === leftId)) % COLORS.length]!;
  const numberOf = (leftId: string) => node.left.findIndex((l) => l.id === leftId) + 1;

  // Lines between linked items, measured from the rendered buttons.
  const box = useRef<HTMLDivElement>(null);
  const items = useRef(new Map<string, HTMLButtonElement>());
  const [drawing, setDrawing] = useState<{ lines: Line[]; height: number }>({ lines: [], height: 0 });
  const measure = useCallback(() => {
    const root = box.current;
    if (!root) return;
    const top = root.getBoundingClientRect().top;
    const mid = (el: HTMLElement | undefined) => (el ? el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2 - top : null);
    const next: Line[] = [];
    for (const [l, r] of Object.entries(links)) {
      const y1 = mid(items.current.get(`left:${l}`));
      const y2 = mid(items.current.get(`right:${r}`));
      if (y1 !== null && y2 !== null) next.push({ color: colorOf(l), y1, y2 });
    }
    setDrawing({ lines: next, height: root.clientHeight });
  }, [links, node.left]);
  useLayoutEffect(measure, [measure]);
  useEffect(() => {
    const root = box.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(root);
    return () => observer.disconnect();
  }, [measure]);

  const column = (side: Side, list: PairMatchNode['left']) =>
    list.map((item) => {
      const linkedLeft = side === 'left' ? (links[item.id] !== undefined ? item.id : undefined) : leftOf(item.id);
      const partnerId = linkedLeft === undefined ? undefined : side === 'left' ? links[linkedLeft] : linkedLeft;
      const partner = partnerId === undefined ? undefined : (side === 'left' ? node.right : node.left).find((o) => o.id === partnerId);
      const isSelected = selected?.side === side && selected.id === item.id;
      const color = linkedLeft === undefined ? undefined : colorOf(linkedLeft);
      return (
        <button
          key={item.id}
          ref={(el) => {
            if (el) items.current.set(`${side}:${item.id}`, el);
            else items.current.delete(`${side}:${item.id}`);
          }}
          type="button"
          className={`pair-item pair-${side}${isSelected ? ' is-selected' : ''}${color ? ' is-linked' : ''}`}
          style={color ? ({ '--pair-color': color } as React.CSSProperties) : undefined}
          aria-pressed={isSelected}
          aria-label={partner ? `${item.label}, linked to ${partner.label}: tap to undo` : item.label}
          disabled={!enabled}
          onClick={() => tap(side, item.id)}
        >
          {side === 'right' && color && <span className="pair-chip">{numberOf(linkedLeft!)}</span>}
          <span className="pair-label">{item.label}</span>
          {side === 'left' && color && <span className="pair-chip">{numberOf(linkedLeft!)}</span>}
        </button>
      );
    });

  const linked = Object.keys(links).length;
  const total = Math.min(node.left.length, node.right.length);
  return (
    <div className="pair-match">
      {(node.leftTitle || node.rightTitle) && (
        <div className="pair-heads" aria-hidden="true">
          <span>{node.leftTitle}</span>
          <span />
          <span>{node.rightTitle}</span>
        </div>
      )}
      <div className="pair-columns" ref={box}>
        <div className="pair-column" role="group" aria-label={node.leftTitle || 'Left'}>
          {column('left', node.left)}
        </div>
        <svg className="pair-lines" aria-hidden="true" preserveAspectRatio="none" viewBox={`0 0 100 ${Math.max(1, drawing.height)}`}>
          {drawing.lines.map((line, i) => (
            <line key={i} x1="0" x2="100" y1={line.y1} y2={line.y2} stroke={line.color} strokeWidth="3" vectorEffect="non-scaling-stroke" strokeLinecap="round" />
          ))}
        </svg>
        <div className="pair-column" role="group" aria-label={node.rightTitle || 'Right'}>
          {column('right', node.right)}
        </div>
      </div>
      <p className="pair-hint muted small" role="status">
        {!enabled
          ? `${linked} of ${total} linked`
          : selected
            ? `Now tap its match on the ${selected.side === 'left' ? 'right' : 'left'}`
            : linked === total
              ? 'Everything is linked. Tap a linked item to undo it.'
              : 'Tap an item, then its match on the other side.'}
      </p>
    </div>
  );
}
