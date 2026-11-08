import { describe, expect, it } from 'vitest';
import type { InstanceContext, PlayerRef } from '@challenge/contract';
import mod from '../server/index.ts';

function fakeCtx(players: PlayerRef[]) {
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
  return { ctx };
}

const ada: PlayerRef = { id: 'p1', displayName: 'Ada', connected: true };
const bea: PlayerRef = { id: 'p2', displayName: 'Bea', connected: true };
const cyd: PlayerRef = { id: 'p3', displayName: 'Cyd', connected: true };

const config = {
  statements: [
    { text: 'Maximum acceptable shower time', min: 0, max: 60, step: 1, unit: 'minutes' },
    { text: 'Ideal number of pets', min: 0, max: 5, step: 1 },
  ],
  pointsPerAnswer: 0,
};

type State = ReturnType<typeof mod.createInstance>;

/** Send one answer as the live action the phone sends. */
function answer(state: State, ctx: InstanceContext, who: PlayerRef, id: string, value: number): State {
  const payload = { answer: { id, value } };
  expect(mod.validateAction!(state, who, payload, ctx)).toEqual({ ok: true });
  return mod.onAction!(state, who, payload, ctx);
}

describe('sliding-scales', () => {
  it('has a consistent manifest: a Hot Take scored when it closes', () => {
    expect(mod.manifest).toMatchObject({ id: 'sliding-scales', version: '1.3.0', apiVersion: '2', results: 'onClose', suggestedCategory: 'Hot Takes' });
    expect(mod.manifest.evaluation).toEqual({ mode: 'automatic' });
  });

  it('lists every statement with a live slider, showing the player’s own answers', () => {
    const { ctx } = fakeCtx([ada]);
    let state = mod.createInstance(config, ctx);
    state = answer(state, ctx, ada, 's0', 12);
    const view = mod.guestView(state, ada, ctx);
    // Optional lock-in: the button stays, Back keeps the answers open.
    expect(view.canSubmit).toBe(true);
    expect(view.status).toBe('1 of 2 answered · change them any time, or lock them in');
    expect(JSON.stringify(view.ui)).toContain('Done: lock in my answers');
    const json = JSON.stringify(view.ui);
    expect(json).toContain('Maximum acceptable shower time');
    expect(json).toContain(JSON.stringify({ type: 'live-answer', action: 'answer', id: 's0', value: 12, min: 0, max: 60, step: 1, unit: 'minutes', marks: [{ value: 0, label: '0 minutes' }, { value: 60, label: '60 minutes' }] }));
    expect(json).toContain('"id":"s1","value":null');
    expect(json).toContain('come back later');
    expect(mod.playerNote!(state, ada, ctx)).toBe('1 of 2 answered');
  });

  it('accepts answers on the scale, snaps them to the interval and lets players change their minds', () => {
    const { ctx } = fakeCtx([ada]);
    let state = mod.createInstance({ statements: [{ text: 'Coffee per day', min: 0, max: 2, step: 0.5, unit: 'l' }] }, ctx);
    expect(mod.validateAction!(state, ada, { answer: { id: 's9', value: 1 } }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateAction!(state, ada, { answer: { id: 's0', value: 3 } }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateAction!(state, ada, { answer: { id: 's0', value: 'a lot' } }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateAction!(state, ada, { other: 1 }, ctx)).toMatchObject({ ok: false });
    state = answer(state, ctx, ada, 's0', 0.7);
    expect(state.answers.s0).toEqual({ p1: 0.5 });
    state = answer(state, ctx, ada, 's0', 1.5);
    expect(state.answers.s0).toEqual({ p1: 1.5 });
    // Activity counts new and changed answers; the same answer again changes nothing.
    expect(answer(state, ctx, ada, 's0', 1.5)).toBe(state);
    expect(state.activity.s0).toBe(2);
    // Typing nothing to submit: answering is live only.
    // Submitting only locks the answers in, once there is at least one.
    expect(mod.validateInput(state, ada, {}, ctx)).toEqual({ ok: true });
    expect(mod.validateInput(state, { id: 'nobody', displayName: 'Nobody', connected: true }, {}, ctx)).toEqual({ ok: false, reason: 'Answer at least one first' });
  });

  it('repairs scales that do not add up', () => {
    const { ctx } = fakeCtx([ada]);
    const state = mod.createInstance({ statements: [{ text: 'Upside down', min: 10, max: 0, step: 0 }] }, ctx);
    const json = JSON.stringify(mod.guestView(state, ada, ctx).ui);
    expect(json).toContain('"min":0,"max":10,"step":1');
  });

  it('puts every statement in the spotlight with a histogram, average and median', () => {
    const { ctx } = fakeCtx([ada, bea, cyd]);
    let state = mod.createInstance(config, ctx);
    state = answer(state, ctx, ada, 's1', 1);
    state = answer(state, ctx, bea, 's1', 2);
    state = answer(state, ctx, cyd, 's1', 2);
    state = answer(state, ctx, ada, 's0', 5);
    state = answer(state, ctx, bea, 's0', 58);
    const items = mod.spotlight!(state, ctx);
    expect(items.map((i) => [i.id, i.activity])).toEqual([
      ['s0', 2],
      ['s1', 3],
    ]);
    // Few values: one column per value.
    const pets = JSON.stringify(items[1]!.ui);
    expect(pets).toContain('"columns":[{"label":"0","count":0},{"label":"1","count":1},{"label":"2","count":2},{"label":"3","count":0},{"label":"4","count":0},{"label":"5","count":0}]');
    expect(pets).toContain('3 answers · average 1.67 · median 2');
    // Many values: ten ranges, with the average marked on the axis.
    const shower = JSON.stringify(items[0]!.ui);
    expect(shower).toContain('{"label":"0–6","count":1}');
    expect(shower).toContain('{"label":"54–60","count":1}');
    expect(shower).toContain('"marker":{"at":0.525,"label":"avg 31.5 minutes"}');
    expect(shower).toContain('"axis":{"start":"0 minutes","end":"60 minutes"}');
    // Ranges are drawn compact; a short scale shows every value.
    expect(shower).toContain('"compact":true');
    expect(pets).not.toContain('compact');
    // Never who answered what.
    expect(JSON.stringify(items)).not.toContain('Ada');
    expect(JSON.stringify(mod.spotlight!(mod.createInstance(config, ctx), ctx)[0]!.ui)).toContain('No answers yet');
  });

  it('awards optional points per answered statement when it closes, and shows each player their own answers', () => {
    const { ctx } = fakeCtx([ada, bea]);
    let state = mod.createInstance({ ...config, pointsPerAnswer: 2 }, ctx);
    state = answer(state, ctx, ada, 's0', 10);
    state = answer(state, ctx, ada, 's1', 3);
    state = answer(state, ctx, bea, 's1', 0);
    const evaluation = mod.evaluate(state, [], ctx);
    expect(evaluation).toEqual({ answered: { p1: 2, p2: 1 } });
    expect(mod.calculateScores(state, evaluation, ctx)).toEqual([
      { playerId: 'p1', points: 4, reason: 'Answered 2 statements' },
      { playerId: 'p2', points: 2, reason: 'Answered 1 statement' },
    ]);
    expect(mod.getStatistics(state, [evaluation], ctx)).toEqual({ statements: 2, answers: 3, players: 2 });
    const results = mod.resultsView(state, [evaluation], ctx);
    expect(JSON.stringify(results.guestUi!(ada))).toContain('You: 10 minutes');
    expect(JSON.stringify(results.guestUi!(ada))).toContain('"highlight":3');
    expect(JSON.stringify(results.ui)).not.toContain('You:');
  });

  it('puts every statement on one presentation slide', () => {
    const { ctx } = fakeCtx([ada, bea]);
    let state = mod.createInstance(config, ctx);
    const slides = mod.presentation!(state, [], ctx);
    expect(slides).toHaveLength(1);
    expect(slides[0]!.steps).toHaveLength(1);
    const grid = slides[0]!.steps[0]!;
    expect(grid).toMatchObject({ type: 'grid', columns: config.statements.length });
    expect((grid as { children: unknown[] }).children).toHaveLength(config.statements.length);
    // The same picture as the spotlight: how the room answered, never who.
    state = answer(state, ctx, ada, 's0', 1);
    const json = JSON.stringify(mod.presentation!(state, [], ctx));
    expect(json).toContain(JSON.stringify(mod.spotlight!(state, ctx)[0]!.ui));
    expect(json).not.toContain('Ada');
  });
});
