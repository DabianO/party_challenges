import { describe, expect, it } from 'vitest';
import type { BlobFieldNode, InstanceContext, PlayerRef, TapPadNode, UINode } from '@challenge/contract';
import { walkUI } from '@challenge/contract';
import mod, { MIN_CELLS, SEED_CELLS, clearRadiusOf, colorFor, decode, decodeSources, encode, encodeSources, maxCellsOf, upgrade } from '../server/index.ts';
import { COLS, ROWS, TOTAL, areasOf, emptyField, emptyOwners, fieldOf, fillCircle, grow, seededRng, spawn, type Field } from '../server/territory.ts';

function fakeCtx(players: PlayerRef[], seed = 1) {
  const clock = { now: 1_700_000_000_000 };
  const rng = seededRng(seed);
  const ctx: InstanceContext = {
    gameId: 'g1',
    instanceId: 'i1',
    rng,
    now: () => clock.now,
    players: () => players,
    schedule: () => {},
    cancel: () => {},
    emit: () => {},
    mediaUrl: (ref) => ref,
  };
  return { ctx, clock };
}

const p = (id: string, name: string): PlayerRef => ({ id, displayName: name, connected: true });
const config = { points: 10, tapsToMax: 100, maxShare: 0.2 };

function find<T extends UINode['type']>(node: UINode, type: T): Extract<UINode, { type: T }> {
  let found: UINode | undefined;
  walkUI(node, (n) => {
    if (n.type === type) found ??= n;
  });
  return found as Extract<UINode, { type: T }>;
}

type S = ReturnType<typeof mod.createInstance>;
const pump = (state: S, ctx: InstanceContext, who: PlayerRef, taps: number): S => {
  expect(mod.validateAction!(state, who, { pump: taps }, ctx)).toEqual({ ok: true });
  return mod.onAction!(state, who, { pump: taps }, ctx);
};
const pumpMany = (state: S, ctx: InstanceContext, who: PlayerRef, taps: number): S => {
  for (let left = taps; left > 0; left -= 60) state = pump(state, ctx, who, Math.min(60, left));
  return state;
};
const cellsOf = (state: S, who: PlayerRef) => areasOf(decode(state.cells)).get(state.colors[who.id]!) ?? 0;

const shape = (owners: Int16Array, slot: number) => {
  let n = 0;
  let sx = 0;
  let sy = 0;
  let x0 = COLS;
  let x1 = -1;
  let y0 = Infinity;
  let y1 = -1;
  owners.forEach((o, i) => {
    if (o !== slot) return;
    const x = i % COLS;
    const y = Math.floor(i / COLS);
    n++;
    sx += x;
    sy += y;
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  });
  return { n, x: sx / n, y: sy / n, w: x1 - x0 + 1, h: y1 - y0 + 1, x0, x1 };
};

/** Edge-connected pieces of `slot`. */
function piecesOf(owners: Int16Array, slot: number): number {
  const seen = new Uint8Array(TOTAL);
  let pieces = 0;
  for (let i = 0; i < TOTAL; i++) {
    if (owners[i] !== slot || seen[i]) continue;
    pieces++;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      const x = c % COLS;
      for (const n of [x > 0 ? c - 1 : -1, x < COLS - 1 ? c + 1 : -1, c - COLS, c + COLS]) {
        if (n < 0 || n >= TOTAL || seen[n] || owners[n] !== slot) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
  }
  return pieces;
}

/** A field with rectangles: [slot, x0, y0, x1, y1] (inclusive). */
function boxes(...rects: [number, number, number, number, number][]): Field {
  const owners = emptyOwners();
  for (const [slot, ax, ay, bx, by] of rects) for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) owners[y * COLS + x] = slot;
  return fieldOf(owners);
}

describe('blob-war territory', () => {
  it('grows a fresh blob as a clean disc around its centre', () => {
    const field = emptyField();
    const center = spawn(field, 0, seededRng(5), 0);
    expect(grow(field, 0, 800, { maxCells: 10_000, rng: seededRng(5) })).toBe(800);
    const s = shape(field.owners, 0);
    const r = Math.sqrt(s.n / Math.PI);
    const cx = center % COLS;
    const cy = Math.floor(center / COLS);
    field.owners.forEach((o, i) => {
      const d = Math.hypot((i % COLS) - cx, Math.floor(i / COLS) - cy);
      if (o === 0) expect(d).toBeLessThan(r + 1); // nothing sticks out…
      else if (d < r - 1) throw new Error('hole inside the disc'); // …and nothing is missing
    });
  });

  it('keeps its shape while growing: a long blob stays long', () => {
    const field = boxes([0, 20, 30, 79, 37]); // 60 × 8
    expect(grow(field, 0, 500, { maxCells: 10_000, rng: seededRng(2) })).toBe(500);
    const s = shape(field.owners, 0);
    expect(s.w / s.h).toBeGreaterThan(2.5); // a disc would be 1
    expect(s.h).toBeGreaterThan(8);
  });

  it('grows on from a dented shape instead of refilling its old outline', () => {
    const field = emptyField();
    spawn(field, 0, seededRng(9), 0);
    grow(field, 0, 1200, { maxCells: 10_000, rng: seededRng(9) });
    const before = shape(field.owners, 0);
    // A bite out of its right side.
    const bite = Math.round(before.y) * COLS + before.x1;
    fillCircle(field.owners, bite, 9, -1);
    field.dented.add(0);
    grow(field, 0, 150, { maxCells: 10_000, rng: seededRng(9) });
    // Growth went all round, not just back into the bite: the bite is still there.
    expect(field.owners[bite - 3]).toBe(-1);
  });

  it('pushes a less active neighbour into open space, and only a less active one', () => {
    const field = boxes([0, 20, 25, 39, 44], [1, 40, 25, 59, 44]);
    const bea = shape(field.owners, 1);
    const strong = { maxCells: 10_000, rng: seededRng(3), strength: (s: number) => (s === 0 ? 10 : 0), minCells: 40 };
    expect(grow(field, 0, 300, strong)).toBe(300);
    const after = shape(field.owners, 1);
    expect(after.n).toBeGreaterThanOrEqual(bea.n - 10); // pushed, not shrunk: there was room (edge smoothing rounds its corners)
    expect(after.x).toBeGreaterThan(bea.x + 2); // moved away from Ada

    // Equally active neighbours hold their ground against each other.
    const held = shape(field.owners, 1).n;
    grow(field, 0, 300, { ...strong, strength: () => 5 });
    expect(Math.abs(shape(field.owners, 1).n - held)).toBeLessThanOrEqual(4); // ± edge smoothing
    expect(field.owners.filter((o) => o === 0).length).toBeGreaterThan(0);
  });

  it('takes ground from idle neighbours when the room is full, down to their minimum', () => {
    const field = boxes([0, 0, 0, COLS / 2 - 1, ROWS - 1], [1, COLS / 2, 0, COLS - 1, ROWS - 1]);
    const opts = { maxCells: 10_000, rng: seededRng(4), strength: (s: number) => (s === 0 ? 10 : 0), minCells: 300 };
    expect(grow(field, 0, 1000, opts)).toBe(1000);
    expect(areasOf(field.owners).get(1)).toBeLessThanOrEqual(TOTAL / 2 - 1000); // (smoothing trims the jagged front too)
    for (let k = 0; k < 10; k++) grow(field, 0, 1000, opts); // keeps pumping
    expect(areasOf(field.owners).get(1)).toBeGreaterThanOrEqual(299);
    expect(areasOf(field.owners).get(1)).toBeLessThan(1000); // a strip along the wall, not a thread
  });

  it('never squashes a newcomer seed: it starts at the minimum size', () => {
    const field = fieldOf(new Int16Array(TOTAL).fill(1));
    spawn(field, 0, seededRng(1), 0);
    const seed = areasOf(field.owners).get(0)!;
    expect(seed).toBeGreaterThanOrEqual(MIN_CELLS);
    grow(field, 1, 10, { maxCells: 100_000, rng: seededRng(4), strength: (s) => (s === 1 ? 100 : 0), minCells: MIN_CELLS });
    expect(areasOf(field.owners).get(0)).toBeGreaterThanOrEqual(MIN_CELLS);
  });

  it('keeps every blob in one visible piece when a newcomer cuts through it', () => {
    // A long blob across the room; the newcomer lands in the middle of the open space below it.
    const field = boxes([0, 0, 30, COLS - 1, 34], [1, 0, 0, COLS - 1, 3]);
    spawn(field, 2, seededRng(2), 25, MIN_CELLS);
    for (const slot of [0, 1]) {
      const cells = areasOf(field.owners).get(slot) ?? 0;
      expect(cells).toBeGreaterThanOrEqual(MIN_CELLS);
      expect(piecesOf(field.owners, slot)).toBe(1);
    }
    // Cut away completely: it still shows, at the edge of the circle.
    const swallowed = boxes([0, 50, 30, 60, 38]);
    spawn(swallowed, 1, () => 0.5, 200, MIN_CELLS); // a circle bigger than the room
    expect(areasOf(swallowed.owners).get(0)).toBeGreaterThanOrEqual(MIN_CELLS);
    expect(piecesOf(swallowed.owners, 0)).toBe(1);
  });

  it('never cuts a blob in two in a fight', () => {
    // Bea is a thin bar across Ada's way: Ada may dent it but not cut through.
    const field = boxes([0, 10, 20, 40, 50], [1, 41, 0, 44, ROWS - 1], [2, 45, 0, COLS - 1, ROWS - 1]);
    const opts = { maxCells: 100_000, rng: seededRng(6), strength: (s: number) => (s === 0 ? 50 : 0), minCells: MIN_CELLS };
    for (let k = 0; k < 20; k++) grow(field, 0, 100, opts);
    expect(piecesOf(field.owners, 1)).toBe(1);
    expect(piecesOf(field.owners, 2)).toBe(1);
  });
});

describe('blob-war', () => {
  it('has a consistent manifest: live actions, scored when closed', () => {
    expect(mod.manifest).toMatchObject({ id: 'blob-war', version: '1.5.0', category: 'creativity', apiVersion: '2', results: 'onClose' });
    expect(mod.manifest.capabilities).toContain('real-time-burst');
    expect(typeof mod.onPlayerJoin).toBe('function');
  });

  it('round-trips growth sources through the state', () => {
    const sources = new Int32Array(TOTAL).map((_, i) => (i * 7919) % TOTAL);
    expect(decodeSources(encodeSources(sources))).toEqual(sources);
  });

  it('gives every player a distinct colour and a seed blob when it opens', () => {
    expect(new Set(Array.from({ length: 40 }, (_, i) => colorFor(i))).size).toBe(40);
    const players = [p('a', 'Ada'), p('b', 'Bea'), p('c', 'Cyd')];
    const { ctx } = fakeCtx(players);
    const state = mod.onPhaseChange!(mod.createInstance(config, ctx), 'ACTIVE', ctx);
    expect(state.colors).toEqual({ a: 0, b: 1, c: 2 });
    const areas = areasOf(decode(state.cells));
    // A fresh blob is a disc of the minimum size: clearly visible from the start.
    expect([...areas.values()].every((n) => Math.abs(n - SEED_CELLS) < 12)).toBe(true);
    const field = mod.displayPanel!(state, ctx) as BlobFieldNode;
    expect(field).toMatchObject({ type: 'blob-field', fieldId: 'i1', mode: 'live', cols: COLS });
    expect(field.cells).toHaveLength(TOTAL);
    expect(field.blobs.map((b) => [b.id, b.slot, b.color])).toEqual([
      ['a', 0, colorFor(0)],
      ['b', 1, colorFor(1)],
      ['c', 2, colorFor(2)],
    ]);
    // The platform's player colour wins: the same colour as in the graphs.
    const coloured = players.map((x, i) => ({ ...x, color: ['#112233', '#445566', '#778899'][i] }));
    const { ctx: withColors } = fakeCtx(coloured);
    expect((mod.displayPanel!(state, withColors) as BlobFieldNode).blobs.map((b) => b.color)).toEqual(['#112233', '#445566', '#778899']);
    expect(find(mod.guestView(state, coloured[1]!, withColors).ui, 'tap-pad').color).toBe('#445566');
  });

  it('grows into empty space with every pump, up to the maximum share', () => {
    const players = [p('a', 'Ada')];
    const { ctx } = fakeCtx(players);
    let state = mod.onPhaseChange!(mod.createInstance(config, ctx), 'ACTIVE', ctx);
    const before = cellsOf(state, players[0]!);
    state = pump(state, ctx, players[0]!, 10);
    const per = (maxCellsOf(config) - SEED_CELLS) / config.tapsToMax;
    expect(Math.abs(cellsOf(state, players[0]!) - before - Math.floor(10 * per))).toBeLessThanOrEqual(3); // ± edge smoothing
    state = pumpMany(state, ctx, players[0]!, 400);
    expect(cellsOf(state, players[0]!)).toBe(maxCellsOf(config)); // capped
    expect(mod.validateAction!(state, players[0]!, { pump: 61 }, ctx)).toMatchObject({ ok: false });
  });

  it('is a fight: whoever keeps pumping takes ground from blobs that stopped', () => {
    const players = [p('a', 'Ada'), p('b', 'Bea'), p('c', 'Cyd'), p('d', 'Dex'), p('e', 'Eve'), p('f', 'Fin')];
    const { ctx, clock } = fakeCtx(players);
    const big = { ...config, maxShare: 0.5 };
    let state = mod.onPhaseChange!(mod.createInstance(big, ctx), 'ACTIVE', ctx);
    // Everyone pumps the room full.
    for (let round = 0; round < 12; round++) {
      for (const who of [...players].reverse()) state = pump(state, ctx, who, 20);
      clock.now += 1000;
    }
    expect(decode(state.cells).filter((o) => o === -1).length).toBeLessThan(TOTAL * 0.05);
    const ada = cellsOf(state, players[0]!);
    expect(ada).toBeLessThan(maxCellsOf(big) - 300);
    const others = players.slice(1).map((who) => cellsOf(state, who));
    // A minute later only Ada comes back and pumps.
    clock.now += 60_000;
    for (let round = 0; round < 20; round++) {
      state = pump(state, ctx, players[0]!, 15);
      clock.now += 300;
    }
    expect(cellsOf(state, players[0]!)).toBeGreaterThan(ada + 300);
    // Nobody was pushed below the minimum (a blob that never got bigger keeps what it had).
    players.slice(1).forEach((who, i) => expect(cellsOf(state, who)).toBeGreaterThanOrEqual(Math.min(others[i]!, MIN_CELLS - 1)));
    expect(players.slice(1).some((who, i) => cellsOf(state, who) < others[i]!)).toBe(true);
  });

  it('makes a newcomer clear a full-size circle around their blob; whoever pumps first fills it', () => {
    const players = [p('a', 'Ada'), p('b', 'Bea'), p('c', 'Cyd'), p('d', 'Dex')];
    const { ctx } = fakeCtx(players);
    let state = mod.onPhaseChange!(mod.createInstance({ ...config, maxShare: 0.3 }, ctx), 'ACTIVE', ctx);
    for (const who of players) state = pumpMany(state, ctx, who, 100);
    const held = players.map((who) => cellsOf(state, who));
    const empty = () => [...decode(state.cells)].filter((o) => o === -1).length;
    const emptyBefore = empty();

    const gus = p('g', 'Gus');
    players.push(gus);
    state = mod.onPlayerJoin!(state, gus, ctx);
    const r = clearRadiusOf({ ...config, maxShare: 0.3 });
    expect(empty()).toBeGreaterThan(emptyBefore); // a circle of room was cleared…
    const lost = players.slice(0, 4).map((who, i) => held[i]! - cellsOf(state, who));
    expect(lost.reduce((a, b) => a + b, 0)).toBeGreaterThan(0); // …out of the old blobs
    expect(state.dented.length).toBeGreaterThan(0); // they grow on from their dented shapes
    expect(cellsOf(state, gus)).toBeGreaterThan(0);
    expect(cellsOf(state, gus)).toBeLessThan(Math.PI * r * r);

    // Whoever lost most to the circle pumps first and takes the open room back.
    const dented = players[lost.indexOf(Math.max(...lost))]!;
    const before = cellsOf(state, dented);
    state = pumpMany(state, ctx, dented, 40);
    expect(cellsOf(state, dented)).toBeGreaterThan(before);
  });

  it('lets a blob that was squeezed out completely come back as a seed', () => {
    const players = [p('a', 'Ada')];
    const { ctx } = fakeCtx(players);
    let state = mod.onPhaseChange!(mod.createInstance(config, ctx), 'ACTIVE', ctx);
    state = { ...state, cells: encode(emptyOwners()) }; // Ada lost everything
    state = pump(state, ctx, players[0]!, 5);
    expect(cellsOf(state, players[0]!)).toBeGreaterThan(0);
  });

  it('upgrades v1.0 state (round blobs) to territory of the same size, and v1.1 state as it is', () => {
    const players = [p('a', 'Ada'), p('b', 'Bea')];
    const legacy = {
      config: { points: 10, tapsToMax: 100, maxShare: 0.2, leakPerMinute: 0 },
      colors: { a: 0, b: 1 },
      nextColor: 2,
      taps: { a: 100, b: 10 },
      air: { a: { value: 100, at: 0 }, b: { value: 10, at: 0 } },
      frozen: null,
    };
    const state = upgrade(legacy as never, players);
    expect(state.closed).toBe(false);
    const areas = areasOf(decode(state.cells));
    expect(areas.get(0)! / TOTAL).toBeCloseTo(0.2, 1);
    expect(areas.get(1)!).toBeLessThan(areas.get(0)!);
    expect(upgrade(legacy as never, players)).toEqual(state); // deterministic: views agree

    const { sources: _s, dented: _d, activity: _a, ...v11 } = state;
    const again = upgrade(v11 as never, players);
    expect(again.cells).toBe(state.cells);
    expect(again.activity).toEqual({});
    expect(decodeSources(again.sources)[123]).toBe(123); // grows from its shape as it is
  });

  it('moves a game from the 1.3 grid (112 × 70) onto the wider grid: shapes kept round, everyone visible', () => {
    // Two round blobs and a small one on the old grid.
    const OLD_COLS = 112;
    const old = new Array<string>(OLD_COLS * 70).fill('.');
    const disc = (slot: number, cx: number, cy: number, r: number) => {
      for (let y = 0; y < 70; y++) for (let x = 0; x < OLD_COLS; x++) if (Math.hypot(x - cx, y - cy) <= r) old[y * OLD_COLS + x] = String.fromCharCode(0x30 + slot);
    };
    disc(0, 30, 35, 20);
    disc(1, 80, 35, 15);
    disc(2, 56, 8, 4); // below the minimum once scaled down
    const players = [p('a', 'Ada'), p('b', 'Bea'), p('c', 'Cyd')];
    const v13 = { config, colors: { a: 0, b: 1, c: 2 }, nextColor: 3, taps: {}, cells: old.join(''), sources: '', dented: [], activity: {}, growth: {}, closed: false };
    const state = upgrade(v13 as never, players);
    expect(state.cells).toHaveLength(TOTAL);
    const owners = decode(state.cells);
    const areas = areasOf(owners);
    for (const slot of [0, 1, 2]) {
      expect(areas.get(slot)!).toBeGreaterThanOrEqual(MIN_CELLS);
      expect(piecesOf(owners, slot)).toBe(1);
    }
    // Scaled evenly: Ada's disc is still about as wide as it is tall.
    const ada = shape(owners, 0);
    expect(ada.w / ada.h).toBeGreaterThan(0.85);
    expect(ada.w / ada.h).toBeLessThan(1.15);
    // Open room at the sides to grow into, and the same result every time (views agree).
    expect(owners[28 * COLS]).toBe(-1);
    expect(owners[28 * COLS + COLS - 1]).toBe(-1);
    expect(upgrade(v13 as never, players)).toEqual(state);
    expect(upgrade(state, players)).toBe(state);
  });

  it('shows a phone pump, freezes when closed and scores territory', () => {
    const players = [p('a', 'Ada'), p('b', 'Bea'), p('c', 'Cyd')];
    const { ctx } = fakeCtx(players);
    let state = mod.onPhaseChange!(mod.createInstance(config, ctx), 'ACTIVE', ctx);
    state = pumpMany(state, ctx, players[0]!, 100);
    state = pumpMany(state, ctx, players[1]!, 45);
    const pad = find(mod.guestView(state, players[0]!, ctx).ui, 'tap-pad') as TapPadNode;
    expect(pad).toMatchObject({ action: 'pump', color: colorFor(0) });

    state = mod.onPhaseChange!(state, 'LOCKED', ctx);
    expect((mod.displayPanel!(state, ctx) as BlobFieldNode).mode).toBe('final');
    const frozen = state.cells;
    expect(pump(state, ctx, players[0]!, 10).cells).toBe(frozen); // no growth once closed
    const evaluation = mod.evaluate(state, [], ctx);
    expect(evaluation.shares.map((s) => s.playerId)).toEqual(['a', 'b', 'c']);
    const scores = mod.calculateScores(state, evaluation, ctx);
    expect(scores[0]).toMatchObject({ playerId: 'a', points: 10 });
    expect(scores.map((s) => s.playerId)).toEqual(['a', 'b']); // Cyd never pumped
    expect(scores[1]!.points).toBeGreaterThan(2);
    expect(scores[1]!.points).toBeLessThan(8);
  });

  it('presents the closing picture on one slide', () => {
    const players = [p('a', 'Ada'), p('b', 'Bea')];
    const { ctx } = fakeCtx(players);
    let state = mod.onPhaseChange!(mod.createInstance(config, ctx), 'ACTIVE', ctx);
    state = pump(state, ctx, players[0]!, 20);
    state = mod.onPhaseChange!(state, 'LOCKED', ctx);
    const slides = mod.presentation!(state, [], ctx);
    expect(slides).toHaveLength(1);
    const node = slides[0]!.steps[0]!;
    expect(find(node, 'blob-field')).toMatchObject({ mode: 'final', fieldId: 'i1' });
    expect(JSON.stringify(node)).toMatch(/Ada \d+(\.\d)?% · Bea/);
  });
});
