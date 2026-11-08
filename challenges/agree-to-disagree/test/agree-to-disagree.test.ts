import { describe, expect, it } from 'vitest';
import type { InstanceContext, PlayerRef } from '@challenge/contract';
import mod, { columnsFor } from '../server/index.ts';

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

const LEVELS = ['Fully agree', 'Mostly agree', 'Somewhat agree', 'Neutral', 'Somewhat disagree', 'Mostly disagree', 'Fully disagree'];

const config = {
  statements: [{ text: 'Pineapple belongs on pizza' }, { text: 'Socks with sandals are fine' }],
  pointsPerAnswer: 0,
};

type State = ReturnType<typeof mod.createInstance>;

/** Send one answer as the live action the phone sends. */
function answer(state: State, ctx: InstanceContext, who: PlayerRef, id: string, value: number): State {
  const payload = { answer: { id, value } };
  expect(mod.validateAction!(state, who, payload, ctx)).toEqual({ ok: true });
  return mod.onAction!(state, who, payload, ctx);
}

describe('agree-to-disagree', () => {
  it('has a consistent manifest: a Hot Take scored when it closes', () => {
    expect(mod.manifest).toMatchObject({ id: 'agree-to-disagree', version: '1.2.0', apiVersion: '2', results: 'onClose', suggestedCategory: 'Hot Takes' });
    expect(mod.manifest.evaluation).toEqual({ mode: 'automatic' });
  });

  it('lists every statement with a seven-step live slider, showing the player’s own answers', () => {
    const { ctx } = fakeCtx([ada]);
    let state = mod.createInstance(config, ctx);
    state = answer(state, ctx, ada, 's0', 1);
    const view = mod.guestView(state, ada, ctx);
    // Optional lock-in: the button stays, Back keeps the answers open.
    expect(view.canSubmit).toBe(true);
    expect(view.status).toBe('1 of 2 answered · change them any time, or lock them in');
    expect(JSON.stringify(view.ui)).toContain('Done: lock in my answers');
    const json = JSON.stringify(view.ui);
    expect(json).toContain('Pineapple belongs on pizza');
    expect(json).toContain(
      JSON.stringify({
        type: 'live-answer',
        action: 'answer',
        id: 's0',
        value: 1,
        min: 0,
        max: 6,
        step: 1,
        stepLabels: LEVELS,
        start: 3,
        marks: [
          { value: 0, label: 'Fully agree' },
          { value: 3, label: 'Neutral' },
          { value: 6, label: 'Fully disagree' },
        ],
      }),
    );
    expect(json).toContain('"id":"s1","value":null');
    expect(json).toContain('come back later');
    expect(mod.playerNote!(state, ada, ctx)).toBe('1 of 2 answered');
  });

  it('accepts levels on the scale, rounds them to whole steps and lets players change their minds', () => {
    const { ctx } = fakeCtx([ada]);
    let state = mod.createInstance(config, ctx);
    expect(mod.validateAction!(state, ada, { answer: { id: 's9', value: 1 } }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateAction!(state, ada, { answer: { id: 's0', value: 7 } }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateAction!(state, ada, { answer: { id: 's0', value: -1 } }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateAction!(state, ada, { answer: { id: 's0', value: 'yes' } }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateAction!(state, ada, { other: 1 }, ctx)).toMatchObject({ ok: false });
    state = answer(state, ctx, ada, 's0', 1.4);
    expect(state.answers.s0).toEqual({ p1: 1 });
    state = answer(state, ctx, ada, 's0', 5.6);
    expect(state.answers.s0).toEqual({ p1: 6 });
    // Activity counts new and changed answers; the same level again changes nothing.
    expect(answer(state, ctx, ada, 's0', 6)).toBe(state);
    expect(state.activity.s0).toBe(2);
    // Submitting only locks the answers in, once there is at least one.
    expect(mod.validateInput(state, ada, {}, ctx)).toEqual({ ok: true });
    expect(mod.validateInput(state, { id: 'nobody', displayName: 'Nobody', connected: true }, {}, ctx)).toEqual({ ok: false, reason: 'Answer at least one first' });
  });

  it('puts every statement in the spotlight with a column per level, the average and the split', () => {
    const { ctx } = fakeCtx([ada, bea, cyd]);
    let state = mod.createInstance(config, ctx);
    state = answer(state, ctx, ada, 's1', 0);
    state = answer(state, ctx, bea, 's1', 1);
    state = answer(state, ctx, cyd, 's1', 5);
    state = answer(state, ctx, ada, 's0', 3);
    state = answer(state, ctx, bea, 's0', 6);
    const items = mod.spotlight!(state, ctx);
    expect(items.map((i) => [i.id, i.activity])).toEqual([
      ['s0', 2],
      ['s1', 3],
    ]);
    const socks = JSON.stringify(items[1]!.ui);
    expect(socks).toContain(
      JSON.stringify([
        { label: 'Fully agree', count: 1, tone: 'success' },
        { label: 'Mostly agree', count: 1, tone: 'success' },
        { label: 'Somewhat agree', count: 0, tone: 'success' },
        { label: 'Neutral', count: 0, tone: 'neutral' },
        { label: 'Somewhat disagree', count: 0, tone: 'danger' },
        { label: 'Mostly disagree', count: 1, tone: 'danger' },
        { label: 'Fully disagree', count: 0, tone: 'danger' },
      ]),
    );
    expect(socks).toContain('"axis":{"start":"Agree","middle":"Neutral","end":"Disagree"}');
    expect(socks).toContain(`"marker":{"at":${2 / 6},"label":"avg: Somewhat agree"}`);
    expect(socks).toContain('3 answers · 67% agree · 0% neutral · 33% disagree');
    const pizza = JSON.stringify(items[0]!.ui);
    expect(pizza).toContain('"marker":{"at":0.75,"label":"avg: Mostly disagree"}');
    expect(pizza).toContain('2 answers · 0% agree · 50% neutral · 50% disagree');
    // Never who answered what.
    expect(JSON.stringify(items)).not.toContain('Ada');
    const empty = JSON.stringify(mod.spotlight!(mod.createInstance(config, ctx), ctx)[0]!.ui);
    expect(empty).toContain('No answers yet: be the first!');
    expect(empty).not.toContain('marker');
  });

  it('awards optional points per answered statement when it closes, and shows each player their own answers', () => {
    const { ctx } = fakeCtx([ada, bea]);
    let state = mod.createInstance({ ...config, pointsPerAnswer: 2 }, ctx);
    state = answer(state, ctx, ada, 's0', 4);
    state = answer(state, ctx, ada, 's1', 0);
    state = answer(state, ctx, bea, 's1', 6);
    const evaluation = mod.evaluate(state, [], ctx);
    expect(evaluation).toEqual({ answered: { p1: 2, p2: 1 } });
    expect(mod.calculateScores(state, evaluation, ctx)).toEqual([
      { playerId: 'p1', points: 4, reason: 'Answered 2 statements' },
      { playerId: 'p2', points: 2, reason: 'Answered 1 statement' },
    ]);
    expect(mod.getStatistics(state, [evaluation], ctx)).toEqual({ statements: 2, answers: 3, players: 2 });
    const results = mod.resultsView(state, [evaluation], ctx);
    expect(JSON.stringify(results.guestUi!(ada))).toContain('You: Somewhat disagree · 1 answer');
    expect(JSON.stringify(results.guestUi!(ada))).toContain('"highlight":4');
    expect(JSON.stringify(results.ui)).not.toContain('You:');
    expect(JSON.stringify(results.ui)).not.toContain('highlight');
  });

  it('puts every statement on one presentation slide', () => {
    const { ctx } = fakeCtx([ada, bea]);
    let state = mod.createInstance(config, ctx);
    const slides = mod.presentation!(state, [], ctx);
    expect(slides).toHaveLength(1);
    expect(slides[0]!.steps).toHaveLength(1);
    const grid = slides[0]!.steps[0]!;
    expect(grid).toMatchObject({ type: 'grid', columns: columnsFor(config.statements.length) });
    // Wide charts: never three cramped side by side for a handful of statements.
    expect([1, 2, 3, 5, 8, 9, 16].map(columnsFor)).toEqual([1, 2, 2, 2, 2, 3, 4]);
    expect((grid as { children: unknown[] }).children).toHaveLength(config.statements.length);
    // The same picture as the spotlight: how the room answered, never who.
    state = answer(state, ctx, ada, 's0', 1);
    const json = JSON.stringify(mod.presentation!(state, [], ctx));
    expect(json).toContain(JSON.stringify(mod.spotlight!(state, ctx)[0]!.ui));
    expect(json).not.toContain('Ada');
  });
});
