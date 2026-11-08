import { describe, expect, it } from 'vitest';
import type { InstanceContext, PlayerRef, Submission } from '@challenge/contract';
import mod from '../server/index.ts';

function fakeCtx(players: PlayerRef[]) {
  const clock = { now: 1_700_000_000_000 };
  const ctx: InstanceContext = {
    gameId: 'g1',
    instanceId: 'i1',
    rng: () => 0.5,
    now: () => clock.now,
    players: () => players,
    schedule: () => {},
    cancel: () => {},
    emit: () => {},
    mediaUrl: (ref) => ref,
  };
  return { ctx, clock };
}

const ada: PlayerRef = { id: 'p1', displayName: 'Ada', connected: true };
const bea: PlayerRef = { id: 'p2', displayName: 'Bea', connected: true };
const cyd: PlayerRef = { id: 'p3', displayName: 'Cyd', connected: true };

const config = { targetSeconds: 35, maxPoints: 10, fullPointsMs: 50, zeroPointsMs: 2000 };

/** A stop submitted `serverMs` after the attempt started, claiming `clock` ms on the phone. */
const sub = (playerId: string, startedAt: number, serverMs: number, clock: number): Submission<{ clock: number }> => ({
  id: `s-${playerId}`,
  playerId,
  payload: { clock },
  startedAt,
  submittedAt: startedAt + serverMs,
  judgements: [],
});

describe('stop-the-clock', () => {
  it('has a consistent manifest: automatic, immediate, one stop per attempt', () => {
    expect(mod.manifest).toMatchObject({ id: 'stop-the-clock', version: '1.2.0', apiVersion: '2', results: 'immediate', resubmission: 'none' });
    expect(mod.manifest.evaluation).toEqual({ mode: 'automatic' });
  });

  it('shows the target and a phone-timed stopwatch that stays visible (Time Estimation is the one without a clock)', () => {
    const { ctx } = fakeCtx([ada]);
    const view = mod.guestView(mod.createInstance(config, ctx), ada, ctx);
    expect(view.canSubmit).toBe(true);
    const json = JSON.stringify(view.ui);
    expect(json).toContain('35.000 s');
    expect(json).toContain(JSON.stringify({ type: 'stopwatch', name: 'clock' }));
    // Games from 1.0 still carry `hideAfterSeconds`: it is ignored.
    expect(JSON.stringify(mod.guestView(mod.createInstance({ ...config, hideAfterSeconds: 0 }, ctx), ada, ctx).ui)).not.toContain('hideAfterSeconds');
    expect(JSON.stringify(mod.introView!(mod.createInstance(config, ctx), ada, ctx))).toContain('You can see the clock all the way');
  });

  it('notes the server time of Start and accepts only that live action', () => {
    const { ctx, clock } = fakeCtx([ada]);
    let state = mod.onAttemptStart!(mod.createInstance(config, ctx), ada, ctx);
    expect(mod.validateAction!(state, ada, { clock: 'start' }, ctx)).toEqual({ ok: true });
    expect(mod.validateAction!(state, ada, { clock: 'stop' }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateAction!(state, ada, null, ctx)).toMatchObject({ ok: false });
    clock.now += 4_000;
    state = mod.onAction!(state, ada, { clock: 'start' }, ctx);
    expect(state.startedAt.p1).toBe(clock.now);
    // A replay starts without a Start time.
    expect(mod.onAttemptStart!(state, ada, ctx).startedAt.p1).toBeUndefined();
  });

  it('validates the submitted time', () => {
    const { ctx } = fakeCtx([ada]);
    const state = mod.createInstance(config, ctx);
    expect(mod.validateInput(state, ada, { clock: 35_012 }, ctx)).toEqual({ ok: true });
    for (const bad of [{ clock: -1 }, { clock: Number.NaN }, { clock: '35000' }, {}, null]) {
      expect(mod.validateInput(state, ada, bad as never, ctx)).toMatchObject({ ok: false });
    }
  });

  it('scores the phone’s time in whole-point steps, early or late alike', () => {
    const { ctx } = fakeCtx([ada]);
    const state = mod.createInstance(config, ctx);
    const pointsAt = (ms: number) => mod.evaluate(state, [sub('p1', 0, ms, ms)], ctx).points;
    // 10 points within 50 ms, then one point less every 195 ms, 0 from 2 s off.
    expect([35_000, 34_950, 35_050, 35_244, 35_245, 34_755, 36_000, 36_949, 36_950, 33_000, 20_000].map(pointsAt)).toEqual([10, 10, 10, 10, 9, 9, 6, 1, 1, 0, 0]);
    expect(mod.evaluate(state, [sub('p1', 0, 35_012, 35_012)], ctx)).toEqual({
      playerId: 'p1',
      displayName: 'Ada',
      elapsedMs: 35_012,
      offMs: 12,
      measuredBy: 'device',
      points: 10,
    });
  });

  it('uses the server’s time when the phone’s time is implausible', () => {
    const { ctx } = fakeCtx([ada]);
    let state = mod.createInstance(config, ctx);
    // Start tapped 3 s into the attempt; the stop arrives 36.4 s after that.
    state = { ...state, startedAt: { p1: 1_000 + 3_000 } };
    const close = mod.evaluate(state, [sub('p1', 1_000, 3_000 + 35_300, 35_000)], ctx);
    expect(close).toMatchObject({ elapsedMs: 35_000, measuredBy: 'device' }); // 300 ms of network jitter is fine
    const faked = mod.evaluate(state, [sub('p1', 1_000, 3_000 + 36_400, 35_000)], ctx);
    expect(faked).toMatchObject({ elapsedMs: 36_400, offMs: 1_400, measuredBy: 'server', points: 4 });
    expect(mod.calculateScores(state, faked, ctx)).toEqual([{ playerId: 'p1', points: 4, reason: 'Stopped at 36.400 s, 1.400 s late (timed by the server)' }]);
    // Without a Start action the attempt start is the server's reference.
    expect(mod.evaluate(mod.createInstance(config, ctx), [sub('p1', 1_000, 35_100, 35_000)], ctx)).toMatchObject({ measuredBy: 'device' });
  });

  it('gives practice feedback across replays', () => {
    const { ctx } = fakeCtx([ada]);
    let state = mod.createInstance(config, ctx);
    expect(mod.playerNote!(state, ada, ctx)).toBeNull();
    state = mod.handleInput(state, ada, { clock: 35_120 }, ctx);
    expect(mod.playerNote!(state, ada, ctx)).toBe('35.120 s · 120 ms late');
    state = mod.handleInput(state, ada, { clock: 33_500 }, ctx);
    expect(mod.playerNote!(state, ada, ctx)).toBe('33.500 s · 1.500 s early · best 120 ms late');
    state = mod.handleInput(state, ada, { clock: 35_000 }, ctx);
    expect(mod.playerNote!(state, ada, ctx)).toBe('35.000 s · spot on!');
  });

  it('ranks stops by how close they came and personalises results', () => {
    const { ctx } = fakeCtx([ada, bea, cyd]);
    const state = mod.createInstance(config, ctx);
    const evaluations = [
      mod.evaluate(state, [sub('p1', 0, 35_420, 35_420)], ctx),
      mod.evaluate(state, [sub('p2', 0, 34_990, 34_990)], ctx),
      mod.evaluate(state, [sub('p3', 0, 37_500, 37_500)], ctx),
    ];
    const results = mod.resultsView(state, evaluations, ctx);
    const rows = (results.ui as { children: { type: string; rows?: { name: string; value: string; points: number }[] }[] }).children.find((n) => n.type === 'ranking')!.rows!;
    expect(rows.map((r) => [r.name, r.value, r.points])).toEqual([
      ['Bea', '34.990 s · 10 ms early', 10],
      ['Ada', '35.420 s · 420 ms late', 9],
      ['Cyd', '37.500 s · 2.500 s late', 0],
    ]);
    const json = JSON.stringify(results.ui);
    expect(json).toContain('Closest 10 ms early');
    expect(json).toContain('1 early · 2 late');
    const adaView = JSON.stringify(results.guestUi!(ada));
    expect(adaView).toContain('#2 of 3');
    expect(adaView).toContain('9 of 10 points');
    expect(JSON.stringify(mod.resultsView(state, [], ctx).ui)).toContain('Nobody stopped the clock yet');
    expect(mod.getStatistics(state, evaluations, ctx)).toEqual({ stops: 3, early: 1, late: 2, averageOffMs: 977, closest: { name: 'Bea', offMs: -10 }, timedByServer: 0 });
  });

  it('presents when the room stopped the clock, then the target, without names or points', () => {
    const { ctx } = fakeCtx([ada, bea, cyd]);
    const state = mod.createInstance(config, ctx);
    expect(mod.presentation!(state, [], ctx)).toEqual([]);
    const evaluations = [
      mod.evaluate(state, [sub('p1', 0, 35_420, 35_420)], ctx),
      mod.evaluate(state, [sub('p2', 0, 34_990, 34_990)], ctx),
      mod.evaluate(state, [sub('p3', 0, 37_500, 37_500)], ctx),
    ];
    const slides = mod.presentation!(state, evaluations, ctx);
    expect(slides).toHaveLength(1);
    expect(slides[0]!.steps).toHaveLength(2);
    const [first, second] = slides[0]!.steps.map((step) => JSON.stringify(step));
    expect(first).toContain('"distribution"');
    expect(first).toContain('34.990 s');
    expect(first).toContain('37.500 s');
    expect(first).not.toContain('"marker"');
    expect(second).toContain('"marker"');
    expect(second).toContain('1 early · 2 late · on average 977 ms off');
    for (const step of [first, second]) {
      for (const p of [ada, bea, cyd]) expect(step).not.toContain(p.displayName);
      expect(step).not.toMatch(/points|"ranking"|[Cc]losest/);
    }
  });
});
