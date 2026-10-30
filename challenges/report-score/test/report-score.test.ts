import { describe, expect, it } from 'vitest';
import type { InstanceContext, PlayerRef, Submission } from '@challenge/contract';
import mod, { overMessage } from '../server/index.ts';

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

const config = { prompt: 'How many points did you score at darts?', maxPoints: 20, penalty: 5 };

const sub = (playerId: string, value: number): Submission<{ value: number }> => ({
  id: `s-${playerId}-${value}`,
  playerId,
  payload: { value },
  startedAt: 0,
  submittedAt: 1,
  judgements: [],
});

/** One entry the way the engine runs it: start, validate, handle, evaluate. */
function enter(state: ReturnType<typeof mod.createInstance>, player: PlayerRef, value: number) {
  expect(mod.canStart!(state, player, ctx)).toMatchObject({ ok: true });
  expect(mod.validateInput(state, player, { value }, ctx)).toEqual({ ok: true });
  const next = mod.handleInput(state, player, { value }, ctx);
  const evaluation = mod.evaluate(next, [sub(player.id, value)], ctx);
  return { state: next, evaluation, scores: mod.calculateScores(next, evaluation, ctx) };
}

describe('report-score', () => {
  it('has a consistent manifest', () => {
    expect(mod.manifest).toMatchObject({ id: 'report-score', version: '1.0.0', apiVersion: '2', results: 'immediate', attempts: 'repeat', resubmission: 'none' });
    expect(mod.manifest.evaluation).toEqual({ mode: 'automatic' });
  });

  it('scores the number itself, then the player is done', () => {
    const { state, scores } = enter(mod.createInstance(config, ctx), players[0]!, 12);
    expect(scores).toEqual([{ playerId: 'p1', points: 12, reason: 'Reported score' }]);
    expect(mod.canStart!(state, players[0]!, ctx)).toEqual({ ok: false, reason: 'Your score: 12', finished: true });
    expect(mod.playerNote!(state, players[0]!, ctx)).toEqual({ text: 'Your score: 12', tone: 'success' });
    // The maximum itself is fine.
    expect(enter(mod.createInstance(config, ctx), players[0]!, 20).scores[0]!.points).toBe(20);
  });

  it('never mentions the penalty up front', () => {
    const state = mod.createInstance(config, ctx);
    const shown = JSON.stringify([mod.introView!(state, players[0]!, ctx), mod.guestView(state, players[0]!, ctx)]);
    expect(shown).toContain('Maximum 20');
    expect(shown).not.toMatch(/deduct|penalt|lose|cost/i);
  });

  it('deducts the penalty for a number above the maximum and closes it for that player', () => {
    let state = mod.createInstance(config, ctx);
    const over = enter(state, players[0]!, 25);
    state = over.state;
    expect(over.scores).toEqual([{ playerId: 'p1', points: -5, reason: '25 is above the maximum of 20' }]);
    const message = '25 is more than the maximum of 20. 5 points have been deducted from your total, and this challenge is now closed for you.';
    expect(overMessage(config, 25)).toBe(message);
    expect(mod.playerNote!(state, players[0]!, ctx)).toEqual({ text: message, tone: 'danger' });
    expect(mod.canStart!(state, players[0]!, ctx)).toEqual({ ok: false, reason: 'Closed for you', finished: true });
    expect(mod.closedFor!(state, ctx)).toEqual(['p1']);

    // The host opens it again: the deduction stays, and a valid number counts.
    state = mod.reopenFor!(state, players[0]!, ctx);
    expect(mod.closedFor!(state, ctx)).toEqual([]);
    expect(mod.playerNote!(state, players[0]!, ctx)).toBe('Open again: fill in your score');
    // Over again: closed again.
    state = enter(state, players[0]!, 100).state;
    expect(mod.closedFor!(state, ctx)).toEqual(['p1']);
    state = mod.reopenFor!(state, players[0]!, ctx);
    const valid = enter(state, players[0]!, 18);
    expect(valid.scores[0]!.points).toBe(18);
    expect(mod.playerNote!(valid.state, players[0]!, ctx)).toEqual({ text: 'Your score: 18 (−10 for going over the maximum)', tone: 'success' });
    expect(mod.canStart!(valid.state, players[0]!, ctx)).toMatchObject({ ok: false, finished: true });
    expect(mod.closedFor!(valid.state, ctx)).toEqual([]);
  });

  it('does not penalise mistypes', () => {
    const state = mod.createInstance(config, ctx);
    expect(mod.validateInput(state, players[0]!, { value: -3 }, ctx)).toEqual({ ok: false, reason: 'Fill in a whole number of 0 or more' });
    expect(mod.validateInput(state, players[0]!, { value: 2.5 }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, players[0]!, {} as never, ctx)).toEqual({ ok: false, reason: 'Fill in your score' });
  });

  it('can close it without a penalty', () => {
    const free = { ...config, penalty: 0 };
    const { state, scores } = enter(mod.createInstance(free, ctx), players[0]!, 30);
    expect(scores[0]!.points).toBe(0);
    expect(mod.playerNote!(state, players[0]!, ctx)).toMatchObject({ text: '30 is more than the maximum of 20. This challenge is now closed for you.' });
  });

  it('ranks players by reported score minus deductions', () => {
    let state = mod.createInstance(config, ctx);
    const evaluations = [];
    for (const [p, v] of [[players[0]!, 25], [players[0]!, 15], [players[1]!, 12]] as const) {
      if (mod.closedFor!(state, ctx).includes(p.id)) state = mod.reopenFor!(state, p, ctx);
      const r = enter(state, p, v);
      state = r.state;
      evaluations.push(r.evaluation);
    }
    expect(mod.getStatistics(state, evaluations, ctx)).toMatchObject({ reported: 2, overMaximum: 1, deducted: 5, highest: 15 });
    const shared = JSON.stringify(mod.resultsView(state, evaluations, ctx).ui);
    expect(shared).toMatch(/"name":"Bea","value":"12","points":12.*"name":"Ada","value":"15 · −5","points":10/);
    expect(JSON.stringify(mod.resultsView(state, evaluations, ctx).guestUi!(players[0]!))).toContain('−5 for going over the maximum');
  });
});
