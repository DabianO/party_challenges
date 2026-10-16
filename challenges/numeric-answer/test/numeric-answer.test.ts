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
  question: 'How many legs does a spider have?',
  correctAnswer: 8,
  tolerance: 0,
  unit: 'legs',
  timeLimit: 20,
  points: 10,
};

const sub = (playerId: string, answer: unknown, startedAt: number, elapsedMs = 1000): Submission<{ answer: number }> => ({
  id: `s-${playerId}`,
  playerId,
  payload: { answer } as { answer: number },
  startedAt,
  submittedAt: startedAt + elapsedMs,
  judgements: [],
});

describe('numeric-answer', () => {
  it('has a consistent v2 manifest', () => {
    expect(mod.manifest.id).toBe('numeric-answer');
    expect(mod.manifest.version).toBe('2.0.0');
    expect(mod.manifest.apiVersion).toBe('2');
    expect(mod.manifest.evaluation).toEqual({ mode: 'automatic' });
    expect(mod.manifest.results).toBe('immediate');
    expect(mod.manifest.resubmission).toBe('replace');
    expect(mod.manifest.capabilities).toEqual(expect.arrayContaining(['timer', 'numeric-input', 'image']));
  });

  it('schedules the per-player lock timer on attempt start', () => {
    const { ctx, scheduled } = fakeCtx();
    let state = mod.createInstance(config, ctx);
    expect(scheduled).toHaveLength(0);
    state = mod.onAttemptStart!(state, players[1]!, ctx);
    expect(scheduled).toEqual([{ tag: 'lock', seconds: 20, playerId: 'p2' }]);
    expect(state.answers).toEqual({});
  });

  it('validates input and lets a player replace their answer', () => {
    const { ctx } = fakeCtx();
    const alice = players[0]!;
    let state = mod.onAttemptStart!(mod.createInstance(config, ctx), alice, ctx);
    expect(mod.validateInput(state, alice, { answer: 8 }, ctx)).toEqual({ ok: true });
    expect(mod.validateInput(state, alice, { answer: '8' } as never, ctx)).toEqual({ ok: true });
    expect(mod.validateInput(state, alice, { answer: -3.5 }, ctx)).toEqual({ ok: true });
    expect(mod.validateInput(state, alice, { answer: 'abc' } as never, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, alice, { answer: '' } as never, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, alice, { answer: Infinity }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, alice, { answer: 1e20 }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, alice, {} as never, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, alice, null as never, ctx)).toMatchObject({ ok: false });
    state = mod.handleInput(state, alice, { answer: 6 }, ctx);
    expect(state.answers.p1).toBe(6);
    expect(mod.validateInput(state, alice, { answer: 8 }, ctx)).toEqual({ ok: true });
    state = mod.handleInput(state, alice, { answer: '8' } as never, ctx);
    expect(state.answers.p1).toBe(8);
    expect(mod.guestView(state, alice, ctx).status).toMatch(/still change/);
    expect(mod.guestView(state, alice, ctx).canSubmit).toBe(true);
  });

  it('evaluates each submission, scores it and aggregates statistics', () => {
    const { ctx, clock } = fakeCtx();
    const t = clock.now;
    const state = mod.createInstance(config, ctx);
    const e1 = mod.evaluate(state, [sub('p1', 8, t)], ctx);
    const e2 = mod.evaluate(state, [sub('p2', 6, t + 5000)], ctx);
    const e3 = mod.evaluate(state, [sub('p3', 6, t + 9000)], ctx);
    const e4 = mod.evaluate(state, [sub('p4', '8', t + 20_000)], ctx);
    expect(e1).toEqual({ playerId: 'p1', displayName: 'Alice', answer: 8, correct: true, diff: 0 });
    expect(e2).toEqual({ playerId: 'p2', displayName: 'Bob', answer: 6, correct: false, diff: 2 });
    expect(e4).toMatchObject({ playerId: 'p4', displayName: 'Dan', answer: 8, correct: true });

    expect(mod.calculateScores(state, e1, ctx)).toEqual([{ playerId: 'p1', points: 10, reason: 'Correct' }]);
    expect(mod.calculateScores(state, e2, ctx)).toEqual([{ playerId: 'p2', points: 0, reason: '2 legs off' }]);

    expect(mod.getStatistics(state, [e1, e2, e3, e4], ctx)).toEqual({
      question: config.question,
      correctAnswer: 8,
      tolerance: 0,
      unit: 'legs',
      answers: 4,
      correctCount: 2,
      correctPercent: 50,
      wrongCount: 2,
      mostCommonWrong: { value: 6, count: 2 },
      average: 7,
    });
    expect(mod.getStatistics(state, [], ctx)).toMatchObject({ answers: 0, correctPercent: 0, mostCommonWrong: null, average: null });
    expect(JSON.parse(JSON.stringify(e1))).toEqual(e1);
  });

  it('applies an absolute tolerance', () => {
    const { ctx, clock } = fakeCtx();
    const state = mod.createInstance({ ...config, correctAnswer: 100, tolerance: 5 }, ctx);
    expect(mod.evaluate(state, [sub('p1', 95, clock.now)], ctx).correct).toBe(true);
    expect(mod.evaluate(state, [sub('p2', 105, clock.now)], ctx).correct).toBe(true);
    expect(mod.evaluate(state, [sub('p3', 106, clock.now)], ctx).correct).toBe(false);
    expect(JSON.stringify(mod.resultsView(state, [], ctx).ui)).toContain('100 legs (± 5 legs)');
  });

  it('mainView and introView never reveal the correct answer', () => {
    const { ctx } = fakeCtx();
    const state = mod.createInstance({ ...config, correctAnswer: 4711, media: 'media://pic' }, ctx);
    const main = JSON.stringify(mod.mainView!(state, ctx));
    expect(main).toContain(config.question);
    expect(main).not.toContain('4711');
    const intro = JSON.stringify(mod.introView!(state, players[0]!, ctx));
    expect(intro).not.toContain('4711');
  });

  it('guestView shows only the current player answer', () => {
    const { ctx } = fakeCtx();
    const alice = players[0]!;
    const bob = players[1]!;
    let state = mod.createInstance({ ...config, correctAnswer: 4711, media: 'media://pic' }, ctx);
    state = mod.onAttemptStart!(state, alice, ctx);
    state = mod.onAttemptStart!(state, bob, ctx);
    state = mod.handleInput(state, alice, { answer: 1234 }, ctx);
    state = mod.handleInput(state, bob, { answer: 9876 }, ctx);
    const aliceJson = JSON.stringify(mod.guestView(state, alice, ctx));
    expect(aliceJson).toContain('1234');
    expect(aliceJson).not.toContain('9876');
    expect(aliceJson).not.toContain('4711');
    expect(aliceJson).toContain('media://pic');
    expect(aliceJson).toContain('"timer"');
    expect(aliceJson).toContain('"number-input"');
    const bobJson = JSON.stringify(mod.guestView(state, bob, ctx));
    expect(bobJson).toContain('9876');
    expect(bobJson).not.toContain('1234');
  });

  it('resultsView lists winners and personalises guests', () => {
    const { ctx, clock } = fakeCtx();
    const state = mod.createInstance(config, ctx);
    const evaluations = [mod.evaluate(state, [sub('p1', 8, clock.now)], ctx), mod.evaluate(state, [sub('p2', 6, clock.now)], ctx)];
    const results = mod.resultsView(state, evaluations, ctx);
    const json = JSON.stringify(results.ui);
    expect(json).toContain('8 legs');
    expect(json).toContain('Alice');
    expect(json).toContain('"bar-chart"');
    expect(json).toContain('1 of 2 correct');
    expect(json).toContain('Average 7 legs');
    const alice = JSON.stringify(results.guestUi!(players[0]!));
    expect(alice).toContain('Correct!');
    expect(alice).toContain('10 points');
    const bob = JSON.stringify(results.guestUi!(players[1]!));
    expect(bob).toContain('Not quite');
    expect(bob).toContain('2 legs off');
    expect(JSON.stringify(results.guestUi!(players[3]!))).toContain('did not answer');
    expect(JSON.stringify(mod.resultsView(state, [], ctx).ui)).toContain('No answers yet');
  });
});
