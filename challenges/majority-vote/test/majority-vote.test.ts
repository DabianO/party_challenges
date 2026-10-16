import { describe, expect, it } from 'vitest';
import type { InstanceContext, PlayerRef, Submission } from '@challenge/contract';
import mod from '../server/index.ts';

const players: PlayerRef[] = [
  { id: 'p1', displayName: 'Alice', connected: true },
  { id: 'p2', displayName: 'Bob', connected: true },
  { id: 'p3', displayName: 'Cara', connected: true },
  { id: 'p4', displayName: 'Dan', connected: true },
  { id: 'p5', displayName: 'Eve', connected: false },
];

const T0 = 1_700_000_000_000;

function fakeCtx(rngSeq: number[] = [0.5]) {
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
    players: () => players,
    schedule: (tag, seconds, playerId) => scheduled.push({ tag, seconds, playerId }),
    cancel: (tag, playerId) => cancelled.push({ tag, playerId }),
    emit: (audience, payload) => emitted.push({ audience, payload }),
    mediaUrl: (ref) => ref,
  };
  return { ctx, clock, scheduled, cancelled, emitted };
}

const config = {
  question: 'Pineapple on pizza?',
  options: ['Yes', 'No', 'Only on Tuesdays'],
  timeLimit: 20,
  points: 5,
  mode: 'majority' as const,
  showLiveCounts: false,
};

const vote = (playerId: string, answer: unknown, submittedAt = T0 + 1000): Submission<{ answer: string }> => ({
  id: `s-${playerId}`,
  playerId,
  payload: { answer } as { answer: string },
  startedAt: T0,
  submittedAt,
  judgements: [],
});

describe('majority-vote', () => {
  it('has a consistent v2 manifest', () => {
    expect(mod.manifest.id).toBe('majority-vote');
    expect(mod.manifest.version).toBe('2.0.0');
    expect(mod.manifest.apiVersion).toBe('2');
    expect(mod.manifest.category).toBe('social');
    expect(mod.manifest.results).toBe('onClose');
    expect(mod.manifest.evaluation).toEqual({ mode: 'automatic' });
    expect(mod.manifest.resubmission).toBe('replace');
    expect(mod.manifest.capabilities).toEqual(expect.arrayContaining(['timer', 'anonymous', 'multiple-choice']));
  });

  it('schedules a per-player lock timer when the player starts', () => {
    const { ctx, scheduled } = fakeCtx();
    const state = mod.createInstance(config, ctx);
    expect(scheduled).toHaveLength(0);
    mod.onAttemptStart!(state, players[0]!, ctx);
    expect(scheduled).toEqual([{ tag: 'lock', seconds: 20, playerId: 'p1' }]);
    mod.onAttemptStart!(state, players[1]!, ctx);
    expect(scheduled[1]).toEqual({ tag: 'lock', seconds: 20, playerId: 'p2' });
  });

  it('validates input and allows changing a vote', () => {
    const { ctx } = fakeCtx();
    let state = mod.createInstance(config, ctx);
    const alice = players[0]!;
    expect(mod.validateInput(state, alice, { answer: 'A' }, ctx)).toEqual({ ok: true });
    expect(mod.validateInput(state, alice, { answer: 'C' }, ctx)).toEqual({ ok: true });
    expect(mod.validateInput(state, alice, { answer: 'D' }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, alice, { answer: 0 } as never, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, alice, {} as never, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, alice, null as never, ctx)).toMatchObject({ ok: false });
    state = mod.handleInput(state, alice, { answer: 'A' }, ctx);
    expect(mod.validateInput(state, alice, { answer: 'B' }, ctx)).toEqual({ ok: true });
    const next = mod.handleInput(state, alice, { answer: 'B' }, ctx);
    expect(next.votes).toEqual({ p1: 'B' });
    expect(state.votes).toEqual({ p1: 'A' }); // new state object, no mutation
  });

  it('scores the majority on close and produces statistics', () => {
    const { ctx } = fakeCtx();
    const state = mod.createInstance(config, ctx);
    const evaluation = mod.evaluate(state, [vote('p1', 'A'), vote('p2', 'B'), vote('p3', 'B'), vote('p4', 'C')], ctx);
    expect(evaluation.counts).toEqual({ A: 1, B: 2, C: 1 });
    expect(evaluation.winningIds).toEqual(['B']);
    expect(evaluation.unanimous).toBe(false);
    expect(evaluation.rows.map((r) => [r.displayName, r.vote, r.winner])).toEqual([
      ['Bob', 'B', true],
      ['Cara', 'B', true],
      ['Alice', 'A', false],
      ['Dan', 'C', false],
    ]);
    expect(mod.calculateScores(state, evaluation, ctx)).toEqual([
      { playerId: 'p2', points: 5, reason: 'With the majority (B)' },
      { playerId: 'p3', points: 5, reason: 'With the majority (B)' },
      { playerId: 'p1', points: 0, reason: 'Not with the majority (A)' },
      { playerId: 'p4', points: 0, reason: 'Not with the majority (C)' },
    ]);
    expect(mod.getStatistics(state, [evaluation], ctx)).toEqual({
      question: config.question,
      mode: 'majority',
      closed: true,
      votes: 4,
      options: [
        { id: 'A', text: 'Yes', count: 1, percent: 25, winner: false },
        { id: 'B', text: 'No', count: 2, percent: 50, winner: true },
        { id: 'C', text: 'Only on Tuesdays', count: 1, percent: 25, winner: false },
      ],
      winning: [{ id: 'B', text: 'No' }],
      tie: false,
      unanimous: false,
      scorers: 2,
    });
    expect(JSON.parse(JSON.stringify(evaluation))).toEqual(evaluation);
  });

  it('reports a minimal statistics shape before the vote is closed', () => {
    const { ctx } = fakeCtx();
    let state = mod.createInstance(config, ctx);
    state = mod.handleInput(state, players[0]!, { answer: 'A' }, ctx);
    expect(mod.getStatistics(state, [], ctx)).toEqual({ question: config.question, mode: 'majority', votes: 1, closed: false });
  });

  it('scores the minority among options that received votes', () => {
    const { ctx } = fakeCtx();
    const state = mod.createInstance({ ...config, mode: 'minority' }, ctx);
    const evaluation = mod.evaluate(state, [vote('p1', 'A'), vote('p2', 'A'), vote('p3', 'B')], ctx);
    expect(evaluation.winningIds).toEqual(['B']); // C had no votes and cannot "win"
    expect(mod.calculateScores(state, evaluation, ctx)).toEqual([
      { playerId: 'p3', points: 5, reason: 'With the minority (B)' },
      { playerId: 'p1', points: 0, reason: 'Not with the minority (A)' },
      { playerId: 'p2', points: 0, reason: 'Not with the minority (A)' },
    ]);
  });

  it('treats ties as all winning, detects unanimity and handles no votes', () => {
    const { ctx } = fakeCtx();
    const state = mod.createInstance(config, ctx);
    const tie = mod.evaluate(state, [vote('p1', 'A'), vote('p2', 'B')], ctx);
    expect(tie.winningIds).toEqual(['A', 'B']);
    expect(mod.calculateScores(state, tie, ctx).every((s) => s.points === 5)).toBe(true);
    expect(mod.getStatistics(state, [tie], ctx)).toMatchObject({ tie: true, unanimous: false });
    expect(JSON.stringify(mod.resultsView(state, [tie], ctx).ui)).toContain('(tie)');

    const unanimous = mod.evaluate(state, [vote('p1', 'C'), vote('p2', 'C')], ctx);
    expect(unanimous.unanimous).toBe(true);
    expect(JSON.stringify(mod.resultsView(state, [unanimous], ctx).ui)).toContain('Unanimous!');

    const empty = mod.evaluate(state, [], ctx);
    expect(empty.winningIds).toEqual([]);
    expect(empty.unanimous).toBe(false);
    expect(mod.calculateScores(state, empty, ctx)).toEqual([]);
    expect(JSON.stringify(mod.resultsView(state, [empty], ctx).ui)).toContain('No votes were cast');
  });

  it('only awards points to players still on the roster', () => {
    const { ctx } = fakeCtx();
    const state = mod.createInstance(config, ctx);
    const evaluation = mod.evaluate(state, [vote('p1', 'A'), vote('ghost', 'A')], ctx);
    expect(mod.calculateScores(state, evaluation, ctx).map((s) => s.playerId)).toEqual(['p1']);
  });

  it('mainView shows only the vote count by default and never individual votes', () => {
    const { ctx } = fakeCtx();
    let state = mod.createInstance(config, ctx);
    state = mod.handleInput(state, players[0]!, { answer: 'A' }, ctx);
    state = mod.handleInput(state, players[1]!, { answer: 'B' }, ctx);
    const json = JSON.stringify(mod.mainView!(state, ctx));
    expect(json).toContain('2 votes so far');
    expect(json).not.toContain('"bar-chart"');
    expect(json).not.toContain('Alice');
    expect(json).not.toContain('p1');
    expect(json).not.toContain('"success"');
  });

  it('mainView shows live aggregate counts when enabled', () => {
    const { ctx } = fakeCtx();
    let state = mod.createInstance({ ...config, showLiveCounts: true }, ctx);
    state = mod.handleInput(state, players[0]!, { answer: 'A' }, ctx);
    state = mod.handleInput(state, players[1]!, { answer: 'A' }, ctx);
    state = mod.handleInput(state, players[2]!, { answer: 'B' }, ctx);
    const json = JSON.stringify(mod.mainView!(state, ctx));
    expect(json).toContain('"bar-chart"');
    expect(json).toContain('"label":"A. Yes","value":2');
    expect(json).toContain('"label":"B. No","value":1');
    expect(json).toContain('3 votes so far');
    expect(json).not.toContain('Alice');
  });

  it('guestView offers choices with the current vote preselected and hides other votes', () => {
    const { ctx } = fakeCtx();
    let state = mod.createInstance(config, ctx);
    const open = mod.guestView(state, players[0]!, ctx);
    expect(open.canSubmit).toBe(true);
    expect(JSON.stringify(open.ui)).toContain('"choices"');
    expect(JSON.stringify(open.ui)).toContain('"submitOnSelect":true');
    expect(JSON.stringify(open.ui)).toContain('"tag":"lock"');
    state = mod.handleInput(state, players[0]!, { answer: 'B' }, ctx);
    state = mod.handleInput(state, players[1]!, { answer: 'C' }, ctx);
    const alice = mod.guestView(state, players[0]!, ctx);
    expect(alice.canSubmit).toBe(true); // resubmission: replace
    expect(JSON.stringify(alice.ui)).toContain('"value":"B"');
    expect(JSON.stringify(alice.ui)).not.toContain('"value":"C"');
    expect(alice.status).toContain('Voted B');
    const bob = mod.guestView(state, players[1]!, ctx);
    expect(JSON.stringify(bob.ui)).toContain('"value":"C"');
    expect(JSON.stringify(bob.ui)).not.toContain('"value":"B"');
    expect(JSON.stringify(mod.introView!(state, players[0]!, ctx))).toContain('anonymous');
  });

  it('resultsView waits for the host before the vote is closed', () => {
    const { ctx } = fakeCtx();
    const state = mod.createInstance(config, ctx);
    const pending = mod.resultsView(state, [], ctx);
    expect(JSON.stringify(pending.ui)).toContain('Waiting for the host to close the vote.');
    expect(pending.guestUi).toBeUndefined();
  });

  it('resultsView shows the chart, winners and who scored, and personalises guests', () => {
    const { ctx } = fakeCtx();
    const state = mod.createInstance(config, ctx);
    const evaluation = mod.evaluate(state, [vote('p1', 'A'), vote('p2', 'B'), vote('p3', 'B')], ctx);
    const results = mod.resultsView(state, [evaluation], ctx);
    const json = JSON.stringify(results.ui);
    expect(json).toContain('"percent":true');
    expect(json).toContain('Majority: B. No');
    expect(json).toContain('"label":"Bob"');
    expect(json).toContain('"label":"Cara"');
    expect(json).not.toContain('"label":"Alice"');
    expect(JSON.stringify(results.guestUi!(players[1]!))).toContain('With the majority!');
    const alice = JSON.stringify(results.guestUi!(players[0]!));
    expect(alice).toContain('Not with the majority');
    expect(alice).toContain('You voted A. Yes');
    expect(JSON.stringify(results.guestUi!(players[4]!))).toContain('did not vote');
  });
});
