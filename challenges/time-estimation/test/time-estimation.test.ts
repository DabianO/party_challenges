import { describe, expect, it } from 'vitest';
import type { InstanceContext, PlayerRef, Submission } from '@challenge/contract';
import mod from '../server/index.ts';

const players: PlayerRef[] = [
  { id: 'p1', displayName: 'Ada', connected: true },
  { id: 'p2', displayName: 'Bea', connected: true },
];

const ctx: InstanceContext = {
  gameId: 'g1',
  instanceId: 'i1',
  rng: () => 0.5,
  now: () => 1_700_000_000_000,
  players: () => players,
  schedule: () => {},
  cancel: () => {},
  emit: () => {},
  mediaUrl: (ref) => ref,
};

const config = { targetSeconds: 45, maxPoints: 10, fullPointsMs: 500, zeroPointsMs: 10_000 };

const sub = (playerId: string, ms: number): Submission<{ clock: number }> => ({
  id: `s-${playerId}`,
  playerId,
  payload: { clock: ms },
  startedAt: 0,
  submittedAt: ms,
  judgements: [],
});

describe('time-estimation', () => {
  it('has a consistent manifest: automatic, immediate, one stop per attempt', () => {
    expect(mod.manifest).toMatchObject({ id: 'time-estimation', version: '1.1.0', apiVersion: '2', category: 'skill', results: 'immediate', resubmission: 'none' });
    expect(mod.manifest.evaluation).toEqual({ mode: 'automatic' });
  });

  it('never shows a clock', () => {
    const state = mod.createInstance(config, ctx);
    const json = JSON.stringify(mod.guestView(state, players[0]!, ctx).ui);
    expect(json).toContain('45 s');
    expect(json).toContain(JSON.stringify({ type: 'stopwatch', name: 'clock', hideAfterSeconds: 0 }));
    expect(JSON.stringify(mod.introView!(state, players[0]!, ctx))).toContain('No looking at a clock');
  });

  it('scores in seconds, not milliseconds', () => {
    const state = mod.createInstance(config, ctx);
    const pointsAt = (ms: number) => mod.evaluate(state, [sub('p1', ms)], ctx).points;
    // 10 points within 0.5 s, one point less every 0.95 s, 0 from 10 s off.
    expect([45_000, 45_500, 44_500, 46_449, 46_450, 50_000, 55_000, 30_000].map(pointsAt)).toEqual([10, 10, 10, 10, 9, 6, 0, 0]);
    const late = mod.evaluate(state, [sub('p1', 47_312)], ctx);
    expect(mod.calculateScores(state, late, ctx)).toEqual([{ playerId: 'p1', points: 9, reason: 'Stopped at 47.312 s, 2.3 s late' }]);
  });

  it('gives practice feedback and ranks by how close players came', () => {
    let state = mod.createInstance(config, ctx);
    state = mod.handleInput(state, players[0]!, { clock: 43_210 }, ctx);
    expect(mod.playerNote!(state, players[0]!, ctx)).toBe('43.210 s · 1.8 s early');
    state = mod.handleInput(state, players[0]!, { clock: 45_020 }, ctx);
    expect(mod.playerNote!(state, players[0]!, ctx)).toBe('45.020 s · spot on!');
    const evaluations = [mod.evaluate(state, [sub('p1', 48_000)], ctx), mod.evaluate(state, [sub('p2', 44_400)], ctx)];
    const json = JSON.stringify(mod.resultsView(state, evaluations, ctx).ui);
    expect(json).toMatch(/"name":"Bea","value":"44.400 s · 0.6 s early".*"name":"Ada","value":"48.000 s · 3.0 s late"/);
    expect(json).toContain('Average 1.8 s off');
  });

  it('presents when the room stopped, then the target, without names or points', () => {
    const state = mod.createInstance(config, ctx);
    expect(mod.presentation!(state, [], ctx)).toEqual([]);
    const evaluations = [mod.evaluate(state, [sub('p1', 48_000)], ctx), mod.evaluate(state, [sub('p2', 44_400)], ctx)];
    const slides = mod.presentation!(state, evaluations, ctx);
    expect(slides).toHaveLength(1);
    expect(slides[0]!.steps).toHaveLength(2);
    const [first, second] = slides[0]!.steps.map((s) => JSON.stringify(s));
    expect(first).toContain('"distribution"');
    expect(first).toContain('Earliest stop');
    expect(first).not.toContain('"marker"');
    expect(second).toContain('"marker"');
    expect(second).toContain('1 early · 1 late · on average 1.8 s off');
    for (const step of [first, second]) {
      for (const p of players) expect(step).not.toContain(p.displayName);
      expect(step).not.toMatch(/points|"ranking"|[Cc]losest/);
    }
  });
});
