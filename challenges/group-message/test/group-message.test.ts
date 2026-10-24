import { describe, expect, it } from 'vitest';
import type { InstanceContext, PlayerRef, Submission } from '@challenge/contract';
import mod from '../server/index.ts';

function fakeCtx(players: PlayerRef[]) {
  const clock = { now: 1_700_000_000_000 };
  const scheduled: { tag: string; seconds: number; playerId?: string }[] = [];
  const cancelled: { tag: string; playerId?: string }[] = [];
  const ctx: InstanceContext = {
    gameId: 'g1',
    instanceId: 'i1',
    rng: () => 0.5,
    now: () => clock.now,
    players: () => players,
    schedule: (tag, seconds, playerId) => scheduled.push({ tag, seconds, playerId }),
    cancel: (tag, playerId) => cancelled.push({ tag, playerId }),
    emit: () => {},
    mediaUrl: (ref) => ref,
  };
  return { ctx, clock, scheduled, cancelled };
}

const ada: PlayerRef = { id: 'p1', displayName: 'Ada', connected: true };
const bea: PlayerRef = { id: 'p2', displayName: 'Bea', connected: true };
const cyd: PlayerRef = { id: 'p3', displayName: 'Cyd', connected: true };

const config = { prompt: 'Birthday message for Sam', wordsPerTurn: 3, visibleWords: 5, turnSeconds: 300, maxTurnsPerPlayer: 2, pointsPerTurn: 1 };

const sub = (playerId: string, words: string): Submission<{ words: string }> => ({ id: `s-${playerId}`, playerId, payload: { words }, startedAt: 0, submittedAt: 1, judgements: [] });

/** Open the instance and let `who` add `words` on their turn. */
function contribute(state: ReturnType<typeof mod.createInstance>, ctx: InstanceContext, who: PlayerRef, words: string) {
  expect(mod.canStart!(state, who, ctx)).toMatchObject({ ok: true });
  const started = mod.onAttemptStart!(state, who, ctx);
  expect(mod.validateInput(started, who, { words }, ctx)).toEqual({ ok: true });
  return mod.handleInput(started, who, { words }, ctx);
}

describe('group-message', () => {
  it('has a consistent manifest: automatic, immediate, repeated attempts', () => {
    expect(mod.manifest).toMatchObject({ id: 'group-message', version: '1.0.0', apiVersion: '2', results: 'immediate', attempts: 'repeat', resubmission: 'none' });
    expect(mod.manifest.evaluation).toEqual({ mode: 'automatic' });
  });

  it('gives the first turn when it opens and tells everyone else whose turn it is', () => {
    const { ctx, scheduled } = fakeCtx([ada, bea, cyd]);
    const state = mod.onPhaseChange!(mod.createInstance(config, ctx), 'ACTIVE', ctx);
    expect(state.turn).toMatchObject({ playerId: 'p1', displayName: 'Ada' });
    expect(scheduled).toEqual([{ tag: 'turn', seconds: 300, playerId: undefined }]);
    expect(mod.canStart!(state, ada, ctx)).toEqual({ ok: true, hint: 'Your turn! Add up to 3 words' });
    expect(mod.canStart!(state, bea, ctx)).toEqual({ ok: false, reason: 'Ada is writing — wait for your turn' });
  });

  it('accepts up to the configured number of words, only from the turn holder', () => {
    const { ctx } = fakeCtx([ada, bea]);
    const state = mod.onPhaseChange!(mod.createInstance(config, ctx), 'ACTIVE', ctx);
    expect(mod.validateInput(state, ada, { words: 'happy birthday dear' }, ctx)).toEqual({ ok: true });
    expect(mod.validateInput(state, ada, { words: 'happy birthday dear Sam' }, ctx)).toEqual({ ok: false, reason: 'Only 3 words per turn' });
    expect(mod.validateInput(state, ada, { words: '   ' }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, ada, {} as never, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, ada, { words: 'x'.repeat(31) }, ctx)).toEqual({ ok: false, reason: 'That word is too long' });
    expect(mod.validateInput(state, bea, { words: 'hi' }, ctx)).toEqual({ ok: false, reason: 'Your turn is over' });
  });

  it('passes the turn around, shows only the last words and stops players at their maximum', () => {
    const { ctx, clock, scheduled } = fakeCtx([ada, bea, cyd]);
    let state = mod.onPhaseChange!(mod.createInstance({ ...config, openingText: 'Dear Sam,' }, ctx), 'ACTIVE', ctx);
    clock.now += 60_000;
    state = contribute(state, ctx, ada, '  happy   birthday ');
    // The attempt gets what is left of the turn: 300 s - 60 s.
    expect(scheduled).toContainEqual({ tag: 'lock', seconds: 240, playerId: 'p1' });
    expect(state.turn?.playerId).toBe('p2');
    state = contribute(state, ctx, bea, 'to the best');
    state = contribute(state, ctx, cyd, 'host ever');
    expect(state.turn?.playerId).toBe('p1'); // round robin

    // Ada sees only the last 5 words.
    const view = JSON.stringify(mod.guestView(state, ada, ctx).ui);
    expect(view).toContain('… to the best host ever');
    expect(view).not.toContain('Dear Sam');
    expect(JSON.stringify(mod.guestView(state, bea, ctx).ui)).toContain('Your turn is over');

    state = contribute(state, ctx, ada, 'and');
    expect(mod.canStart!(state, ada, ctx)).toEqual({ ok: false, reason: 'You added your 2 contributions — thank you!' });
    state = contribute(state, ctx, bea, 'many');
    state = contribute(state, ctx, cyd, 'more!');
    expect(state.turn).toBeNull(); // everyone is done
    expect(mod.canStart!(state, cyd, ctx)).toMatchObject({ ok: false });

    const results = mod.resultsView(state, ['p1', 'p2', 'p3', 'p1', 'p2', 'p3'].map((p) => ({ playerId: p, displayName: p, text: 'x' })), ctx);
    expect(JSON.stringify(results.ui)).toContain('Dear Sam, happy birthday to the best host ever and many more!');
    expect(JSON.stringify(results.guestUi!(ada))).toContain('You added to it 2 times.');
    expect(mod.getStatistics(state, [], ctx)).toMatchObject({ words: 12 });
  });

  it('moves on when a turn is not used and prefers players whose phone is connected', () => {
    const offline: PlayerRef = { ...bea, connected: false };
    const { ctx } = fakeCtx([ada, offline, cyd]);
    let state = mod.onPhaseChange!(mod.createInstance(config, ctx), 'ACTIVE', ctx);
    expect(state.turn?.playerId).toBe('p1');
    state = mod.onTimer!(state, 'turn', ctx); // Ada let it run out
    expect(state.turn?.playerId).toBe('p3'); // Bea is offline
    state = mod.onTimer!(state, 'turn', ctx);
    expect(state.turn?.playerId).toBe('p1');
    expect(state.offered).toEqual({ p1: 2, p3: 1 });
  });

  it('waits for players, and drops the turn while the challenge is closed', () => {
    const players: PlayerRef[] = [];
    const { ctx, scheduled, cancelled } = fakeCtx(players);
    let state = mod.onPhaseChange!(mod.createInstance(config, ctx), 'ACTIVE', ctx);
    expect(state.turn).toBeNull();
    expect(scheduled).toEqual([{ tag: 'turn', seconds: 30, playerId: undefined }]);
    players.push(ada);
    state = mod.onTimer!(state, 'turn', ctx);
    expect(state.turn?.playerId).toBe('p1');
    state = mod.onPhaseChange!(state, 'LOCKED', ctx);
    expect(state.turn).toBeNull();
    expect(cancelled).toContainEqual({ tag: 'turn', playerId: undefined });
  });

  it('scores every contribution', () => {
    const { ctx } = fakeCtx([ada]);
    const state = mod.createInstance(config, ctx);
    const evaluation = mod.evaluate(state, [sub('p1', ' happy  birthday ')], ctx);
    expect(evaluation).toEqual({ playerId: 'p1', displayName: 'Ada', text: 'happy birthday' });
    expect(mod.calculateScores(state, evaluation, ctx)).toEqual([{ playerId: 'p1', points: 1, reason: 'Added to the message' }]);
  });
});
