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
    mediaUrl: (ref) => `https://cdn.test/${ref.replace('media://', '')}`,
  };
  return { ctx, clock, scheduled, cancelled, emitted };
}

const config = {
  image: 'media://table',
  viewSeconds: 10,
  question: 'How many red cups were on the table?',
  options: ['Two', 'Three', 'Four', 'Five'],
  correctIndex: 2,
  answerSeconds: 20,
  points: 10,
};

const sub = (playerId: string, answer: unknown, startedAt: number, elapsedMs = 15_000): Submission<{ answer: string }> => ({
  id: `s-${playerId}`,
  playerId,
  payload: { answer } as { answer: string },
  startedAt,
  submittedAt: startedAt + elapsedMs,
  judgements: [],
});

describe('image-memory', () => {
  it('has a consistent v2 manifest', () => {
    expect(mod.manifest.id).toBe('image-memory');
    expect(mod.manifest.version).toBe('2.0.0');
    expect(mod.manifest.apiVersion).toBe('2');
    expect(mod.manifest.evaluation).toEqual({ mode: 'automatic' });
    expect(mod.manifest.results).toBe('immediate');
    expect(mod.manifest.resubmission).toBe('none');
    expect(mod.manifest.capabilities).toEqual(expect.arrayContaining(['image', 'timer', 'multiple-choice']));
  });

  it('runs view → answer per player with hide then lock timers', () => {
    const { ctx, scheduled } = fakeCtx();
    const alice = players[0]!;
    let state = mod.createInstance(config, ctx);
    expect(scheduled).toHaveLength(0);
    expect(state.stage).toEqual({});
    state = mod.onAttemptStart!(state, alice, ctx);
    expect(state.stage.p1).toBe('view');
    expect(scheduled).toEqual([{ tag: 'hide', seconds: 10, playerId: 'p1' }]);
    state = mod.onTimer!(state, 'hide', ctx, 'p1');
    expect(state.stage.p1).toBe('answer');
    expect(scheduled).toEqual([
      { tag: 'hide', seconds: 10, playerId: 'p1' },
      { tag: 'lock', seconds: 20, playerId: 'p1' },
    ]);
    // Bob has not started: nothing changes for him, and a stray hide is ignored.
    expect(state.stage.p2).toBeUndefined();
    expect(mod.onTimer!(state, 'hide', ctx, 'p2')).toBe(state);
    expect(mod.onTimer!(state, 'hide', ctx, 'p1')).toBe(state);
    expect(scheduled).toHaveLength(2);
  });

  it('rejects answers while viewing, then validates letters', () => {
    const { ctx } = fakeCtx();
    const alice = players[0]!;
    let state = mod.createInstance(config, ctx);
    expect(mod.validateInput(state, alice, { answer: 'C' }, ctx)).toMatchObject({ ok: false, reason: /closed/i });
    state = mod.onAttemptStart!(state, alice, ctx);
    expect(mod.validateInput(state, alice, { answer: 'C' }, ctx)).toEqual({ ok: false, reason: 'Keep looking!' });
    state = mod.onTimer!(state, 'hide', ctx, 'p1');
    expect(mod.validateInput(state, alice, { answer: 'C' }, ctx)).toEqual({ ok: true });
    expect(mod.validateInput(state, alice, { answer: 'c' }, ctx)).toEqual({ ok: true });
    expect(mod.validateInput(state, alice, { answer: 'E' }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, alice, { answer: 2 } as never, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, alice, {} as never, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, alice, null as never, ctx)).toMatchObject({ ok: false });
    state = mod.handleInput(state, alice, { answer: 'c' }, ctx);
    expect(state.answers.p1).toBe('C');
    expect(mod.validateInput(state, alice, { answer: 'A' }, ctx)).toMatchObject({ ok: false, reason: /already/ });
    // Bob, still viewing, is independent of Alice's progress.
    state = mod.onAttemptStart!(state, players[1]!, ctx);
    expect(mod.validateInput(state, players[1]!, { answer: 'A' }, ctx)).toEqual({ ok: false, reason: 'Keep looking!' });
  });

  it('evaluates each submission, scores it and aggregates statistics', () => {
    const { ctx, clock } = fakeCtx();
    const t = clock.now;
    const state = mod.createInstance(config, ctx);
    const e1 = mod.evaluate(state, [sub('p1', 'C', t)], ctx);
    const e2 = mod.evaluate(state, [sub('p2', 'b', t + 1000)], ctx);
    const e3 = mod.evaluate(state, [sub('p3', 'C', t + 2000)], ctx);
    expect(e1).toEqual({ playerId: 'p1', displayName: 'Alice', answer: 'C', correct: true });
    expect(e2).toEqual({ playerId: 'p2', displayName: 'Bob', answer: 'B', correct: false });
    expect(mod.calculateScores(state, e1, ctx)).toEqual([{ playerId: 'p1', points: 10, reason: 'Correct' }]);
    expect(mod.calculateScores(state, e2, ctx)).toEqual([{ playerId: 'p2', points: 0, reason: 'Wrong (B)' }]);
    expect(mod.getStatistics(state, [e1, e2, e3], ctx)).toEqual({
      question: config.question,
      correctAnswer: 'C. Four',
      answers: 3,
      correctCount: 2,
      correctPercent: 67,
      perOption: [
        { letter: 'A', label: 'Two', count: 0, percent: 0 },
        { letter: 'B', label: 'Three', count: 1, percent: 33 },
        { letter: 'C', label: 'Four', count: 2, percent: 67 },
        { letter: 'D', label: 'Five', count: 0, percent: 0 },
      ],
    });
    expect(mod.getStatistics(state, [], ctx)).toMatchObject({ answers: 0, correctCount: 0, correctPercent: 0 });
    expect(JSON.parse(JSON.stringify(e1))).toEqual(e1);
  });

  it('clamps an out-of-range correctIndex to the last option', () => {
    const { ctx, clock } = fakeCtx();
    const state = mod.createInstance({ ...config, correctIndex: 42 }, ctx);
    expect(mod.evaluate(state, [sub('p1', 'D', clock.now)], ctx).correct).toBe(true);
    expect(mod.getStatistics(state, [], ctx).correctAnswer).toBe('D. Five');
  });

  it('guestView shows the image while viewing, then the hidden question, only for the current player', () => {
    const { ctx } = fakeCtx();
    const alice = players[0]!;
    const bob = players[1]!;
    let state = mod.createInstance(config, ctx);
    state = mod.onAttemptStart!(state, alice, ctx);
    const view = mod.guestView(state, alice, ctx);
    expect(view.canSubmit).toBe(false);
    expect(view.status).toBe('Keep looking!');
    let json = JSON.stringify(view.ui);
    expect(json).toContain('https://cdn.test/table');
    expect(json).toContain('"tag":"hide"');
    expect(json).not.toContain(config.question);
    expect(json).not.toContain('"choices"');

    state = mod.onTimer!(state, 'hide', ctx, 'p1');
    const answer = mod.guestView(state, alice, ctx);
    expect(answer.canSubmit).toBe(true);
    json = JSON.stringify(answer.ui);
    expect(json).toContain(config.question);
    expect(json).toContain('"hidden":true');
    expect(json).toContain('"tag":"lock"');
    expect(json).toContain('"choices"');
    expect(json).toContain('"submitOnSelect":true');
    expect(json).toContain('"id":"D"');
    expect(json).not.toMatch(/correct/i);

    state = mod.handleInput(state, alice, { answer: 'B' }, ctx);
    const done = mod.guestView(state, alice, ctx);
    expect(done.canSubmit).toBe(false);
    expect(JSON.stringify(done.ui)).toContain('Your answer: B. Three');

    // Bob starts later and sees the image, not Alice's answer.
    state = mod.onAttemptStart!(state, bob, ctx);
    const bobJson = JSON.stringify(mod.guestView(state, bob, ctx));
    expect(bobJson).toContain('"tag":"hide"');
    expect(bobJson).not.toContain('Your answer');
    expect(bobJson).not.toContain('Three');
  });

  it('mainView and introView reveal neither the image, the question nor the answer', () => {
    const { ctx } = fakeCtx();
    let state = mod.createInstance(config, ctx);
    state = mod.onAttemptStart!(state, players[0]!, ctx);
    state = mod.onTimer!(state, 'hide', ctx, 'p1');
    const main = JSON.stringify(mod.mainView!(state, ctx));
    expect(main).not.toContain('table');
    expect(main).not.toContain(config.question);
    expect(main).not.toContain('Four');
    expect(main).not.toMatch(/correct/i);
    const intro = JSON.stringify(mod.introView!(state, players[0]!, ctx));
    expect(intro).not.toContain('table');
    expect(intro).not.toContain('Four');
    expect(intro).toContain('10 seconds');
  });

  it('resultsView shows the image, the correct answer and a chart, personalised for guests', () => {
    const { ctx, clock } = fakeCtx();
    const state = mod.createInstance(config, ctx);
    const evaluations = [mod.evaluate(state, [sub('p1', 'C', clock.now)], ctx), mod.evaluate(state, [sub('p2', 'A', clock.now)], ctx)];
    const results = mod.resultsView(state, evaluations, ctx);
    const json = JSON.stringify(results.ui);
    expect(json).toContain('https://cdn.test/table');
    expect(json).toContain('C. Four');
    expect(json).toContain('"bar-chart"');
    expect(json).toContain('Got it right: Alice');
    expect(json).toContain('1 of 2 correct');
    const alice = JSON.stringify(results.guestUi!(players[0]!));
    expect(alice).toContain('Correct!');
    expect(alice).toContain('10 points');
    const bob = JSON.stringify(results.guestUi!(players[1]!));
    expect(bob).toContain('Wrong');
    expect(bob).toContain('You picked A. Two');
    expect(bob).toContain('0 points');
    expect(JSON.stringify(results.guestUi!(players[3]!))).toContain('did not answer');
    expect(JSON.stringify(mod.resultsView(state, [], ctx).ui)).toContain('No answers yet');
  });
});
