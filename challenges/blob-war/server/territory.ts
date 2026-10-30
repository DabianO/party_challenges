/**
 * Blob War territory: the room is a grid of cells, each empty (-1) or owned by one blob
 * (its colour slot). Pure and deterministic: all randomness comes from the `rng` passed in.
 *
 *  - spawn:  a newcomer appears in the emptiest spot and clears a circle around it (the room
 *            it may grow into); whoever was there is cut off by that circle.
 *  - grow:   a blob grows outward evenly from the shape it grows from. Every owned cell
 *            remembers its *source*, a point of that shape, and the blob claims the edge cell
 *            nearest to any source. A fresh blob grows from its centre (a clean circle); a blob
 *            cut by a newcomer's circle grows on from its new, dented shape, so it keeps its form
 *            instead of rounding off.
 *  - fight:  growing into a neighbour is allowed only if the grower is clearly more active
 *            (`strength`, e.g. recent pumping). The neighbour then gives way: it regrows the cell
 *            on its far side (into open space, or by pushing the next blob), and when there is
 *            nowhere to go it is compressed, but never below `minCells`.
 */

/** About 2.4 : 1, the shape of a quarter of a 16 : 9 big screen (the 2 × 2 dashboard). */
export const COLS = 136;
export const ROWS = 56;
export const TOTAL = COLS * ROWS;
/** Every blob keeps at least this share of the room: always clearly visible. */
export const MIN_SHARE = 0.015;
export const MIN_CELLS = Math.round(MIN_SHARE * TOTAL);
/** A fresh blob is a disc of the minimum size. */
export const SEED_RADIUS = Math.sqrt(MIN_CELLS / Math.PI) + 0.5; // a grid disc of radius √(n/π) has a few cells less

export type Owners = Int16Array;

export interface Field {
  owners: Owners;
  /** Per owned cell: the point of its blob's reference shape that its growth is measured from. */
  sources: Int32Array;
  /** Blobs cut by a newcomer's circle since they last grew: their next growth starts from their current shape. */
  dented: Set<number>;
}

const EMPTY = -1;

export function emptyOwners(): Owners {
  return new Int16Array(TOTAL).fill(EMPTY);
}

/** A field around existing owners; every cell is its own source (growth starts from the shapes as they are). */
export function fieldOf(owners: Owners, sources?: Int32Array, dented?: Iterable<number>): Field {
  const src = sources ?? new Int32Array(TOTAL);
  if (!sources) for (let i = 0; i < TOTAL; i++) src[i] = i;
  return { owners, sources: src, dented: new Set(dented) };
}

export function emptyField(): Field {
  return fieldOf(emptyOwners());
}

/** Cells per slot. */
export function areasOf(owners: Owners): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 0; i < TOTAL; i++) {
    const o = owners[i]!;
    if (o !== EMPTY) out.set(o, (out.get(o) ?? 0) + 1);
  }
  return out;
}

function forNeighbours4(i: number, fn: (n: number) => void): void {
  const x = i % COLS;
  if (x > 0) fn(i - 1);
  if (x < COLS - 1) fn(i + 1);
  if (i >= COLS) fn(i - COLS);
  if (i < TOTAL - COLS) fn(i + COLS);
}

function forNeighbours8(i: number, fn: (n: number) => void): void {
  const x = i % COLS;
  const y = (i - x) / COLS;
  for (let dy = -1; dy <= 1; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= ROWS) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx;
      if ((dx || dy) && xx >= 0 && xx < COLS) fn(yy * COLS + xx);
    }
  }
}

function dist(a: number, b: number): number {
  const ax = a % COLS;
  const bx = b % COLS;
  return Math.hypot(ax - bx, (a - ax) / COLS - (b - bx) / COLS);
}

/** Distance (in cells, chamfer) from every cell to the nearest occupied cell or wall. */
export function openness(owners: Owners): Float32Array {
  const d = new Float32Array(TOTAL);
  for (let i = 0; i < TOTAL; i++) {
    const x = i % COLS;
    const y = (i - x) / COLS;
    d[i] = owners[i] !== EMPTY ? 0 : Math.min(x + 1, y + 1, COLS - x, ROWS - y);
  }
  const D = Math.SQRT2;
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const i = y * COLS + x;
      let v = d[i]!;
      if (x > 0) v = Math.min(v, d[i - 1]! + 1);
      if (y > 0) {
        v = Math.min(v, d[i - COLS]! + 1);
        if (x > 0) v = Math.min(v, d[i - COLS - 1]! + D);
        if (x < COLS - 1) v = Math.min(v, d[i - COLS + 1]! + D);
      }
      d[i] = v;
    }
  }
  for (let y = ROWS - 1; y >= 0; y--) {
    for (let x = COLS - 1; x >= 0; x--) {
      const i = y * COLS + x;
      let v = d[i]!;
      if (x < COLS - 1) v = Math.min(v, d[i + 1]! + 1);
      if (y < ROWS - 1) {
        v = Math.min(v, d[i + COLS]! + 1);
        if (x < COLS - 1) v = Math.min(v, d[i + COLS + 1]! + D);
        if (x > 0) v = Math.min(v, d[i + COLS - 1]! + D);
      }
      d[i] = v;
    }
  }
  return d;
}

/** Centre of the largest empty space; a random interior cell when the room is full. */
export function spawnPoint(owners: Owners, rng: () => number): number {
  // Never so close to a wall that a fresh blob would be cut short.
  const m = Math.ceil(SEED_RADIUS) + 1;
  const d = openness(owners);
  let best = 0;
  const inside = (i: number) => {
    const x = i % COLS;
    const y = (i - x) / COLS;
    return x >= m && y >= m && x < COLS - m && y < ROWS - m;
  };
  for (let i = 0; i < TOTAL; i++) if (inside(i) && d[i]! > best) best = d[i]!;
  if (best <= 1.01) {
    const x = m + Math.floor(rng() * (COLS - 2 * m));
    const y = m + Math.floor(rng() * (ROWS - 2 * m));
    return y * COLS + x;
  }
  const ties: number[] = [];
  for (let i = 0; i < TOTAL; i++) if (inside(i) && d[i]! >= best - 0.5) ties.push(i);
  return ties[Math.floor(rng() * ties.length)]!;
}

/** Calls `fn` for every cell within `radius` of `center`. */
function forCircle(center: number, radius: number, fn: (i: number) => void): void {
  const cx = center % COLS;
  const cy = (center - cx) / COLS;
  const r = Math.ceil(radius);
  for (let y = Math.max(0, cy - r); y <= Math.min(ROWS - 1, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x <= Math.min(COLS - 1, cx + r); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= radius * radius) fn(y * COLS + x);
    }
  }
}

/** Set every cell within `radius` of `center` to `owner`. */
export function fillCircle(owners: Owners, center: number, radius: number, owner: number): void {
  forCircle(center, radius, (i) => {
    owners[i] = owner;
  });
}

/**
 * Place `slot` in the emptiest spot as a minimum-size disc that grows from its centre; with
 * `clearRadius` > 0 first clear a circle of that radius around it. Blobs the circle cuts are
 * dented; each stays one piece, and one that would drop below `minCells` (or vanish) regrows
 * to that size at the edge of the circle.
 */
export function spawn(field: Field, slot: number, rng: () => number, clearRadius: number, minCells = MIN_CELLS): number {
  const { owners, sources, dented } = field;
  for (let i = 0; i < TOTAL; i++) if (owners[i] === slot) owners[i] = EMPTY;
  const center = spawnPoint(owners, rng);
  const lost = new Map<number, number[]>();
  const clear = (i: number) => {
    const o = owners[i]!;
    if (o !== EMPTY && o !== slot) {
      dented.add(o);
      let list = lost.get(o);
      if (!list) lost.set(o, (list = []));
      list.push(i);
    }
    owners[i] = EMPTY;
  };
  if (clearRadius > 0) forCircle(center, clearRadius, clear);
  forCircle(center, SEED_RADIUS, (i) => {
    clear(i);
    owners[i] = slot;
    sources[i] = center;
  });
  // Every blob the circle cut keeps one piece. One left well below the minimum, or with no
  // open space to regrow into, is rebuilt at the edge of the circle, where it was cut furthest
  // out. All are placed first and then regrow to the minimum in turns, so none boxes another in.
  const areaOf = (o: number) => owners.reduce((n, x) => (x === o ? n + 1 : n), 0);
  const touchesOpen = (o: number) => {
    for (let i = 0; i < TOTAL; i++) {
      if (owners[i] !== o) continue;
      let open = false;
      forNeighbours4(i, (n) => {
        if (owners[n] === EMPTY) open = true;
      });
      if (open) return true;
    }
    return false;
  };
  const short: number[] = [];
  for (const [o, cells] of lost) {
    keepLargestPiece(field, o);
    const area = areaOf(o);
    if (area >= minCells) continue;
    if (area < minCells / 2 || !touchesOpen(o)) {
      for (let i = 0; i < TOTAL; i++) if (owners[i] === o) owners[i] = EMPTY;
      let far = -1;
      for (const i of cells) if (owners[i] === EMPTY && (far < 0 || dist(i, center) > dist(far, center))) far = i;
      if (far < 0) {
        // It sat inside the newcomer's own disc: it reappears just outside, in its direction
        // (on the nearest open cell, or, in a full room, the first cell beyond the disc).
        let out = cells[0]!;
        for (const i of cells) if (dist(i, center) > dist(out, center)) out = i;
        const cx = center % COLS;
        const cy = (center - cx) / COLS;
        let dx = (out % COLS) - cx;
        let dy = Math.floor(out / COLS) - cy;
        const len = Math.hypot(dx, dy) || 1;
        dx /= len;
        dy /= len;
        if (!dx && !dy) dx = 1;
        for (let r = 0; r < COLS + ROWS && far < 0; r += 0.5) {
          const x = Math.round(cx + dx * r);
          const y = Math.round(cy + dy * r);
          if (x < 0 || y < 0 || x >= COLS || y >= ROWS) break;
          const i = y * COLS + x;
          if (owners[i] !== slot) far = i;
        }
        if (far < 0) far = cells[0]!;
      }
      owners[far] = o;
      sources[far] = far;
    }
    short.push(o);
  }
  for (let round = 0; short.length > 0 && round < 50; round++) {
    for (const o of [...short]) {
      const need = minCells - areaOf(o);
      if (need > 0 && grow(field, o, Math.min(need, 12), { maxCells: minCells, rng, minCells }) > 0) continue;
      // Done, or boxed in after all: it takes what it still needs from its neighbours (never below theirs).
      if (need > 0) grow(field, o, need, { maxCells: minCells, rng, strength: (s) => (s === o ? 1 : 0), minCells });
      short.splice(short.indexOf(o), 1);
    }
  }
  dented.delete(slot);
  return center;
}

/** Keep only the largest (edge-connected) piece of `slot`; other pieces become open space. */
function keepLargestPiece(field: Field, slot: number): void {
  const { owners } = field;
  const label = new Int32Array(TOTAL).fill(-1);
  const queue = new Int32Array(TOTAL);
  let bestId = -1;
  let bestSize = 0;
  let id = 0;
  for (let i = 0; i < TOTAL; i++) {
    if (owners[i] !== slot || label[i] !== -1) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = i;
    label[i] = id;
    while (head < tail) {
      forNeighbours4(queue[head++]!, (n) => {
        if (owners[n] === slot && label[n] === -1) {
          label[n] = id;
          queue[tail++] = n;
        }
      });
    }
    if (tail > bestSize) {
      bestSize = tail;
      bestId = id;
    }
    id++;
  }
  if (id <= 1) return;
  for (let i = 0; i < TOTAL; i++) if (owners[i] === slot && label[i] !== bestId) owners[i] = EMPTY;
}

/** Per slot: area, coordinate sums (→ centroid) and a bounding box that only ever grows. */
interface Census {
  area: Int32Array;
  sx: Float64Array;
  sy: Float64Array;
  x0: Int16Array;
  y0: Int16Array;
  x1: Int16Array;
  y1: Int16Array;
}

function census(owners: Owners, slots: number): Census {
  const c: Census = {
    area: new Int32Array(slots),
    sx: new Float64Array(slots),
    sy: new Float64Array(slots),
    x0: new Int16Array(slots).fill(COLS),
    y0: new Int16Array(slots).fill(ROWS),
    x1: new Int16Array(slots).fill(-1),
    y1: new Int16Array(slots).fill(-1),
  };
  for (let i = 0; i < TOTAL; i++) {
    const o = owners[i]!;
    if (o !== EMPTY) count(c, o, i, 1);
  }
  return c;
}

function count(c: Census, slot: number, i: number, sign: 1 | -1): void {
  const x = i % COLS;
  const y = (i - x) / COLS;
  c.area[slot]! += sign;
  c.sx[slot]! += sign * x;
  c.sy[slot]! += sign * y;
  if (sign > 0) {
    if (x < c.x0[slot]!) c.x0[slot] = x;
    if (x > c.x1[slot]!) c.x1[slot] = x;
    if (y < c.y0[slot]!) c.y0[slot] = y;
    if (y > c.y1[slot]!) c.y1[slot] = y;
  }
}

/** One growth step in progress: the field, its census, and an undo log for the current push. */
interface Work {
  field: Field;
  c: Census;
  log: number[];
}

/** Give cell `i` to `slot` (measured from `source`). */
function assign(w: Work, i: number, slot: number, source: number): void {
  const { owners, sources } = w.field;
  const old = owners[i]!;
  w.log.push(i, old, sources[i]!);
  if (old !== EMPTY) count(w.c, old, i, -1);
  owners[i] = slot;
  sources[i] = source;
  if (slot !== EMPTY) count(w.c, slot, i, 1);
}

function undo(w: Work): void {
  const log = w.log.splice(0);
  for (let k = log.length - 3; k >= 0; k -= 3) assign(w, log[k]!, log[k + 1]!, log[k + 2]!);
  w.log.length = 0;
}

/** Calls `fn` for every cell 4-next to `slot`'s territory that `slot` does not own (may repeat). */
function forEdge(owners: Owners, c: Census, slot: number, fn: (n: number) => void): void {
  for (let y = c.y0[slot]!; y <= c.y1[slot]!; y++) {
    for (let x = c.x0[slot]!; x <= c.x1[slot]!; x++) {
      const i = y * COLS + x;
      if (owners[i] !== slot) continue;
      forNeighbours4(i, (n) => {
        if (owners[n] !== slot) fn(n);
      });
    }
  }
}

/** The nearest source of `slot` seen from cell `n` (through its 8 neighbours), or -1. */
function nearestSource(field: Field, slot: number, n: number): { d: number; source: number } {
  let d = Infinity;
  let source = -1;
  forNeighbours8(n, (m) => {
    if (field.owners[m] !== slot) return;
    const dd = dist(n, field.sources[m]!);
    if (dd < d) {
      d = dd;
      source = field.sources[m]!;
    }
  });
  return { d, source };
}

const RING = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
] as const;

/**
 * Can `slot` lose cell `i` without falling apart? True when its straight neighbours of `i`
 * stay connected around it (blobs are connected edge to edge). A pushed blob that bulges into
 * a third blob never cuts that one in two.
 */
function canLose(owners: Owners, i: number, slot: number): boolean {
  const x = i % COLS;
  const y = (i - x) / COLS;
  const own: boolean[] = RING.map(([dx, dy]) => {
    const xx = x + dx;
    const yy = y + dy;
    return xx >= 0 && xx < COLS && yy >= 0 && yy < ROWS && owners[yy * COLS + xx] === slot;
  });
  const seen = new Array<boolean>(8).fill(false);
  let groups = 0;
  // Start from the straight neighbours (odd ring positions); corners only link them.
  for (let k = 1; k < 8; k += 2) {
    if (!own[k] || seen[k]) continue;
    groups++;
    const stack = [k];
    seen[k] = true;
    while (stack.length) {
      const j = stack.pop()!;
      for (let m = 0; m < 8; m++) {
        if (!own[m] || seen[m]) continue;
        if (Math.abs(RING[m]![0] - RING[j]![0]) + Math.abs(RING[m]![1] - RING[j]![1]) !== 1) continue;
        seen[m] = true;
        stack.push(m);
      }
    }
  }
  return groups <= 1;
}

/**
 * A blob only loses an edge cell where it is at least this many cells deep straight behind it
 * (counting the cell): squeezed blobs stay at least three cells wide, never threads.
 */
const DEEP = 4;

/**
 * Is `slot` deep behind cell `i`, seen from `from` (the blob taking it)? On every axis where
 * `from` touches `i` from one side, `slot` must continue for DEEP cells (counting `i`) on the
 * other side: a flat edge can be eaten away, a thin band cannot, from whatever angle it is
 * attacked. (Where `from` holds both sides, the cell is a notch and may always be filled.)
 */
function deepBehind(owners: Owners, i: number, slot: number, from: number): boolean {
  const x = i % COLS;
  const y = (i - x) / COLS;
  const run = (dx: number, dy: number) => {
    let n = 0;
    for (let k = 0; k < DEEP; k++) {
      const xx = x + dx * k;
      const yy = y + dy * k;
      if (xx < 0 || yy < 0 || xx >= COLS || yy >= ROWS || owners[yy * COLS + xx] !== slot) break;
      n++;
    }
    return n;
  };
  const touches = (dx: number, dy: number) => {
    const xx = x + dx;
    const yy = y + dy;
    return xx >= 0 && yy >= 0 && xx < COLS && yy < ROWS && owners[yy * COLS + xx] === from;
  };
  let any = false;
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    if (!touches(-dx, -dy)) continue;
    any = true;
    // Held from both sides on this axis: the cell is a notch in `from`, filling it thins nothing.
    if (touches(dx, dy)) continue;
    if (run(dx, dy) < DEEP) return false;
  }
  return any;
}

/** Can blob `o` give up cell `i` to `from` without falling apart or wearing down to a thread? */
const canGive = (owners: Owners, i: number, o: number, from: number) => canLose(owners, i, o) && deepBehind(owners, i, o, from);

/** How far a push may travel: the blob pushed, the one it pushes, and one more. */
const MAX_CHAIN = 3;
/** Directions a pushed blob tries, relative to the push: straight on first, then a little aside. */
const ANGLES = [0, 0.6, -0.6];

/** How far (cells) around the exit point a pushed blob looks for the best place to bulge. */
const SPREAD = 3;

/**
 * Where `slot` should bulge near `exit` (the first cell beyond it along a push): the free or
 * winnable cell that its own cells hold best (a notch, a flat stretch of edge), near the exit.
 * -1 when there is none.
 */
function bulge(w: Work, slot: number, exit: number, chain: number[], beats: (a: number, b: number) => boolean, minCells: number): number {
  const { owners } = w.field;
  const ex = exit % COLS;
  const ey = (exit - ex) / COLS;
  let best = -1;
  let bestScore = -Infinity;
  for (let y = Math.max(0, ey - SPREAD); y <= Math.min(ROWS - 1, ey + SPREAD); y++) {
    for (let x = Math.max(0, ex - SPREAD); x <= Math.min(COLS - 1, ex + SPREAD); x++) {
      const i = y * COLS + x;
      const o = owners[i]!;
      if (o === slot) continue;
      if (o !== EMPTY && (chain.length >= MAX_CHAIN || chain.includes(o) || !beats(chain[0]!, o) || w.c.area[o]! <= minCells || !canGive(owners, i, o, slot))) continue;
      let sides = 0;
      let held = 0;
      forNeighbours4(i, (m) => {
        if (owners[m] === slot) sides++;
      });
      if (sides === 0) continue;
      forNeighbours8(i, (m) => {
        if (owners[m] === slot) held++;
      });
      if (held < 3) continue;
      const score = held + sides - 0.4 * Math.hypot(x - ex, y - ey) - (o === EMPTY ? 0 : 1);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
  }
  return best;
}

/**
 * `slot` was pushed out of cell `at` in direction (dx, dy) by `chain`'s last blob. It gives
 * way along that line: it gains the first cell beyond its far side (open space, or a cell of a
 * blob the original pusher `chain[0]` beats, which is then pushed on in turn). Tries a slightly
 * different angle when the way is blocked. Returns the blob that ended up compressed (nowhere
 * to go), or EMPTY when the push ended in open space.
 */
function giveWay(w: Work, slot: number, at: number, dx: number, dy: number, chain: number[], beats: (a: number, b: number) => boolean, minCells: number): number {
  const { field, c } = w;
  const { owners } = field;
  if (c.area[slot]! <= 0) return slot;
  for (const angle of ANGLES) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;
    let x = (at % COLS) + 0.5;
    let y = Math.floor(at / COLS) + 0.5;
    let last = at;
    for (let step = 0; step < 2 * (COLS + ROWS); step++) {
      x += rx * 0.5;
      y += ry * 0.5;
      if (x < 0 || y < 0 || x >= COLS || y >= ROWS) break; // the wall
      const i = Math.floor(y) * COLS + Math.floor(x);
      if (i === last) continue;
      last = i;
      if (owners[i] === slot) continue;
      // Out of the blob: it gives way here, at the best-held cell nearby, so pushes widen a
      // whole front instead of growing a finger.
      const target = bulge(w, slot, i, chain, beats, minCells);
      if (target < 0) break;
      const o = owners[target]!;
      assign(w, target, slot, nearestSource(field, slot, target).source);
      return o === EMPTY ? EMPTY : giveWay(w, o, target, rx, ry, [...chain, slot], beats, minCells);
    }
  }
  return slot;
}

/** A small binary min-heap of (score, cell). */
class Heap {
  private scores: number[] = [];
  private cells: number[] = [];
  get size(): number {
    return this.cells.length;
  }
  get topScore(): number {
    return this.scores[0]!;
  }
  push(score: number, cell: number): void {
    const s = this.scores;
    const c = this.cells;
    let i = c.length;
    s.push(score);
    c.push(cell);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (s[p]! <= score) break;
      s[i] = s[p]!;
      c[i] = c[p]!;
      i = p;
    }
    s[i] = score;
    c[i] = cell;
  }
  pop(): number {
    const s = this.scores;
    const c = this.cells;
    const top = c[0]!;
    const lastS = s.pop()!;
    const lastC = c.pop()!;
    const n = c.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let k = 2 * i + 1;
        if (k >= n) break;
        if (k + 1 < n && s[k + 1]! < s[k]!) k++;
        if (s[k]! >= lastS) break;
        s[i] = s[k]!;
        c[i] = c[k]!;
        i = k;
      }
      s[i] = lastS;
      c[i] = lastC;
    }
    return top;
  }
}

/** Head start (cells) for a cell in a notch of the edge, per side beyond two. */
const NOTCH = 0.6;
/** How far (cells) the order of equally near cells may override their distance. */
const TIE = 0.45;

export interface GrowOptions {
  /** Never grow beyond this many cells. */
  maxCells: number;
  rng: () => number;
  /** How hard a blob fights right now (e.g. recent pumping). Missing: nobody can take from anyone. */
  strength?: (slot: number) => number;
  /** A blob is never compressed below this many cells (default MIN_CELLS). */
  minCells?: number;
}

/** How much stronger a blob must be to take a neighbour's cell: keeps equal pumpers from flickering. */
export const EDGE = 1.25;

/**
 * Grow `slot` by up to `cells` cells. Returns how many it gained. A blob with no cells cannot
 * grow (respawn it first).
 */
export function grow(field: Field, slot: number, cells: number, opts: GrowOptions): number {
  const { owners, sources, dented } = field;
  let slots = slot + 1;
  for (let i = 0; i < TOTAL; i++) if (owners[i]! >= slots) slots = owners[i]! + 1;
  const w: Work = { field, c: census(owners, slots), log: [] };
  const { c } = w;
  if (c.area[slot]! === 0) return 0;
  if (dented.delete(slot)) {
    // It lost ground: from now on it grows outward from the shape it has.
    for (let i = 0; i < TOTAL; i++) if (owners[i] === slot) sources[i] = i;
  }
  const strength = opts.strength;
  const beats = (a: number, b: number) => (strength ? strength(a) > strength(b) * EDGE + 1e-9 : false);
  const minCells = opts.minCells ?? MIN_CELLS;
  const budget = Math.max(0, Math.min(cells, opts.maxCells - c.area[slot]!));
  const heap = new Heap();
  const phase = opts.rng();
  const best = new Float64Array(TOTAL).fill(Infinity);
  const key = new Float64Array(TOTAL).fill(Infinity);
  const from = new Int32Array(TOTAL).fill(-1);
  // A cell's key is its distance to the nearest source; claiming a cell can only lower its neighbours' keys.
  const sides = (n: number) => {
    let count = 0;
    forNeighbours4(n, (m) => {
      if (owners[m] === slot) count++;
    });
    return count;
  };
  const consider = (n: number) => {
    if (owners[n] === slot) return;
    const held = sides(n);
    if (held === 0) return;
    const { d: far, source } = nearestSource(field, slot, n);
    // Notches (cells held on three or four sides) go first: the edge stays clean.
    const d = far - NOTCH * Math.max(0, held - 2);
    if (source < 0 || d >= best[n]! - 1e-9) return;
    // Equally near cells come in order of direction, starting at a random angle each time: a
    // layer fills as one smooth arc going round, never as scattered specks or always the same side.
    const sx = source % COLS;
    const nx = n % COLS;
    const turn = Math.atan2((n - nx) / COLS - (source - sx) / COLS, nx - sx) / (2 * Math.PI) + 0.5;
    const k = d + TIE * ((turn + phase) % 1);
    best[n] = d;
    key[n] = k;
    from[n] = source;
    heap.push(k, n);
  };
  for (let y = c.y0[slot]!; y <= c.y1[slot]!; y++) {
    for (let x = c.x0[slot]!; x <= c.x1[slot]!; x++) {
      const i = y * COLS + x;
      if (owners[i] === slot) forNeighbours4(i, consider);
    }
  }
  let gained = 0;
  let pushed = false;
  while (gained < budget && heap.size > 0) {
    const k = heap.topScore;
    const n = heap.pop();
    if (k !== key[n] || owners[n] === slot) continue; // stale entry
    key[n] = Infinity; // whatever happens, this entry is used up
    best[n] = Infinity;
    const o = owners[n]!;
    if (o === EMPTY) assign(w, n, slot, from[n]!);
    else {
      if (!beats(slot, o)) continue; // it holds its ground
      if (!canGive(owners, n, o, slot)) continue; // never cut a blob in two or wear it thin (maybe later, from another side)
      let held = 0;
      forNeighbours8(n, (m) => {
        if (owners[m] === slot) held++;
      });
      if (held < 3) continue; // a fight advances as a front, not as spikes
      w.log.length = 0;
      assign(w, n, slot, from[n]!);
      // Push outward: from the point this cell's growth is measured from, through the cell.
      const sx = from[n]! % COLS;
      const sy = Math.floor(from[n]! / COLS);
      const nx = n % COLS;
      const ny = Math.floor(n / COLS);
      const len = Math.hypot(nx - sx, ny - sy) || 1;
      const squashed = giveWay(w, o, n, (nx - sx) / len, (ny - sy) / len, [slot], beats, minCells);
      if (squashed !== EMPTY && c.area[squashed]! < minCells) {
        undo(w);
        continue;
      }
      pushed = true;
    }
    w.log.length = 0;
    gained++;
    // Cells next to this one may now be reachable or nearer (diagonal ones only once they touch).
    forNeighbours8(n, consider);
  }
  if (pushed) tidy(field);
  smoothEdges(w, slot, minCells, opts.maxCells);
  return gained;
}

/**
 * Every blob is one piece: anything cut off from a blob's largest piece (pushes never do this,
 * but stay safe) joins whoever surrounds it most (another blob, or open space).
 */
export function tidy(field: Field): void {
  const { owners, sources } = field;
  const label = new Int32Array(TOTAL).fill(-1);
  const queue = new Int32Array(TOTAL);
  const pieces: { owner: number; start: number; size: number }[] = [];
  const largest = new Map<number, number>();
  for (let i = 0; i < TOTAL; i++) {
    const o = owners[i]!;
    if (o === EMPTY || label[i] !== -1) continue;
    const id = pieces.length;
    let head = 0;
    let tail = 0;
    queue[tail++] = i;
    label[i] = id;
    while (head < tail) {
      forNeighbours4(queue[head++]!, (n) => {
        if (owners[n] === o && label[n] === -1) {
          label[n] = id;
          queue[tail++] = n;
        }
      });
    }
    pieces.push({ owner: o, start: i, size: tail });
    const best = largest.get(o);
    if (best === undefined || pieces[best]!.size < tail) largest.set(o, id);
  }
  pieces.forEach((piece, id) => {
    if (largest.get(piece.owner) === id) return;
    const cells: number[] = [];
    const around = new Map<number, number>();
    for (let i = piece.start; i < TOTAL; i++) {
      if (label[i] !== id) continue;
      cells.push(i);
      forNeighbours4(i, (n) => {
        if (label[n] !== id) around.set(owners[n]!, (around.get(owners[n]!) ?? 0) + 1);
      });
    }
    let to = EMPTY;
    let most = 0;
    for (const [o, n] of around) {
      if (n > most) {
        most = n;
        to = o;
      }
    }
    for (const i of cells) {
      owners[i] = to;
      sources[i] = i;
      label[i] = -2;
    }
  });
}

/** Half-width (cells) of the window that decides whether a cell sticks out of its blob. */
const SMOOTH_REACH = 2;

/**
 * Clean up the edges: a cell that hardly belongs to its own blob any more (a spike, a single
 * jag) while one neighbour surrounds it goes to that neighbour, and a notch of open space
 * inside a blob is filled. Blobs stay one piece, at least `minCells` and at most `maxCells`;
 * thin strings survive, only their loose ends round off.
 */
function smoothEdges(w: Work, around: number, minCells: number, maxCells: number): void {
  const { field, c } = w;
  const { owners } = field;
  const window = (2 * SMOOTH_REACH + 1) ** 2 - 1;
  // Indexed by owner + 1 (open space is 0).
  const counts = new Int32Array(c.area.length + 1);
  const touched: number[] = [];
  // Where things changed: around the blob that grew (pushes reach a little beyond it).
  const margin = 2 * SPREAD + SMOOTH_REACH;
  const x0 = Math.max(0, c.x0[around]! - margin);
  const x1 = Math.min(COLS - 1, c.x1[around]! + margin);
  const y0 = Math.max(0, c.y0[around]! - margin);
  const y1 = Math.min(ROWS - 1, c.y1[around]! + margin);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * COLS + x;
      const a = owners[i]!;
      if (
        (x === 0 || owners[i - 1] === a) &&
        (x === COLS - 1 || owners[i + 1] === a) &&
        (y === 0 || owners[i - COLS] === a) &&
        (y === ROWS - 1 || owners[i + COLS] === a)
      ) {
        continue; // not on an edge
      }
      let mine = 0;
      for (let dy = -SMOOTH_REACH; dy <= SMOOTH_REACH; dy++) {
        for (let dx = -SMOOTH_REACH; dx <= SMOOTH_REACH; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx;
          const yy = y + dy;
          // Beyond the wall counts as the cell's own blob: edges along the frame stay put.
          const o = xx < 0 || yy < 0 || xx >= COLS || yy >= ROWS ? a : owners[yy * COLS + xx]!;
          if (o === a) mine++;
          else {
            if (counts[o + 1] === 0) touched.push(o + 1);
            counts[o + 1]!++;
          }
        }
      }
      let b = a;
      let most = 0;
      for (const k of touched) {
        if (counts[k]! > most) {
          most = counts[k]!;
          b = k - 1;
        }
        counts[k] = 0;
      }
      touched.length = 0;
      if (mine > window / 3) continue;
      if (b === a || most < window * 0.55) continue;
      if (a !== EMPTY && (!canLose(owners, i, a) || c.area[a]! <= minCells)) continue;
      if (b !== EMPTY) {
        let touches = false;
        forNeighbours4(i, (n) => {
          if (owners[n] === b) touches = true;
        });
        if (!touches || c.area[b]! >= maxCells) continue;
      }
      const source = b === EMPTY ? i : nearestSource(field, b, i).source;
      assign(w, i, b, source >= 0 ? source : i);
    }
  }
  w.log.length = 0;
}

/** Cells of slots not in `present` become empty (players who left). */
export function releaseAbsent(owners: Owners, present: Set<number>): void {
  for (let i = 0; i < TOTAL; i++) if (owners[i] !== EMPTY && !present.has(owners[i]!)) owners[i] = EMPTY;
}

/** A small deterministic PRNG for pure computations (e.g. upgrading old state in a view). */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
