import { describe, expect, it } from 'vitest';
import type { InstanceContext, PlayerRef, Submission } from '@challenge/contract';
import mod from '../server/index.ts';

const players: PlayerRef[] = [
  { id: 'p1', displayName: 'Alice', connected: true },
  { id: 'p2', displayName: 'Bob', connected: true },
  { id: 'p3', displayName: 'Cara', connected: true },
  { id: 'p4', displayName: 'Dan', connected: false },
];

const T0 = 1_700_000_000_000;

function fakeCtx(rngSeq: number[] = [0.5], roster: PlayerRef[] = players) {
  const clock = { now: T0 };
  let i = 0;
  const scheduled: { tag: string; seconds: number; playerId?: string }[] = [];
  const cancelled: { tag: string; playerId?: string }[] = [];
  const emitted: { audience: string; payload: unknown }[] = [];
  const ctx: InstanceContext = {
    gameId: 'g1',
    instanceId: 'i1',
    rng: () => rngSeq[i++ % rngSeq.length]!,
    now: () => clock.now,
    players: () => roster,
    schedule: (tag, seconds, playerId) => scheduled.push({ tag, seconds, playerId }),
    cancel: (tag, playerId) => cancelled.push({ tag, playerId }),
    emit: (audience, payload) => emitted.push({ audience, payload }),
    mediaUrl: (ref) => ref,
  };
  return { ctx, clock, scheduled, cancelled, emitted };
}

const config = {
  question: 'Who will win the next challenge?',
  optionsSource: 'custom' as const,
  options: ['Red team', 'Blue team', 'Nobody'],
  timeLimit: 20,
  points: 10,
  allowMultipleOutcomes: false,
};

const predict = (playerId: string, answer: unknown, submittedAt = T0 + 1000): Submission<{ answer: string }> => ({
  id: `s-${playerId}`,
  playerId,
  payload: { answer } as { answer: string },
  startedAt: T0,
  submittedAt,
  judgements: [],
});

describe('prediction', () => {
  it('has a consistent v2 manifest with host resolution hooks', () => {
    expect(mod.manifest.id).toBe('prediction');
    expect(mod.manifest.version).toBe('2.1.0');
    expect(mod.manifest.apiVersion).toBe('2');
    expect(mod.manifest.results).toBe('onClose');
    expect(mod.manifest.evaluation).toEqual({ mode: 'automatic' });
    expect(mod.manifest.resubmission).toBe('replace');
    expect(mod.hostResolutionView).toBeTypeOf('function');
    expect(mod.applyHostResolution).toBeTypeOf('function');
  });

  it('freezes custom options with stable ids, or falls back to the players', () => {
    const { ctx } = fakeCtx();
    expect(mod.createInstance(config, ctx).options).toEqual([
      { id: 'o0', label: 'Red team' },
      { id: 'o1', label: 'Blue team' },
      { id: 'o2', label: 'Nobody' },
    ]);
    expect(mod.createInstance({ ...config, optionsSource: 'players' }, ctx).options).toEqual(players.map((p) => ({ id: p.id, label: p.displayName })));
    // Fewer than 2 custom options → use the players instead.
    expect(mod.createInstance({ ...config, options: ['Only one'] }, ctx).options.map((o) => o.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
    // Roster changes after creation do not shift the option list.
    const state = mod.createInstance({ ...config, optionsSource: 'players' }, ctx);
    const { ctx: later } = fakeCtx([0.5], players.slice(0, 2));
    expect(mod.guestView(state, players[0]!, later).ui).toMatchObject({ type: 'stack' });
    expect(state.options).toHaveLength(4);
  });

  it('schedules a per-player lock timer on start', () => {
    const { ctx, scheduled } = fakeCtx();
    const state = mod.createInstance(config, ctx);
    mod.onAttemptStart!(state, players[1]!, ctx);
    expect(scheduled).toEqual([{ tag: 'lock', seconds: 20, playerId: 'p2' }]);
  });

  it('validates predictions against the frozen option list', () => {
    const { ctx } = fakeCtx();
    let state = mod.createInstance(config, ctx);
    const alice = players[0]!;
    expect(mod.validateInput(state, alice, { answer: 'o0' }, ctx)).toEqual({ ok: true });
    expect(mod.validateInput(state, alice, { answer: 'o9' }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, alice, { answer: 'Red team' }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, alice, {} as never, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, alice, null as never, ctx)).toMatchObject({ ok: false });
    state = mod.handleInput(state, alice, { answer: 'o0' }, ctx);
    const next = mod.handleInput(state, alice, { answer: 'o1' }, ctx);
    expect(next.predictions).toEqual({ p1: 'o1' });
    expect(state.predictions).toEqual({ p1: 'o0' });
    const empty = mod.createInstance({ ...config, optionsSource: 'players' }, fakeCtx([0.5], []).ctx);
    expect(mod.validateInput(empty, alice, { answer: 'p1' }, ctx)).toMatchObject({ ok: false });
    expect(mod.guestView(empty, alice, ctx).canSubmit).toBe(false);
  });

  it('builds the distribution on close, then scores once the host resolves the outcome', () => {
    const { ctx } = fakeCtx();
    const state = mod.createInstance(config, ctx);
    const evaluation = mod.evaluate(state, [predict('p1', 'o0'), predict('p2', 'o1'), predict('p3', 'o0'), predict('p4', 'bogus')], ctx);
    expect(evaluation.distribution).toEqual({ o0: 2, o1: 1, o2: 0 });
    expect(evaluation.rows.map((r) => [r.displayName, r.answer])).toEqual([
      ['Alice', 'o0'],
      ['Bob', 'o1'],
      ['Cara', 'o0'],
    ]);
    expect(evaluation.outcome).toBeNull();
    expect(mod.calculateScores(state, evaluation, ctx)).toEqual([]); // unresolved → nothing yet

    const form = mod.hostResolutionView!(state, evaluation, ctx);
    const formJson = JSON.stringify(form.ui);
    expect(form.submitLabel).toBe('Resolve');
    expect(formJson).toContain('"name":"outcome"');
    expect(formJson).toContain('"multiple":false');
    expect(formJson).toContain('3 predictions were made.');
    expect(formJson).toContain('leave this until the event has happened');

    const rejected = mod.applyHostResolution!(state, evaluation, {}, ctx);
    expect(rejected.complete).toBe(false);
    expect(rejected.message).toBe('Pick at least one outcome');
    expect(mod.applyHostResolution!(state, evaluation, { outcome: 'nope' }, ctx).complete).toBe(false);

    const resolved = mod.applyHostResolution!(state, evaluation, { outcome: 'o0' }, ctx);
    expect(resolved.complete).toBe(true);
    expect(resolved.evaluation.outcome).toEqual(['o0']);
    expect(mod.calculateScores(state, resolved.evaluation, ctx)).toEqual([
      { playerId: 'p1', points: 10, reason: 'Predicted Red team' },
      { playerId: 'p3', points: 10, reason: 'Predicted Red team' },
    ]);
    expect(mod.getStatistics(state, [resolved.evaluation], ctx)).toEqual({
      question: config.question,
      predictions: 3,
      resolved: true,
      distribution: [
        { id: 'o0', label: 'Red team', count: 2, percent: 67 },
        { id: 'o1', label: 'Blue team', count: 1, percent: 33 },
        { id: 'o2', label: 'Nobody', count: 0, percent: 0 },
      ],
      outcome: ['Red team'],
      correct: 2,
      accuracyPercent: 67,
    });
    expect(JSON.parse(JSON.stringify(resolved.evaluation))).toEqual(resolved.evaluation);
  });

  it('keeps a single outcome unless several are allowed', () => {
    const { ctx } = fakeCtx();
    const single = mod.createInstance(config, ctx);
    const evaluation = mod.evaluate(single, [predict('p1', 'o0'), predict('p2', 'o1')], ctx);
    expect(mod.applyHostResolution!(single, evaluation, { outcome: ['o1', 'o0'] }, ctx).evaluation.outcome).toEqual(['o1']);

    const multi = mod.createInstance({ ...config, allowMultipleOutcomes: true }, ctx);
    expect(JSON.stringify(mod.hostResolutionView!(multi, evaluation, ctx).ui)).toContain('"multiple":true');
    const both = mod.applyHostResolution!(multi, evaluation, { outcome: ['o1', 'o0', 'o0', 'zzz'] }, ctx);
    expect(both.complete).toBe(true);
    expect(both.evaluation.outcome).toEqual(['o1', 'o0']);
    expect(mod.calculateScores(multi, both.evaluation, ctx).map((s) => s.playerId).sort()).toEqual(['p1', 'p2']);
    expect(mod.getStatistics(multi, [both.evaluation], ctx)).toMatchObject({ outcome: ['Blue team', 'Red team'], accuracyPercent: 100 });
  });

  it('statistics before close report only the prediction count', () => {
    const { ctx } = fakeCtx();
    let state = mod.createInstance(config, ctx);
    state = mod.handleInput(state, players[0]!, { answer: 'o2' }, ctx);
    expect(mod.getStatistics(state, [], ctx)).toEqual({ question: config.question, predictions: 1, resolved: false });
  });

  it('mainView shows only the number of predictions', () => {
    const { ctx } = fakeCtx();
    let state = mod.createInstance(config, ctx);
    state = mod.handleInput(state, players[0]!, { answer: 'o0' }, ctx);
    state = mod.handleInput(state, players[1]!, { answer: 'o1' }, ctx);
    const json = JSON.stringify(mod.mainView!(state, ctx));
    expect(json).toContain('2 predictions locked in');
    expect(json).not.toContain('"bar-chart"');
    expect(json).not.toContain('Alice');
    expect(json).not.toContain('o0');
    expect(json).not.toContain('Red team');
  });

  it('guestView shows only the current player’s prediction', () => {
    const { ctx } = fakeCtx();
    let state = mod.createInstance(config, ctx);
    state = mod.handleInput(state, players[0]!, { answer: 'o0' }, ctx);
    state = mod.handleInput(state, players[1]!, { answer: 'o2' }, ctx);
    const alice = mod.guestView(state, players[0]!, ctx);
    expect(alice.canSubmit).toBe(true);
    expect(JSON.stringify(alice.ui)).toContain('"value":"o0"');
    expect(JSON.stringify(alice.ui)).not.toContain('"value":"o2"');
    expect(JSON.stringify(alice.ui)).toContain('"tag":"lock"');
    expect(alice.status).toContain('Predicted Red team');
    const cara = mod.guestView(state, players[2]!, ctx);
    expect(JSON.stringify(cara.ui)).not.toContain('"value"');
    expect(cara.status).toBeUndefined();
    expect(JSON.stringify(mod.introView!(state, players[0]!, ctx))).toContain('secret');
  });

  it('resultsView waits for the outcome, then shares results and personalises them', () => {
    const { ctx } = fakeCtx();
    const state = mod.createInstance(config, ctx);
    expect(JSON.stringify(mod.resultsView(state, [], ctx).ui)).toContain('Waiting for the outcome.');
    const unresolved = mod.evaluate(state, [predict('p1', 'o0'), predict('p2', 'o1')], ctx);
    expect(JSON.stringify(mod.resultsView(state, [unresolved], ctx).ui)).toContain('Waiting for the outcome.');

    const resolved = mod.applyHostResolution!(state, unresolved, { outcome: 'o1' }, ctx).evaluation;
    const results = mod.resultsView(state, [resolved], ctx);
    const json = JSON.stringify(results.ui);
    expect(json).toContain('Blue team');
    expect(json).toContain('Called it: Bob');
    expect(json).toContain('1 of 2 correct');
    expect(json).toContain('"percent":true');
    expect(JSON.stringify(results.guestUi!(players[1]!))).toContain('You called it! +10 points');
    expect(JSON.stringify(results.guestUi!(players[0]!))).toContain('You predicted Red team');
    expect(JSON.stringify(results.guestUi!(players[2]!))).toContain('You did not predict');
  });
});
