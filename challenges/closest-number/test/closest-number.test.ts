import { describe, expect, it } from 'vitest';
import type { InstanceContext, PlayerRef, Submission } from '@challenge/contract';
import mod from '../server/index.ts';

const players: PlayerRef[] = [
  { id: 'p1', displayName: 'Alice', connected: true },
  { id: 'p2', displayName: 'Bob', connected: true },
  { id: 'p3', displayName: 'Cara', connected: true },
  { id: 'p4', displayName: 'Dan', connected: true },
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

const config = { question: 'How many golf balls fit in a bus?', correctAnswer: 4711, unit: 'balls', timeLimit: 30, maxPoints: 10, scoring: 'ranked' as const };

const sub = (playerId: string, answer: number, submittedAt: number): Submission<{ answer: number }> => ({
  id: `s-${playerId}`,
  playerId,
  payload: { answer },
  startedAt: 0,
  submittedAt,
  judgements: [],
});

describe('closest-number', () => {
  it('has a consistent v2 manifest', () => {
    expect(mod.manifest).toMatchObject({ id: 'closest-number', version: '2.2.0', apiVersion: '2', results: 'onClose', resubmission: 'replace' });
    expect(mod.manifest.evaluation).toEqual({ mode: 'automatic' });
  });

  it('ranks guesses by distance when the challenge closes', () => {
    const state = mod.createInstance(config, ctx);
    const evaluation = mod.evaluate(state, [sub('p1', 3000, 1), sub('p2', 5000, 2), sub('p3', 4700, 3)], ctx);
    expect(evaluation.ranked.map((r) => [r.displayName, r.rank])).toEqual([['Cara', 1], ['Bob', 2], ['Alice', 3]]);
    expect(mod.calculateScores(state, evaluation, ctx).map((s) => s.points)).toEqual([10, 7, 3]);
  });

  it('presents the spread of guesses, then the real value, without names or points', () => {
    const state = mod.createInstance(config, ctx);
    expect(mod.presentation!(state, [], ctx)).toEqual([]);
    expect(mod.presentation!(state, [mod.evaluate(state, [], ctx)], ctx)).toEqual([]);
    const evaluation = mod.evaluate(state, [sub('p1', 1200, 1), sub('p2', 3000, 2), sub('p3', 5200, 3), sub('p4', 9800, 4)], ctx);
    const slides = mod.presentation!(state, [evaluation], ctx);
    expect(slides).toHaveLength(1);
    expect(slides[0]!.steps).toHaveLength(2);
    const [first, second] = slides[0]!.steps.map((s) => JSON.stringify(s));
    // Step 1: the question and the spread, not the answer.
    expect(first).toContain('How many golf balls fit in a bus?');
    expect(first).toContain('"distribution"');
    expect(first).toContain('1200 balls');
    expect(first).toContain('4100 balls'); // the middle guess
    expect(first).toContain('9800 balls');
    expect(first).not.toContain('4711');
    expect(first).not.toContain('"marker"');
    // Step 2: the same layout with the real value.
    expect(second).toContain('4711 balls');
    expect(second).toContain('"marker"');
    expect(second).toContain("the room's average was 89 balls off");
    for (const step of [first, second]) {
      for (const p of players) expect(step).not.toContain(p.displayName);
      expect(step).not.toMatch(/points|"ranking"|#\d|[Cc]losest/);
    }
    const kinds = (n: unknown) => (n as { children: { type: string }[] }).children.map((c) => c.type);
    expect(kinds(slides[0]!.steps[0])).toEqual(kinds(slides[0]!.steps[1]));
  });

  it('keeps one wild guess from squashing the rest of the spread', () => {
    const state = mod.createInstance({ ...config, correctAnswer: 137 }, ctx);
    const evaluation = mod.evaluate(state, [100, 120, 140, 160, 1_000_000].map((a, i) => sub(`p${i + 1}`, a, i)), ctx);
    type Dist = { type: string; columns: { label: string; count: number }[]; marker?: { at: number }; axis?: { end: string } };
    const dist = (step: unknown) => (step as { children: Dist[] }).children.find((c) => c.type === 'distribution')!;
    const revealed = dist(mod.presentation!(state, [evaluation], ctx)[0]!.steps[1]);
    expect(revealed.columns.length).toBeGreaterThan(3);
    expect(revealed.columns.map((c) => c.count).reduce((a, b) => a + b, 0)).toBe(5);
    expect(revealed.columns.at(-1)!.label).toMatch(/^≥ /);
    expect(revealed.axis!.end).toMatch(/^≥ /);
    expect(revealed.marker!.at).toBeGreaterThan(0.2);
    expect(revealed.marker!.at).toBeLessThan(0.8);
  });
});
