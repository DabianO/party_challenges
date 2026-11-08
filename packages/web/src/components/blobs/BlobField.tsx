import { useEffect, useRef } from 'react';
import type { BlobFieldNode, BlobSpec } from '@challenge/contract';
import { decodeField, depthField, fillEmpty, fit, parseColor, regionsOf, type Grid } from './grid';

/** How long a territory change takes to flow into place. */
const TRANSITION_MS = 320;
/** Pixels per grid cell in the rendered image (scaled up smoothly): live, and the final picture. */
const PX_LIVE = 4;
const PX_FINAL = 8;

interface Frame {
  grid: Grid;
  depth: Float32Array;
}

/**
 * A `blob-field`: territories rendered as soft, embossed liquid. Each pixel blends the owners
 * of the cells around it (smooth edges, thin seams where blobs press together).
 *
 * Live, each update flows in over TRANSITION_MS and pumping makes a blob glow for a moment.
 * Final (the closing picture), open space joins the nearest blob so the picture has no gaps,
 * it is drawn once at a higher resolution, and every blob is labelled with its share.
 */
export function BlobField({ node }: { node: BlobFieldNode }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodeRef = useRef(node);
  nodeRef.current = node;

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext('2d');
    const low = document.createElement('canvas');
    const lowCtx = low.getContext('2d');
    if (!ctx || !lowCtx) return;
    const final = nodeRef.current.mode === 'final';
    const px = final ? PX_FINAL : PX_LIVE;

    let width = 0;
    let height = 0;
    let image: ImageData | null = null;
    let prev: Frame | null = null;
    let next: Frame | null = null;
    let cells = '';
    let changedAt = 0;
    let dirty = true;
    const glow = new Map<number, number>();
    const pulses = new Map<number, number>();
    let colors = new Map<number, [number, number, number]>();
    let acc = new Float32Array(2);

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      // Exactly the frame (a bigger canvas than its frame would be cut off on one side). Its
      // layout size, not its size on screen: a slide shrunk to fit scales the canvas with it.
      width = Math.max(40, Math.floor(wrap.clientWidth));
      height = Math.max(40, Math.floor(wrap.clientHeight));
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      dirty = true;
    };
    resize();
    let lastSize = { w: width, h: height };
    const ro = new ResizeObserver(([e]) => {
      if (!e || (Math.abs(e.contentRect.width - lastSize.w) < 2 && Math.abs(e.contentRect.height - lastSize.h) < 2)) return;
      resize();
      lastSize = { w: width, h: height };
    });
    ro.observe(wrap);

    const sync = (now: number) => {
      const n = nodeRef.current;
      colors = new Map(n.blobs.map((b) => [b.slot, parseColor(b.color)] as const));
      const maxSlot = Math.max(1, ...n.blobs.map((b) => b.slot));
      if (acc.length < maxSlot + 2) acc = new Float32Array(maxSlot + 2);
      for (const b of n.blobs) {
        const before = pulses.get(b.slot);
        const p = b.pulse ?? 0;
        if (before !== undefined && p > before) glow.set(b.slot, Math.min(1, (glow.get(b.slot) ?? 0) + 0.35 + (p - before) * 0.02));
        pulses.set(b.slot, p);
      }
      if (n.cells !== cells) {
        cells = n.cells;
        const grid = final ? fillEmpty(decodeField(n)) : decodeField(n);
        const fresh = { grid, depth: depthField(grid) };
        prev = final || !next ? fresh : next;
        next = fresh;
        changedAt = final ? -Infinity : now;
        if (!image || image.width !== grid.cols * px || image.height !== grid.rows * px) {
          low.width = grid.cols * px;
          low.height = grid.rows * px;
          image = lowCtx.createImageData(low.width, low.height);
        }
        dirty = true;
      }
    };

    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      sync(now);
      let glowing = false;
      for (const [slot, g] of glow) {
        const v = g * Math.exp(-dt * 3.5);
        if (v < 0.02) glow.delete(slot);
        else {
          glow.set(slot, v);
          glowing = true;
        }
      }
      const t = Math.min(1, (now - changedAt) / TRANSITION_MS);
      const moving = t < 1;
      if (!next || !image || !prev || (!dirty && !moving && !glowing)) return;
      dirty = moving || glowing;
      renderTerritory(image, prev, next, moving ? ease(t) : 1, colors, glow, acc, px);
      lowCtx.putImageData(image, 0, 0);
      const box = fit(next.grid.cols, next.grid.rows, width, height);
      drawBackground(ctx, width, height, box, !final);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(low, box.x, box.y, box.w, box.h);
      drawLabels(ctx, next, nodeRef.current.blobs, box, final);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <div className={node.mode === 'final' ? 'blob-field final' : 'blob-field'} ref={wrapRef}>
      <canvas ref={canvasRef} role="img" aria-label={`Blob War${node.mode === 'final' ? ', final picture' : ''}: ${node.blobs.length} blobs. ${describe(node.blobs)}`} />
    </div>
  );
}

export function describe(blobs: BlobSpec[]): string {
  const top = [...blobs].sort((a, b) => b.share - a.share).slice(0, 3);
  return top.map((b) => `${b.label ?? 'A player'} ${Math.round(b.share * 1000) / 10}%`).join(', ');
}

const ease = (t: number) => 1 - (1 - t) * (1 - t) * (1 - t);

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Blur radius (cells) of the owner field: enough to turn cell steps into clean curves. */
const SIGMA = 1;
const TAPS = 5;

/** Per pixel row/column: the first of the TAPS cells it blends and their normalised Gaussian weights. */
function kernel(pixels: number, px: number): { first: Int32Array; weights: Float32Array } {
  const first = new Int32Array(pixels);
  const weights = new Float32Array(pixels * TAPS);
  for (let p = 0; p < pixels; p++) {
    const u = (p + 0.5) / px - 0.5;
    const c0 = Math.round(u) - (TAPS >> 1);
    first[p] = c0;
    let sum = 0;
    for (let k = 0; k < TAPS; k++) {
      const d = c0 + k - u;
      const w = Math.exp(-(d * d) / (2 * SIGMA * SIGMA));
      weights[p * TAPS + k] = w;
      sum += w;
    }
    for (let k = 0; k < TAPS; k++) weights[p * TAPS + k]! /= sum;
  }
  return { first, weights };
}

interface Scratch {
  W: number;
  H: number;
  px: number;
  kx: ReturnType<typeof kernel>;
  ky: ReturnType<typeof kernel>;
  owner: Int16Array;
  height: Float32Array;
}
let scratch: Scratch | null = null;

function scratchFor(W: number, H: number, px: number): Scratch {
  if (!scratch || scratch.W !== W || scratch.H !== H || scratch.px !== px) {
    scratch = { W, H, px, kx: kernel(W, px), ky: kernel(H, px), owner: new Int16Array(W * H), height: new Float32Array(W * H) };
  }
  return scratch;
}

function renderTerritory(
  image: ImageData,
  prev: Frame,
  next: Frame,
  t: number,
  colors: Map<number, [number, number, number]>,
  glow: Map<number, number>,
  acc: Float32Array,
  pxPerCell: number,
): void {
  const { width: W, height: H, data } = image;
  const { cols, rows } = next.grid;
  const a = prev.grid.owners;
  const b = next.grid.owners;
  const { kx, ky, owner, height } = scratchFor(W, H, pxPerCell);
  const touched: number[] = [];
  // Pass 1: per pixel, the Gaussian-blurred owner field (blended between the previous and the
  // new grid). The owner is whoever has the most weight; a blob's edge is where it crosses
  // open space at 50 %, and two blobs meet where their weights are equal: smooth curves.
  for (let py = 0; py < H; py++) {
    const y0 = ky.first[py]!;
    for (let px = 0; px < W; px++) {
      const x0 = kx.first[px]!;
      touched.length = 0;
      for (let j = 0; j < TAPS; j++) {
        // Cells beyond the frame repeat the edge: blobs reach the wall without fading.
        const y = Math.max(0, Math.min(rows - 1, y0 + j));
        const wy = ky.weights[py * TAPS + j]!;
        for (let i = 0; i < TAPS; i++) {
          const x = Math.max(0, Math.min(cols - 1, x0 + i));
          const c = y * cols + x;
          const w = kx.weights[px * TAPS + i]! * wy;
          const ka = a[c]! + 1;
          const kb = b[c]! + 1;
          if (ka === kb) {
            if (acc[ka] === 0) touched.push(ka);
            acc[ka]! += w;
            continue;
          }
          if (acc[ka] === 0) touched.push(ka);
          acc[ka]! += w * (1 - t);
          if (acc[kb] === 0 && !touched.includes(kb)) touched.push(kb);
          acc[kb]! += w * t;
        }
      }
      let best = -1;
      let wBest = 0;
      let wSecond = 0;
      const wEmpty = acc[0]!;
      for (const k of touched) {
        const w = acc[k]!;
        acc[k] = 0;
        if (k === 0) continue;
        if (w > wBest) {
          wSecond = wBest;
          wBest = w;
          best = k - 1;
        } else if (w > wSecond) wSecond = w;
      }
      acc[0] = 0;
      const p = py * W + px;
      const o = p * 4;
      // Edge against open space: a crisp, anti-aliased contour at 50 %.
      const alpha = best < 0 ? 0 : smooth(-0.07, 0.07, wBest - wEmpty);
      owner[p] = alpha > 0 ? best : -1;
      height[p] = alpha > 0 ? wBest : 0;
      data[o + 3] = alpha * 255;
      // A thin dark seam where two blobs press together.
      data[o] = wSecond > 0 ? (1 - smooth(0.02, 0.16, wBest - wSecond)) * 255 : 0;
    }
  }
  // Pass 2: colour, a soft rim lit from the upper left (from the slope of the blob's own weight)
  // and a glow while its player pumps. The inside stays flat and calm.
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const p = py * W + px;
      const slot = owner[p]!;
      if (slot < 0) continue;
      const o = p * 4;
      const seam = data[o]! / 255;
      const own = (q: number) => (owner[q] === slot ? height[q]! : 0.35);
      const left = px > 0 ? own(p - 1) : height[p]!;
      const right = px < W - 1 ? own(p + 1) : height[p]!;
      const up = py > 0 ? own(p - W) : height[p]!;
      const down = py < H - 1 ? own(p + W) : height[p]!;
      const slope = (right - left + (down - up)) * pxPerCell * 0.5; // >0: facing away from the light
      const h = height[p]!;
      const rgb = colors.get(slot) ?? [140, 140, 160];
      const g = glow.get(slot) ?? 0;
      const shade = (0.76 + 0.24 * smooth(0.5, 0.95, h) - slope * 0.22) * (1 - seam * 0.6) + g * 0.18;
      const shine = Math.max(0, -slope) * 0.1 + g * 0.12;
      for (let c = 0; c < 3; c++) {
        const val = rgb[c]! * shade + 255 * shine;
        data[o + c] = val > 255 ? 255 : val < 0 ? 0 : val;
      }
    }
  }
}

function drawBackground(ctx: CanvasRenderingContext2D, w: number, h: number, box: { x: number; y: number; w: number; h: number }, grid: boolean): void {
  ctx.fillStyle = '#0b0d1c';
  ctx.fillRect(0, 0, w, h);
  const g = ctx.createLinearGradient(box.x, box.y, box.x + box.w, box.y + box.h);
  g.addColorStop(0, '#14183a');
  g.addColorStop(1, '#0d1024');
  ctx.fillStyle = g;
  ctx.fillRect(box.x, box.y, box.w, box.h);
  if (!grid) return;
  // Drafting grid.
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  const step = Math.max(20, Math.round(box.h / 14));
  ctx.beginPath();
  for (let x = box.x + step; x < box.x + box.w; x += step) {
    ctx.moveTo(Math.round(x) + 0.5, box.y);
    ctx.lineTo(Math.round(x) + 0.5, box.y + box.h);
  }
  for (let y = box.y + step; y < box.y + box.h; y += step) {
    ctx.moveTo(box.x, Math.round(y) + 0.5);
    ctx.lineTo(box.x + box.w, Math.round(y) + 0.5);
  }
  ctx.stroke();
}

/** Names at each blob's deepest point; with `shares`, its share of the room underneath. */
function drawLabels(ctx: CanvasRenderingContext2D, frame: Frame, blobs: BlobSpec[], box: { x: number; y: number; w: number; h: number }, shares: boolean): void {
  const { cols, rows } = frame.grid;
  const regions = regionsOf(frame.grid, frame.depth);
  const cell = box.w / cols;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const b of blobs) {
    const r = regions.get(b.slot);
    if (!r || !b.label) continue;
    // Fit the name inside the blob: limited by how deep its heart is.
    const size = Math.max(9, Math.min(shares ? 26 : 18, r.depth * cell * 0.6, Math.sqrt(r.area) * cell * 0.2));
    if (r.depth * cell < 9) continue;
    const x = box.x + ((r.heart % cols) + 0.5) * cell;
    const y = box.y + (Math.floor(r.heart / cols) + 0.5) * (box.h / rows) - (shares ? size * 0.3 : 0);
    const text = b.label.length > 12 ? `${b.label.slice(0, 11)}…` : b.label;
    ctx.font = `800 ${size}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, size / 5);
    ctx.strokeStyle = 'rgba(10,10,20,0.55)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, x, y);
    if (!shares) continue;
    const share = `${Math.round(b.share * 1000) / 10}%`;
    ctx.font = `700 ${size * 0.6}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.lineWidth = Math.max(2, size / 7);
    ctx.strokeText(share, x, y + size * 0.85);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillText(share, x, y + size * 0.85);
  }
}
