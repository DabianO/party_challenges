import { describe, expect, it } from 'vitest';
import type { AimFieldNode, InstanceContext, PlayerRef } from '@challenge/contract';
import mod, { onTarget, spotFor } from '../server/index.ts';

function fakeCtx(players: PlayerRef[]) {
  let now = 1_700_000_000_000;
  const scheduled: { tag: string; seconds: number; playerId?: string }[] = [];
  const ctx: InstanceContext = {
    gameId: 'g1',
    instanceId: 'i1',
    rng: () => 0.5,
    now: () => now,
    players: () => players,
    schedule: (tag, seconds, playerId) => scheduled.push({ tag, seconds, playerId }),
    cancel: () => {},
    emit: () => {},
    mediaUrl: (ref) => ref,
  };
  return { ctx, scheduled, advance: (ms: number) => (now += ms) };
}

const ada: PlayerRef = { id: 'p1', displayName: 'Ada', connected: true };
const bea: PlayerRef = { id: 'p2', displayName: 'Bea', connected: true };

type State = ReturnType<typeof mod.createInstance>;

function act(state: State, ctx: InstanceContext, who: PlayerRef, aim: unknown): State {
  const payload = { aim };
  expect(mod.validateAction!(state, who, payload, ctx)).toEqual({ ok: true });
  return mod.onAction!(state, who, payload, ctx);
}

/** Presses that take the crosshair from where it is onto the balloon (one batch per axis). */
function steerOnto(state: State, ctx: InstanceContext, who: PlayerRef, step = 0.4): State {
  const b = state.balloon!;
  const dx = Math.round((b.x - state.crosshair.x) / step);
  const dy = Math.round((b.y - state.crosshair.y) / step);
  for (let left = dx; left !== 0; ) {
    const n = Math.max(-20, Math.min(20, left));
    state = act(state, ctx, who, { move: [n, 0] });
    left -= n;
  }
  for (let left = dy; left !== 0; ) {
    const n = Math.max(-20, Math.min(20, left));
    state = act(state, ctx, who, { move: [0, n] });
    left -= n;
  }
  return state;
}

/** An open instance with its first balloon up. */
function withBalloon(ctx: InstanceContext, config = {}): State {
  let state = mod.createInstance({ intervalMinutes: 5, pointsPerPop: 1, speed: 'normal', ...config }, ctx);
  state = mod.onPhaseChange!(state, 'ACTIVE', ctx);
  return mod.onTimer!(state, 'balloon', ctx);
}

describe('balloon-pop', () => {
  it('has a consistent manifest: live, scored when it closes', () => {
    expect(mod.manifest).toMatchObject({ id: 'balloon-pop', version: '1.2.0', apiVersion: '2', results: 'onClose', category: 'skill' });
    expect(mod.manifest.evaluation).toEqual({ mode: 'automatic' });
  });

  it('brings the first balloon one interval after opening, with the crosshair in the middle', () => {
    const { ctx, scheduled } = fakeCtx([ada]);
    let state = mod.createInstance({ intervalMinutes: 2 }, ctx);
    state = mod.onPhaseChange!(state, 'ACTIVE', ctx);
    expect(scheduled).toEqual([{ tag: 'balloon', seconds: 120, playerId: undefined }]);
    // Before the first balloon: the crosshair is already on the screen (and nothing else).
    const empty = mod.displayOverlay!(state, ctx) as AimFieldNode;
    expect(empty).toMatchObject({ type: 'aim-field', targets: [], crosshair: { x: 0.5, y: 0.5 } });
    expect(empty).not.toHaveProperty('home');
    expect(mod.displayBanner!(state, ctx)).toBeNull();
    state = mod.onTimer!(state, 'balloon', ctx);
    expect(state.balloon).toMatchObject({ id: 'b1' });
    expect(state.crosshair).toEqual({ x: 8, y: 4.5 });
    // Never right under the crosshair (this test's rng would put it there: the far corner instead).
    expect(Math.hypot(state.balloon!.x - 8, state.balloon!.y - 4.5)).toBeGreaterThanOrEqual(4);
    const overlay = mod.displayOverlay!(state, ctx) as AimFieldNode;
    expect(overlay.type).toBe('aim-field');
    expect(overlay.targets).toHaveLength(1);
    expect(overlay.crosshair).toEqual({ x: 0.5, y: 0.5 });
    expect(mod.displayBanner!(state, ctx)).toContain('balloon');
    // A timer while one is still up changes nothing.
    expect(mod.onTimer!(state, 'balloon', ctx)).toBe(state);
  });

  it('places balloons inside the field and away from wherever the crosshair is', () => {
    let seed = 1;
    const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 200; i++) {
      const crosshair = { x: rng() * 16, y: rng() * 9 };
      const p = spotFor(rng, crosshair);
      expect(p.x).toBeGreaterThanOrEqual(2);
      expect(p.x).toBeLessThanOrEqual(14);
      expect(p.y).toBeGreaterThanOrEqual(2);
      expect(p.y).toBeLessThanOrEqual(7.8);
      expect(Math.hypot(p.x - crosshair.x, p.y - crosshair.y)).toBeGreaterThanOrEqual(4);
    }
  });

  it('adds everyone’s presses up and keeps the crosshair on the field', () => {
    const { ctx } = fakeCtx([ada, bea]);
    let state = withBalloon(ctx);
    state = act(state, ctx, ada, { move: [0, -1] });
    state = act(state, ctx, bea, { move: [1, 0] });
    expect(state.crosshair.x).toBeCloseTo(8.4); // up + right: diagonal
    expect(state.crosshair.y).toBeCloseTo(4.1);
    state = act(state, ctx, ada, { move: [0, -2] });
    expect(state.crosshair.y).toBeCloseTo(3.3); // up + up: twice as far
    state = act(state, ctx, bea, { move: [-20, 20] });
    state = act(state, ctx, bea, { move: [-20, 20] });
    expect(state.crosshair).toEqual({ x: 0, y: 9 });
    const fast = withBalloon(ctx, { speed: 'fast' });
    expect(act(fast, ctx, ada, { move: [1, 0] }).crosshair.x).toBeCloseTo(8.65);
  });

  it('refuses anything but a fire or a small batch of whole presses', () => {
    const { ctx } = fakeCtx([ada]);
    const state = withBalloon(ctx);
    for (const aim of [{ move: [1.5, 0] }, { move: [21, 0] }, { move: [1] }, { fire: 'yes' }, 'up', null]) {
      expect(mod.validateAction!(state, ada, { aim }, ctx), JSON.stringify(aim)).toMatchObject({ ok: false });
    }
    expect(mod.validateInput(state, ada, {}, ctx)).toMatchObject({ ok: false });
  });

  it('pops for the first shot on the balloon: the crosshair stays, next balloon one interval later', () => {
    const { ctx, scheduled, advance } = fakeCtx([ada, bea]);
    let state = withBalloon(ctx);
    scheduled.length = 0;
    state = steerOnto(state, ctx, ada);
    expect(onTarget(state.crosshair, state.balloon!)).toBe(true);
    advance(12_000);
    state = act(state, ctx, bea, { fire: true });
    expect(state.balloon).toBeNull();
    const spot = state.crosshair;
    expect(spot).not.toEqual({ x: 8, y: 4.5 });
    expect(state.popped).toEqual([{ balloonId: 'b1', playerId: 'p2', displayName: 'Bea', ms: 12_000 }]);
    expect(scheduled.map((s) => [s.tag, s.seconds])).toEqual([
      ['balloon', 300],
      ['burst', 4],
    ]);
    // Ada was a moment too late: her shot flashes, but there is nothing to hit any more.
    state = act(state, ctx, ada, { fire: true });
    expect(state.popped).toHaveLength(1);
    expect(state.reload.p1).toBeUndefined();
    const overlay = mod.displayOverlay!(state, ctx) as AimFieldNode;
    expect(overlay.targets).toEqual([]);
    expect(overlay.bursts?.[0]).toMatchObject({ id: 'b1', text: 'Bea!' });
    expect(overlay.shot).toEqual({ id: 's2', x: spot.x / 16, y: spot.y / 9 });
    // Still steerable without a balloon.
    state = act(state, ctx, ada, { move: [0, 1] });
    expect(state.crosshair.y).toBeCloseTo(spot.y + 0.4);
    state = mod.onTimer!(state, 'burst', ctx);
    expect(mod.displayOverlay!(state, ctx)).toMatchObject({ targets: [], bursts: [] });
    expect(mod.playerNote!(state, bea, ctx)).toBe('You popped 1 balloon');
    state = mod.onTimer!(state, 'balloon', ctx);
    expect(state.balloon?.id).toBe('b2');
    expect(state.crosshair.y).toBeCloseTo(spot.y + 0.4); // a new balloon does not move it
  });

  it('leaves the crosshair wherever players put it', () => {
    const { ctx, scheduled } = fakeCtx([ada]);
    let state = withBalloon(ctx);
    scheduled.length = 0;
    state = act(state, ctx, ada, { move: [5, -5] });
    state = act(state, ctx, ada, { fire: true });
    // No timer brings it back anywhere; a timer left over from an older version changes nothing.
    expect(scheduled).toEqual([]);
    const left = state.crosshair;
    state = mod.onTimer!(state, 'home', ctx);
    expect(state.crosshair).toEqual(left);
  });

  it('makes a player reload after a miss, so hammering Shoot does not win', () => {
    const { ctx, advance } = fakeCtx([ada, bea]);
    let state = withBalloon(ctx);
    state = act(state, ctx, ada, { fire: true }); // in the middle, the balloon is in a corner: a miss
    expect(mod.guestView(state, ada, ctx).status).toBe('Missed! Reloading…');
    state = steerOnto(state, ctx, bea);
    state = act(state, ctx, ada, { fire: true }); // on target, but still reloading
    expect(state.balloon).not.toBeNull();
    advance(1_600);
    state = act(state, ctx, ada, { fire: true });
    expect(state.popped.map((p) => p.playerId)).toEqual(['p1']);
  });

  it('shows the pad on the phone, also while waiting for a balloon', () => {
    const { ctx } = fakeCtx([ada]);
    let state = mod.onPhaseChange!(mod.createInstance({}, ctx), 'ACTIVE', ctx);
    let json = JSON.stringify(mod.guestView(state, ada, ctx).ui);
    expect(json).toContain('"type":"d-pad"');
    expect(json).not.toContain('"disabled"');
    expect(json).toContain('"tag":"balloon"');
    expect(mod.validateAction!(state, ada, { aim: { move: [1, 0] } }, ctx)).toEqual({ ok: true });
    state = mod.onTimer!(state, 'balloon', ctx);
    json = JSON.stringify(mod.guestView(state, ada, ctx).ui);
    expect(json).toContain('Balloon up');
    expect(mod.guestView(state, ada, ctx).canSubmit).toBe(false);
  });

  it('scores the pops when it closes and presents them without points', () => {
    const { ctx } = fakeCtx([ada, bea]);
    let state = withBalloon(ctx, { pointsPerPop: 3 });
    for (const who of [ada, bea, ada]) {
      state = steerOnto(state, ctx, who);
      state = act(state, ctx, who, { fire: true });
      state = mod.onTimer!(state, 'balloon', ctx);
    }
    const evaluation = mod.evaluate(state, [], ctx);
    expect(mod.calculateScores(state, evaluation, ctx)).toEqual([
      { playerId: 'p1', points: 6, reason: 'Popped 2 balloons' },
      { playerId: 'p2', points: 3, reason: 'Popped 1 balloon' },
    ]);
    expect(mod.getStatistics(state, [evaluation], ctx)).toMatchObject({ balloons: 4, popped: 3, shooters: 2 });
    const slides = mod.presentation!(state, [evaluation], ctx);
    const json = JSON.stringify(slides);
    expect(json).toContain('3 balloons popped');
    expect(json).toContain('Popped by Ada, Bea');
    expect(json).not.toMatch(/point|pts/);
    expect(JSON.stringify(mod.resultsView(state, [evaluation], ctx).guestUi!(ada))).toContain('You popped 2 balloons!');
    expect(mod.presentation!(mod.createInstance({}, ctx), [{ pops: {}, popped: [] }], ctx)).toEqual([]);
    const missed = withBalloon(ctx);
    expect(JSON.stringify(mod.presentation!(missed, [{ pops: {}, popped: [] }], ctx))).toContain('1 balloon floated by. Nobody popped one!');
  });
});
