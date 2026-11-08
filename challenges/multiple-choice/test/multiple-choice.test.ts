import { describe, expect, it } from 'vitest';
import type { InstanceContext, PlayerRef, Submission } from '@challenge/contract';
import mod from '../server/index.ts';

const players: PlayerRef[] = [
  { id: 'p1', displayName: 'Alice', connected: true },
  { id: 'p2', displayName: 'Bob', connected: true },
  { id: 'p3', displayName: 'Cara', connected: true },
  { id: 'p4', displayName: 'Dan', connected: false },
];

function fakeCtx(rngSeq: number[] = [0.5]) {
  const clock = { now: 1_700_000_000_000 };
  let i = 0;
  const scheduled: { tag: string; seconds: number; playerId?: string }[] = [];
  const cancelled: { tag: string; playerId?: string }[] = [];
  const emitted: { audience: string; payload: unknown }[] = [];
  const ctx: InstanceContext = {
    gameId: 'g1',
    instanceId: 'i1',
    rng: () => rngSeq[i++ % rngSeq.length]!,
    now: () => clock.now,
    players: () => players,
    schedule: (tag, seconds, playerId) => scheduled.push({ tag, seconds, playerId }),
    cancel: (tag, playerId) => cancelled.push({ tag, playerId }),
    emit: (audience, payload) => emitted.push({ audience, payload }),
    mediaUrl: (ref) => ref,
  };
  return { ctx, clock, scheduled, cancelled, emitted };
}

const config = {
  question: 'Capital of France?',
  options: ['Berlin', 'Paris', 'Madrid', 'Rome'],
  correctIndex: 1,
  timeLimit: 20,
  points: 10,
  speedBonus: true,
};

const sub = (playerId: string, answer: unknown, startedAt: number, elapsedMs: number): Submission<{ answer: string }> => ({
  id: `s-${playerId}`,
  playerId,
  payload: { answer } as { answer: string },
  startedAt,
  submittedAt: startedAt + elapsedMs,
  judgements: [],
});

describe('multiple-choice', () => {
  it('has a consistent v2 manifest', () => {
    expect(mod.manifest.id).toBe('multiple-choice');
    expect(mod.manifest.version).toBe('2.3.0');
    expect(mod.manifest.apiVersion).toBe('2');
    expect(mod.manifest.evaluation).toEqual({ mode: 'automatic' });
    expect(mod.manifest.results).toBe('immediate');
    expect(mod.manifest.resubmission).toBe('none');
    expect(mod.manifest.capabilities).toEqual(expect.arrayContaining(['timer', 'multiple-choice', 'image']));
  });

  it('schedules the per-player lock timer on attempt start, not on create', () => {
    const { ctx, scheduled } = fakeCtx();
    let state = mod.createInstance(config, ctx);
    expect(scheduled).toHaveLength(0);
    state = mod.onAttemptStart!(state, players[0]!, ctx);
    expect(scheduled).toEqual([{ tag: 'lock', seconds: 20, playerId: 'p1' }]);
    expect(state.picks).toEqual({});
  });

  it('validates input', () => {
    const { ctx } = fakeCtx();
    const alice = players[0]!;
    let state = mod.onAttemptStart!(mod.createInstance(config, ctx), alice, ctx);
    expect(mod.validateInput(state, alice, { answer: 'B' }, ctx)).toEqual({ ok: true });
    expect(mod.validateInput(state, alice, { answer: 'E' } as never, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, alice, { answer: 1 } as never, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, alice, null as never, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, alice, {} as never, ctx)).toMatchObject({ ok: false });
    state = mod.handleInput(state, alice, { answer: 'B' }, ctx);
    expect(state.picks.p1).toBe('B');
    expect(mod.validateInput(state, alice, { answer: 'A' }, ctx)).toMatchObject({ ok: false, reason: /already/ });
    // Other players are unaffected by Alice's pick.
    expect(mod.validateInput(state, players[1]!, { answer: 'A' }, ctx)).toEqual({ ok: true });
  });

  it('lets a replayed attempt answer again without touching other players', () => {
    const { ctx } = fakeCtx();
    const [alice, bob] = [players[0]!, players[1]!];
    let state = mod.onAttemptStart!(mod.createInstance(config, ctx), alice, ctx);
    state = mod.handleInput(state, alice, { answer: 'A' }, ctx);
    state = mod.handleInput(state, bob, { answer: 'C' }, ctx);
    state = mod.onAttemptStart!(state, alice, ctx);
    expect(state.picks).toEqual({ p2: 'C' });
    expect(mod.validateInput(state, alice, { answer: 'B' }, ctx)).toEqual({ ok: true });
  });

  it('evaluates each submission on its own, scores with a speed bonus and aggregates statistics', () => {
    const { ctx, clock } = fakeCtx();
    const t0 = clock.now;
    let state = mod.createInstance(config, ctx);
    state = mod.handleInput(state, players[0]!, { answer: 'B' }, ctx);
    state = mod.handleInput(state, players[1]!, { answer: 'B' }, ctx);
    state = mod.handleInput(state, players[2]!, { answer: 'A' }, ctx);

    const e1 = mod.evaluate(state, [sub('p1', 'B', t0, 2_000)], ctx); // fast + correct
    const e2 = mod.evaluate(state, [sub('p2', 'B', t0 + 60_000, 10_000)], ctx); // half time + correct, started later
    const e3 = mod.evaluate(state, [sub('p3', 'A', t0, 1_000)], ctx); // wrong

    expect(e1).toEqual({ playerId: 'p1', displayName: 'Alice', answer: 'B', correct: true, points: 14.5, elapsedMs: 2000 });
    expect(e2).toMatchObject({ playerId: 'p2', displayName: 'Bob', correct: true, points: 12.5, elapsedMs: 10_000 });
    expect(e3).toMatchObject({ playerId: 'p3', displayName: 'Cara', answer: 'A', correct: false, points: 0 });

    // Alice: 10 * (1 + 0.5 * 0.9) = 14.5; Bob: 10 * (1 + 0.5 * 0.5) = 12.5; Cara: 0
    expect(mod.calculateScores(state, e1, ctx)).toEqual([{ playerId: 'p1', points: 14.5, reason: 'Correct in 2.0s' }]);
    expect(mod.calculateScores(state, e2, ctx)).toEqual([{ playerId: 'p2', points: 12.5, reason: 'Correct in 10.0s' }]);
    expect(mod.calculateScores(state, e3, ctx)).toEqual([{ playerId: 'p3', points: 0, reason: 'Wrong (A)' }]);

    const stats = mod.getStatistics(state, [e1, e2, e3], ctx);
    expect(stats).toMatchObject({
      answers: 3,
      correctCount: 2,
      correctPercent: 67,
      correctAnswer: { id: 'B', text: 'Paris' },
      fastestCorrect: { name: 'Alice', ms: 2000 },
    });
    expect(stats.options).toEqual([
      { id: 'A', text: 'Berlin', count: 1, percent: 33, correct: false },
      { id: 'B', text: 'Paris', count: 2, percent: 67, correct: true },
      { id: 'C', text: 'Madrid', count: 0, percent: 0, correct: false },
      { id: 'D', text: 'Rome', count: 0, percent: 0, correct: false },
    ]);
    expect(mod.getStatistics(state, [], ctx)).toMatchObject({ answers: 0, correctCount: 0, correctPercent: 0, fastestCorrect: null });
    expect(JSON.parse(JSON.stringify(e1))).toEqual(e1);
  });

  it('awards flat points when the speed bonus is off', () => {
    const { ctx, clock } = fakeCtx();
    const state = mod.createInstance({ ...config, speedBonus: false }, ctx);
    const evaluation = mod.evaluate(state, [sub('p1', 'B', clock.now, 500)], ctx);
    expect(mod.calculateScores(state, evaluation, ctx)).toEqual([{ playerId: 'p1', points: 10, reason: 'Correct in 0.5s' }]);
  });

  it('treats an out-of-range correctIndex as "no correct answer"', () => {
    const { ctx, clock } = fakeCtx();
    const state = mod.createInstance({ ...config, correctIndex: 9 }, ctx);
    const evaluation = mod.evaluate(state, [sub('p1', 'B', clock.now, 500)], ctx);
    expect(evaluation.correct).toBe(false);
    expect(mod.calculateScores(state, evaluation, ctx)).toEqual([{ playerId: 'p1', points: 0, reason: 'Wrong (B)' }]);
    const results = mod.resultsView(state, [evaluation], ctx);
    expect(JSON.stringify(results.ui)).toContain('No correct answer');
  });

  it('mainView and introView never reveal the correct answer', () => {
    const { ctx } = fakeCtx();
    const state = mod.createInstance({ ...config, media: 'media://abc' }, ctx);
    const main = JSON.stringify(mod.mainView!(state, ctx));
    expect(main).toContain('Capital of France?');
    expect(main).not.toContain('Paris');
    expect(main).not.toMatch(/correct/i);
    const intro = JSON.stringify(mod.introView!(state, players[0]!, ctx));
    expect(intro).not.toContain('Paris');
    expect(intro).toContain('20 seconds');
  });

  it('guestView offers choices, then locks after the pick, and shows only the current player', () => {
    const { ctx } = fakeCtx();
    const alice = players[0]!;
    const bob = players[1]!;
    let state = mod.createInstance({ ...config, media: 'media://abc' }, ctx);
    state = mod.onAttemptStart!(state, alice, ctx);
    const open = mod.guestView(state, alice, ctx);
    expect(open.canSubmit).toBe(true);
    const json = JSON.stringify(open.ui);
    expect(json).toContain('"choices"');
    expect(json).toContain('"submitOnSelect":true');
    expect(json).toContain('"id":"D"');
    expect(json).toContain('"timer"');
    expect(json).toContain('media://abc');
    expect(json).not.toMatch(/correct/i);

    state = mod.handleInput(state, alice, { answer: 'C' }, ctx);
    const done = mod.guestView(state, alice, ctx);
    expect(done.canSubmit).toBe(false);
    expect(JSON.stringify(done.ui)).toContain('C. Madrid');

    // Bob's view does not show Alice's answer.
    state = mod.onAttemptStart!(state, bob, ctx);
    const bobView = mod.guestView(state, bob, ctx);
    expect(bobView.canSubmit).toBe(true);
    expect(JSON.stringify(bobView.ui)).not.toContain('Your answer');
    state = mod.handleInput(state, bob, { answer: 'A' }, ctx);
    // Alice's locked view shows her own pick only, never Bob's.
    expect(JSON.stringify(mod.guestView(state, alice, ctx).ui)).not.toContain('A. Berlin');
    expect(JSON.stringify(mod.guestView(state, alice, ctx).ui)).toContain('Your answer: C. Madrid');
  });

  it('resultsView highlights the correct answer, ranks by points and personalises guests', () => {
    const { ctx, clock } = fakeCtx();
    const t0 = clock.now;
    const state = mod.createInstance(config, ctx);
    const evaluations = [
      mod.evaluate(state, [sub('p3', 'A', t0, 1_000)], ctx),
      mod.evaluate(state, [sub('p1', 'B', t0, 2_000)], ctx),
      mod.evaluate(state, [sub('p2', 'B', t0, 10_000)], ctx),
    ];
    const results = mod.resultsView(state, evaluations, ctx);
    const json = JSON.stringify(results.ui);
    expect(json).toContain('B. Paris');
    expect(json).toContain('"bar-chart"');
    expect(json).toContain('"percent":true');
    expect(json).toContain('"ranking"');
    const ranking = (results.ui as { children: { type: string; rows?: { name: string }[] }[] }).children.find((n) => n.type === 'ranking');
    expect(ranking?.rows?.map((r) => r.name)).toEqual(['Alice', 'Bob', 'Cara']);
    const alice = JSON.stringify(results.guestUi!(players[0]!));
    expect(alice).toContain('Correct!');
    expect(alice).toContain('14.5 points');
    const cara = JSON.stringify(results.guestUi!(players[2]!));
    expect(cara).toContain('Wrong');
    expect(cara).toContain('A. Berlin');
    expect(JSON.stringify(results.guestUi!(players[3]!))).toContain('did not answer');
    // Before anyone finished, results are still renderable.
    expect(JSON.stringify(mod.resultsView(state, [], ctx).ui)).toContain('0 of 0 correct');
  });

  it('presents the question and the room’s answers, then reveals the right one, without names or points', () => {
    const { ctx, clock } = fakeCtx();
    const t0 = clock.now;
    const state = mod.createInstance({ ...config, media: 'media://flag' }, ctx);
    expect(mod.presentation!(state, [], ctx)).toEqual([]);
    const evaluations = [
      mod.evaluate(state, [sub('p3', 'A', t0, 1_000)], ctx),
      mod.evaluate(state, [sub('p1', 'B', t0, 2_000)], ctx),
      mod.evaluate(state, [sub('p2', 'B', t0, 10_000)], ctx),
    ];
    const slides = mod.presentation!(state, evaluations, ctx);
    expect(slides).toHaveLength(1);
    const [ask, reveal] = slides[0]!.steps.map((s) => JSON.stringify(s));
    expect(slides[0]!.steps).toHaveLength(2);
    expect(ask).toContain('Capital of France?');
    expect(ask).toContain('media://flag');
    expect(ask).toContain('"label":"B. Paris","value":2,"highlight":false');
    expect(ask).not.toContain('"highlight":true');
    expect(ask).toContain('3 answers');
    expect(reveal).toContain('"label":"B. Paris","value":2,"highlight":true');
    expect(reveal).toContain('2 of 3 right');
    const all = JSON.stringify(slides);
    for (const p of players) expect(all).not.toContain(p.displayName);
    expect(all).not.toMatch(/point|ranking|fastest/i);
    // No correct answer configured: the distribution only.
    const open = mod.createInstance({ ...config, correctIndex: 9 }, ctx);
    const openSlides = mod.presentation!(open, [mod.evaluate(open, [sub('p1', 'A', t0, 1_000)], ctx)], ctx);
    expect(openSlides[0]!.steps).toHaveLength(1);
    expect(JSON.stringify(openSlides)).not.toContain('"highlight":true');
  });
});
