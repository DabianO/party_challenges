import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { LeaderboardEntry } from '@challenge/contract';
import { formatPoints } from '../lib/time';

/**
 * Points over challenges finished: one line per player, x = how many challenges they have
 * finished (in their own order), y = running total. Data: `LeaderboardEntry.series`.
 *
 * Colour follows the player, never the rank: up to 8 players get the categorical slots in
 * join order. With more players the current top 8 (plus "you") are drawn in colour, again
 * ordered by join order, and everyone else as thin "Others" lines. The leaderboard next to
 * the chart is its table view.
 */
/** What the chart needs per player (a leaderboard entry or a published standing). */
export type ChartEntry = Pick<LeaderboardEntry, 'playerId' | 'displayName' | 'rank' | 'total' | 'series'>;

export interface ProgressChartProps {
  /** In rank order. */
  entries: ChartEntry[];
  /** Player ids in join order (stable colour assignment). */
  playerOrder: string[];
  /** Number of challenges on the board: the x-axis runs 0..this. */
  challengeCount: number;
  meId?: string | null;
  height?: number;
  /** Take the height of the parent instead of `height` (the parent must have a definite height). */
  fillHeight?: boolean;
  /** Draw the lines in on mount (remount with a new `key` to replay, e.g. per update). */
  animate?: boolean;
  /** Prefix the end labels with the rank. */
  showRank?: boolean;
  size?: 'md' | 'lg';
}

const SLOTS = 8;
const MARGIN = { top: 14, right: 132, bottom: 40, left: 48 };
const LABEL_GAP = 16;
const LABEL_GAP_LG = 26;

interface Line {
  entry: ChartEntry;
  slot: number | null; // null = "Others"
  me: boolean;
}

function niceStep(range: number, target: number): number {
  const raw = range / Math.max(1, target);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

function ticks(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

/** Push labels apart vertically so they never overlap (keeps their order). */
function spread(ys: number[], gap: number, min: number, max: number): number[] {
  const order = ys.map((y, i) => [y, i] as const).sort((a, b) => a[0] - b[0]);
  const placed = order.map(([y]) => y);
  for (let i = 1; i < placed.length; i++) placed[i] = Math.max(placed[i]!, placed[i - 1]! + gap);
  const overflow = (placed.at(-1) ?? 0) - max;
  if (overflow > 0) for (let i = 0; i < placed.length; i++) placed[i] = placed[i]! - overflow;
  for (let i = 0; i < placed.length; i++) placed[i] = Math.max(placed[i]!, min + i * gap);
  const out = new Array<number>(ys.length);
  order.forEach(([, idx], k) => (out[idx] = placed[k]!));
  return out;
}

export function ProgressChart({
  entries,
  playerOrder,
  challengeCount,
  meId,
  height: fixedHeight = 320,
  fillHeight = false,
  animate = false,
  showRank = false,
  size = 'md',
}: ProgressChartProps) {
  const wrapRef = useRef<HTMLElement>(null);
  const legendRef = useRef<HTMLUListElement>(null);
  const [width, setWidth] = useState(640);
  const [boxHeight, setBoxHeight] = useState(fixedHeight);
  const [hoverX, setHoverX] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      if (!e) return;
      setWidth(Math.max(280, Math.floor(e.contentRect.width)));
      setBoxHeight(Math.floor(e.contentRect.height));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const legendHeight = legendRef.current?.offsetHeight ?? 32;
  const height = fillHeight ? Math.max(220, boxHeight - legendHeight - 8) : fixedHeight;
  const margin = size === 'lg' ? { ...MARGIN, right: 190, left: 56, bottom: 48 } : MARGIN;

  const lines = useMemo<Line[]>(() => {
    const joinIndex = (id: string) => {
      const i = playerOrder.indexOf(id);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    let highlighted = entries;
    if (entries.length > SLOTS) {
      // Leaderboard order = rank order: keep the top players (and yourself) in colour.
      const top = entries.slice(0, SLOTS);
      const me = entries.find((e) => e.playerId === meId);
      highlighted = me && !top.includes(me) ? [...top.slice(0, SLOTS - 1), me] : top;
    }
    const slotOf = new Map([...highlighted].sort((a, b) => joinIndex(a.playerId) - joinIndex(b.playerId)).map((e, i) => [e.playerId, i] as const));
    return entries.map((entry) => ({ entry, slot: slotOf.get(entry.playerId) ?? null, me: entry.playerId === meId }));
  }, [entries, playerOrder, meId]);

  const longest = Math.max(0, ...entries.map((e) => e.series.length - 1));
  const maxX = Math.max(1, challengeCount, longest);
  const values = entries.flatMap((e) => e.series);
  const yMinRaw = Math.min(0, ...values);
  // A little headroom so the leader's line and label never touch the top edge.
  const yMaxRaw = Math.max(1, ...values) * 1.08;
  const yStep = niceStep(yMaxRaw - yMinRaw, 5);
  const yMin = Math.floor(yMinRaw / yStep) * yStep;
  const yMax = Math.ceil(yMaxRaw / yStep) * yStep;

  const plotW = Math.max(120, width - margin.left - margin.right);
  const plotH = height - margin.top - margin.bottom;
  const sx = (x: number) => margin.left + (x / maxX) * plotW;
  const sy = (y: number) => margin.top + plotH - ((y - yMin) / (yMax - yMin || 1)) * plotH;
  const xStep = Math.max(1, niceStep(maxX, Math.floor(plotW / 44)));
  const xTicks = ticks(0, maxX, xStep).filter((t) => Number.isInteger(t));
  const yTicks = ticks(yMin, yMax, yStep);

  const coloured = lines.filter((l) => l.slot !== null && l.entry.series.length > 0);
  const others = lines.filter((l) => l.slot === null && l.entry.series.length > 0);
  const labelYs = spread(
    coloured.map((l) => sy(l.entry.series.at(-1)!)),
    size === 'lg' ? LABEL_GAP_LG : LABEL_GAP,
    margin.top + 6,
    margin.top + plotH,
  );
  const path = (series: number[]) => series.map((v, i) => `${i === 0 ? 'M' : 'L'}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(' ');

  const toX = (clientX: number, rect: DOMRect) => {
    const px = clientX - rect.left;
    return Math.min(maxX, Math.max(0, Math.round(((px - margin.left) / plotW) * maxX)));
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => setHoverX(toX(e.clientX, e.currentTarget.getBoundingClientRect()));
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowRight') setHoverX((x) => Math.min(maxX, (x ?? -1) + 1));
    else if (e.key === 'ArrowLeft') setHoverX((x) => Math.max(0, (x ?? maxX + 1) - 1));
    else if (e.key === 'Escape') setHoverX(null);
    else return;
    e.preventDefault();
  };

  const readout =
    hoverX === null
      ? []
      : lines
          .filter((l) => l.entry.series.length > hoverX)
          .map((l) => ({ ...l, value: l.entry.series[hoverX]! }))
          .sort((a, b) => b.value - a.value);
  const tooltipLeft = hoverX === null ? 0 : sx(hoverX);
  const flip = tooltipLeft > width / 2;

  const empty = entries.every((e) => e.series.length <= 1);
  const legend = [...coloured].sort((a, b) => a.slot! - b.slot!);
  return (
    <figure
      className={`viz-root progress-chart progress-chart-${size}${fillHeight ? ' progress-chart-fill' : ''}${animate ? ' is-animated' : ''}`}
      ref={wrapRef}
    >
      {empty ? (
        <p className="muted progress-chart-empty">The graph fills in as players finish challenges.</p>
      ) : (
        <>
          <ul className="viz-legend" aria-label="Players" ref={legendRef}>
            {legend.map((l) => (
              <li key={l.entry.playerId} className={l.me ? 'is-me' : undefined}>
                <span className="viz-key" style={{ background: `var(--series-${l.slot! + 1})` }} aria-hidden="true" />
                {l.entry.displayName}
              </li>
            ))}
            {others.length > 0 && (
              <li>
                <span className="viz-key viz-key-other" aria-hidden="true" />
                Others ({others.length})
              </li>
            )}
          </ul>
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={`Points per player over challenges finished. Leader: ${entries[0]?.displayName ?? 'nobody'} with ${formatPoints(entries[0]?.total ?? 0)} points.`}
            tabIndex={0}
            onPointerMove={onMove}
            onPointerLeave={() => setHoverX(null)}
            onKeyDown={onKey}
            onBlur={() => setHoverX(null)}
          >
            {/* Grid & axes: hairline, recessive. */}
            {yTicks.map((t) => (
              <g key={`y${t}`}>
                <line className="viz-grid" x1={margin.left} x2={margin.left + plotW} y1={sy(t)} y2={sy(t)} />
                <text className="viz-tick" x={margin.left - 8} y={sy(t)} textAnchor="end" dominantBaseline="middle">
                  {formatPoints(t)}
                </text>
              </g>
            ))}
            {xTicks.map((t) => (
              <text key={`x${t}`} className="viz-tick" x={sx(t)} y={margin.top + plotH + 16} textAnchor="middle">
                {t}
              </text>
            ))}
            <line className="viz-axis" x1={margin.left} x2={margin.left + plotW} y1={sy(Math.max(0, yMin))} y2={sy(Math.max(0, yMin))} />
            <text className="viz-axis-title" x={margin.left + plotW / 2} y={height - 6} textAnchor="middle">
              Challenges finished
            </text>
            <text className="viz-axis-title" x={12} y={margin.top + plotH / 2} textAnchor="middle" transform={`rotate(-90 12 ${margin.top + plotH / 2})`}>
              Points
            </text>

            {others.map((l) => (
              <path key={l.entry.playerId} className="viz-line viz-line-other" d={path(l.entry.series)} />
            ))}
            {coloured.map((l, i) => {
              const s = l.entry.series;
              const ex = sx(s.length - 1);
              const ey = sy(s.at(-1)!);
              const ly = labelYs[i]!;
              const lx = margin.left + plotW + 10;
              return (
                <g key={l.entry.playerId}>
                  <path className={`viz-line${l.me ? ' is-me' : ''}`} d={path(s)} pathLength={1} style={{ stroke: `var(--series-${l.slot! + 1})`, animationDelay: `${i * 90}ms` }} />
                  {/* Hairline from the line's end to its label in the right gutter. */}
                  <line className="viz-connector" x1={ex} y1={ey} x2={lx - 2} y2={ly} />
                  <circle className="viz-end" cx={ex} cy={ey} r={4} style={{ fill: `var(--series-${l.slot! + 1})` }} />
                  <text className="viz-label" x={lx} y={ly} dominantBaseline="middle">
                    {showRank && (
                  <tspan className="viz-label-rank">
                    {l.entry.rank}.{' '}
                  </tspan>
                )}
                <tspan className="viz-label-name">{l.entry.displayName.length > 12 ? `${l.entry.displayName.slice(0, 11)}…` : l.entry.displayName}</tspan>
                    <tspan className="viz-label-value" dx={6}>
                      {formatPoints(l.entry.total)}
                    </tspan>
                  </text>
                </g>
              );
            })}

            {hoverX !== null && <line className="viz-crosshair" x1={sx(hoverX)} x2={sx(hoverX)} y1={margin.top} y2={margin.top + plotH} />}
            {/* Hit area: the whole plot, so the crosshair finds the x without aiming at a line. */}
            <rect x={margin.left} y={margin.top} width={plotW} height={plotH} fill="transparent" />
          </svg>
          {hoverX !== null && (
            <div className="viz-tooltip" style={flip ? { right: width - tooltipLeft + 12 } : { left: tooltipLeft + 12 }} role="status">
              <div className="viz-tooltip-head">{hoverX === 0 ? 'Start' : `After ${hoverX} ${hoverX === 1 ? 'challenge' : 'challenges'}`}</div>
              {readout.length === 0 && <div className="muted small">Nobody got this far yet</div>}
              {readout.slice(0, 10).map((r) => (
                <div key={r.entry.playerId} className="viz-tooltip-row">
                  <span className={`viz-key${r.slot === null ? ' viz-key-other' : ''}`} style={r.slot === null ? undefined : { background: `var(--series-${r.slot + 1})` }} aria-hidden="true" />
                  <strong>{formatPoints(r.value)}</strong>
                  <span className="muted">{r.entry.displayName}</span>
                </div>
              ))}
              {readout.length > 10 && <div className="muted small">+{readout.length - 10} more</div>}
            </div>
          )}
        </>
      )}
    </figure>
  );
}
