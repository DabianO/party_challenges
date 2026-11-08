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
    { left: 'Star Wars', right: 'Star Trek', middle: 'Star Wars and Star Trek are basically the same' },
    { left: 'Cats', right: 'Dogs' },
  ],
  pointsPerAnswer: 0,
};

const starWarsLabels = [
  'Definitely Star Wars',
  'Star Wars',
  'Leaning Star Wars',
  'Star Wars and Star Trek are basically the same',
  'Leaning Star Trek',
  'Star Trek',
  'Definitely Star Trek',
];

type State = ReturnType<typeof mod.createInstance>;

/** Send one answer as the live action the phone sends. */
function answer(state: State, ctx: InstanceContext, who: PlayerRef, id: string, value: number): State {
  const payload = { answer: { id, value } };
  expect(mod.validateAction!(state, who, payload, ctx)).toEqual({ ok: true });
  return mod.onAction!(state, who, payload, ctx);
}

describe('rivalries', () => {
  it('has a consistent manifest: a Hot Take scored when it closes', () => {
    expect(mod.manifest).toMatchObject({ id: 'rivalries', version: '1.2.0', apiVersion: '2', results: 'onClose', suggestedCategory: 'Hot Takes' });
    expect(mod.manifest.evaluation).toEqual({ mode: 'automatic' });
  });

  it('lists every rivalry with a live slider from one side to the other, showing the player’s own answers', () => {
    const { ctx } = fakeCtx([ada]);
    let state = mod.createInstance(config, ctx);
    state = answer(state, ctx, ada, 's0', -2);
    const view = mod.guestView(state, ada, ctx);
    // Optional lock-in: the button stays, Back keeps the answers open.
    expect(view.canSubmit).toBe(true);
    expect(view.status).toBe('1 of 2 answered · change them any time, or lock them in');
    expect(JSON.stringify(view.ui)).toContain('Done: lock in my answers');
    const json = JSON.stringify(view.ui);
    expect(json).toContain('"text":"Star Wars vs Star Trek"');
    expect(json).toContain('Middle = Star Wars and Star Trek are basically the same');
    expect(json).toContain(
      JSON.stringify({
        type: 'live-answer',
        action: 'answer',
        id: 's0',
        value: -2,
        min: -3,
        max: 3,
        step: 1,
        start: 0,
        stepLabels: starWarsLabels,
        marks: [
          { value: -3, label: 'Star Wars' },
          { value: 0, label: 'Middle' },
          { value: 3, label: 'Star Trek' },
        ],
      }),
    );
    // Without a meaning for the middle: no caption, and a plain middle label.
    expect(json).toContain('"id":"s1","value":null');
    expect(json).toContain('"Leaning Cats","Right in the middle","Leaning Dogs"');
    expect(json).not.toContain('Middle = undefined');
    expect(json.match(/Middle = /g)).toHaveLength(1);
    expect(json).toContain('come back later');
    expect(mod.playerNote!(state, ada, ctx)).toBe('1 of 2 answered');
  });

  it('accepts answers on the scale, snaps them to whole positions and lets players change their minds', () => {
    const { ctx } = fakeCtx([ada]);
    let state = mod.createInstance(config, ctx);
    expect(mod.validateAction!(state, ada, { answer: { id: 's9', value: 1 } }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateAction!(state, ada, { answer: { id: 's0', value: 4 } }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateAction!(state, ada, { answer: { id: 's0', value: -3.5 } }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateAction!(state, ada, { answer: { id: 's0', value: 'Star Wars' } }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateAction!(state, ada, { other: 1 }, ctx)).toMatchObject({ ok: false });
    state = answer(state, ctx, ada, 's0', 1.4);
    expect(state.answers.s0).toEqual({ p1: 1 });
    state = answer(state, ctx, ada, 's0', -0.2);
    expect(state.answers.s0).toEqual({ p1: 0 });
    expect(Object.is(state.answers.s0!.p1, 0)).toBe(true); // never -0
    // Activity counts new and changed answers; the same answer again changes nothing.
    expect(answer(state, ctx, ada, 's0', 0)).toBe(state);
    expect(state.activity.s0).toBe(2);
    // Submitting only locks the answers in, once there is at least one.
    expect(mod.validateInput(state, ada, {}, ctx)).toEqual({ ok: true });
    expect(mod.validateInput(state, { id: 'nobody', displayName: 'Nobody', connected: true }, {}, ctx)).toEqual({ ok: false, reason: 'Answer at least one first' });
  });

  it('puts every rivalry in the spotlight with how the room split, and the average side', () => {
    const { ctx } = fakeCtx([ada, bea, cyd]);
    let state = mod.createInstance(config, ctx);
    state = answer(state, ctx, ada, 's1', -2);
    state = answer(state, ctx, bea, 's1', 1);
    state = answer(state, ctx, cyd, 's1', 1);
    state = answer(state, ctx, ada, 's0', -3);
    state = answer(state, ctx, bea, 's0', 0);
    const items = mod.spotlight!(state, ctx);
    expect(items.map((i) => [i.id, i.activity])).toEqual([
      ['s0', 2],
      ['s1', 3],
    ]);
    const pets = JSON.stringify(items[1]!.ui);
    expect(pets).toContain('"text":"Cats vs Dogs"');
    expect(pets).toContain(
      JSON.stringify([
        { label: 'Definitely Cats', count: 0, tone: 'primary' },
        { label: 'Cats', count: 1, tone: 'primary' },
        { label: 'Leaning Cats', count: 0, tone: 'primary' },
        { label: 'Right in the middle', count: 0, tone: 'neutral' },
        { label: 'Leaning Dogs', count: 2, tone: 'warning' },
        { label: 'Dogs', count: 0, tone: 'warning' },
        { label: 'Definitely Dogs', count: 0, tone: 'warning' },
      ]),
    );
    expect(pets).toContain('"axis":{"start":"Cats","middle":"Equal","end":"Dogs"}');
    expect(pets).toContain('"marker":{"at":0.5,"label":"avg: Right in the middle"}');
    expect(pets).toContain('3 answers · 33% Cats · 0% middle · 67% Dogs');
    const stars = JSON.stringify(items[0]!.ui);
    expect(stars).toContain('"axis":{"start":"Star Wars","middle":"Star Wars and Star Trek are basically the same","end":"Star Trek"}');
    expect(stars).toContain('"marker":{"at":0.25,"label":"avg: Leaning Star Wars"}');
    expect(stars).toContain('2 answers · 50% Star Wars · 50% middle · 0% Star Trek');
    // Never who answered what.
    expect(JSON.stringify(items)).not.toContain('Ada');
    const empty = JSON.stringify(mod.spotlight!(mod.createInstance(config, ctx), ctx)[0]!.ui);
    expect(empty).toContain('No answers yet');
    expect(empty).not.toContain('marker');
  });

  it('awards optional points per answered rivalry when it closes, and shows each player their own answers', () => {
    const { ctx } = fakeCtx([ada, bea]);
    let state = mod.createInstance({ ...config, pointsPerAnswer: 2 }, ctx);
    state = answer(state, ctx, ada, 's0', 3);
    state = answer(state, ctx, ada, 's1', -1);
    state = answer(state, ctx, bea, 's1', 0);
    const evaluation = mod.evaluate(state, [], ctx);
    expect(evaluation).toEqual({ answered: { p1: 2, p2: 1 } });
    expect(mod.calculateScores(state, evaluation, ctx)).toEqual([
      { playerId: 'p1', points: 4, reason: 'Answered 2 rivalries' },
      { playerId: 'p2', points: 2, reason: 'Answered 1 rivalry' },
    ]);
    expect(mod.getStatistics(state, [evaluation], ctx)).toEqual({ statements: 2, answers: 3, players: 2 });
    const results = mod.resultsView(state, [evaluation], ctx);
    const mine = JSON.stringify(results.guestUi!(ada));
    expect(mine).toContain('You: Definitely Star Trek · 1 answer');
    expect(mine).toContain('"highlight":6');
    expect(mine).toContain('You: Leaning Cats · ');
    expect(mine).toContain('"highlight":2');
    expect(JSON.stringify(results.ui)).not.toContain('You:');
    // No points configured: answering is just for fun.
    expect(mod.calculateScores(mod.createInstance(config, ctx), evaluation, ctx).every((s) => s.points === 0)).toBe(true);
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
