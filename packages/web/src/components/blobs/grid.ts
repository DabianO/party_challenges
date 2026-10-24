/**
 * Helpers for rendering `blob-field` territory grids (owner per cell, -1 = empty).
 */
import { blobCells, type BlobFieldNode } from '@challenge/contract';

export interface Grid {
  cols: number;
  rows: number;
  owners: Int16Array;
}

export function decodeField(node: Pick<BlobFieldNode, 'cols' | 'rows' | 'cells'>): Grid {
  const cols = Math.max(1, Math.floor(node.cols));
  const rows = Math.max(1, Math.floor(node.rows));
  const owners = new Int16Array(cols * rows).fill(-1);
  const n = Math.min(owners.length, node.cells.length);
  for (let i = 0; i < n; i++) owners[i] = blobCells.decode(node.cells[i]!);
  return { cols, rows, owners };
}

export function parseColor(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [140, 120, 240];
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Per cell: distance (cells, chamfer) to the edge of its own territory — 0.5 on the edge,
 * growing inward. Empty cells are 0. Used for the liquid relief and the glass vignette.
 */
export function depthField(grid: Grid): Float32Array {
  const { cols, rows, owners } = grid;
  const d = new Float32Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const o = owners[i]!;
      if (o === -1) continue;
      const edge =
        x === 0 || y === 0 || x === cols - 1 || y === rows - 1 || owners[i - 1] !== o || owners[i + 1] !== o || owners[i - cols] !== o || owners[i + cols] !== o;
      d[i] = edge ? 0.5 : 1e6;
    }
  }
  const D = Math.SQRT2;
  const relax = (i: number, j: number, cost: number) => {
    if (owners[j] === owners[i] && d[j]! + cost < d[i]!) d[i] = d[j]! + cost;
  };
  for (let y = 1; y < rows; y++) {
    for (let x = 1; x < cols - 1; x++) {
      const i = y * cols + x;
      if (owners[i] === -1) continue;
      relax(i, i - 1, 1);
      relax(i, i - cols, 1);
      relax(i, i - cols - 1, D);
      relax(i, i - cols + 1, D);
    }
  }
  for (let y = rows - 2; y >= 0; y--) {
    for (let x = cols - 2; x >= 1; x--) {
      const i = y * cols + x;
      if (owners[i] === -1) continue;
      relax(i, i + 1, 1);
      relax(i, i + cols, 1);
      relax(i, i + cols + 1, D);
      relax(i, i + cols - 1, D);
    }
  }
  for (let i = 0; i < d.length; i++) if (d[i]! > 1e5) d[i] = 0.5;
  return d;
}

export interface Region {
  slot: number;
  area: number;
  /** The deepest cell: a label point that is always inside, however odd the shape. */
  heart: number;
  depth: number;
}

export function regionsOf(grid: Grid, depth: Float32Array): Map<number, Region> {
  const out = new Map<number, Region>();
  for (let i = 0; i < grid.owners.length; i++) {
    const o = grid.owners[i]!;
    if (o === -1) continue;
    let r = out.get(o);
    if (!r) {
      r = { slot: o, area: 0, heart: i, depth: -1 };
      out.set(o, r);
    }
    r.area++;
    if (depth[i]! > r.depth) {
      r.depth = depth[i]!;
      r.heart = i;
    }
  }
  return out;
}

/** A copy where every empty cell joins the nearest territory (a gapless window for the final picture). */
export function fillEmpty(grid: Grid): Grid {
  const { cols, rows } = grid;
  const owners = grid.owners.slice();
  const queue = new Int32Array(owners.length);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < owners.length; i++) if (owners[i] !== -1) queue[tail++] = i;
  if (tail === 0) return { cols, rows, owners };
  while (head < tail) {
    const i = queue[head++]!;
    const x = i % cols;
    const visit = (j: number) => {
      if (owners[j] === -1) {
        owners[j] = owners[i]!;
        queue[tail++] = j;
      }
    };
    if (x > 0) visit(i - 1);
    if (x < cols - 1) visit(i + 1);
    if (i >= cols) visit(i - cols);
    if (i < owners.length - cols) visit(i + cols);
  }
  return { cols, rows, owners };
}

/** Bilinear sample of a per-cell field at cell coordinates (u, v), cell centres at integers. */
export function sample(field: Float32Array, cols: number, rows: number, u: number, v: number): number {
  const x0 = Math.max(0, Math.min(cols - 1, Math.floor(u)));
  const y0 = Math.max(0, Math.min(rows - 1, Math.floor(v)));
  const x1 = Math.min(cols - 1, x0 + 1);
  const y1 = Math.min(rows - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, u - x0));
  const fy = Math.max(0, Math.min(1, v - y0));
  const a = field[y0 * cols + x0]!;
  const b = field[y0 * cols + x1]!;
  const c = field[y1 * cols + x0]!;
  const d = field[y1 * cols + x1]!;
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Fit a cols:rows field inside a w×h box (letterboxed, centred). */
export function fit(cols: number, rows: number, w: number, h: number): { x: number; y: number; w: number; h: number } {
  const scale = Math.min(w / cols, h / rows);
  const fw = cols * scale;
  const fh = rows * scale;
  return { x: (w - fw) / 2, y: (h - fh) / 2, w: fw, h: fh };
}
