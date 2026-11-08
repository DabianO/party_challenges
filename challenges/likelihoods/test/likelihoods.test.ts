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
  statements: [{ text: 'Likelihood that the world will end because of climate change' }, { text: 'Likelihood that it rains tomorrow' }],
  pointsPerAnswer: 0,
};

type State = ReturnType<typeof mod.createInstance>;

/** Send one answer as the live action the phone sends. */
function answer(state: State, ctx: InstanceContext, who: PlayerRef, id: string, value: number): State {
  const payload = { answer: { id, value } };
  expect(mod.validateAction!(state, who, payload, ctx)).toEqual({ ok: true });
  return mod.onAction!(state, who, payload, ctx);
}

describe('likelihoods', () => {
  it('has a consistent manifest: a Hot Take scored when it closes', () => {
    expect(mod.manifest).toMatchObject({ id: 'likelihoods', version: '1.3.0', apiVersion: '2', results: 'onClose', suggestedCategory: 'Hot Takes' });
    expect(mod.manifest.evaluation).toEqual({ mode: 'automatic' });
  });

  it('lists every statement with a live 0–100% slider, showing the player’s own answers', () => {
    const { ctx } = fakeCtx([ada]);
    let state = mod.createInstance(config, ctx);
    state = answer(state, ctx, ada, 's0', 12);
    const view = mod.guestView(state, ada, ctx);
    // Optional lock-in: the button stays, Back keeps the answers open.
    expect(view.canSubmit).toBe(true);
    expect(view.status).toBe('1 of 2 answered · change them any time, or lock them in');
    expect(JSON.stringify(view.ui)).toContain('Done: lock in my answers');
    const json = JSON.stringify(view.ui);
    expect(json).toContain('Likelihood that the world will end because of climate change');
    expect(json).toContain(
      JSON.stringify({
        type: 'live-answer',
        action: 'answer',
        id: 's0',
        value: 12,
        min: 0,
        max: 100,
        step: 1,
        unit: '%',
        start: 50,
        marks: [
          { value: 0, label: '0% · never' },
          { value: 50, label: '50%' },
          { value: 100, label: '100% · certain' },
        ],
      }),
    );
    expect(json).toContain('"id":"s1","value":null');
    expect(json).toContain('come back later');
    expect(mod.playerNote!(state, ada, ctx)).toBe('1 of 2 answered');
  });

  it('accepts percentages from 0 to 100, rounds them to whole percents and lets players change their minds', () => {
    const { ctx } = fakeCtx([ada]);
    let state = mod.createInstance(config, ctx);
    expect(mod.validateAction!(state, ada, { answer: { id: 's9', value: 50 } }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateAction!(state, ada, { answer: { id: 's0', value: 101 } }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateAction!(state, ada, { answer: { id: 's0', value: -1 } }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateAction!(state, ada, { answer: { id: 's0', value: 'very' } }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateAction!(state, ada, { other: 1 }, ctx)).toMatchObject({ ok: false });
    state = answer(state, ctx, ada, 's0', 12.6);
    expect(state.answers.s0).toEqual({ p1: 13 });
    state = answer(state, ctx, ada, 's0', 100);
    expect(state.answers.s0).toEqual({ p1: 100 });
    // Activity counts new and changed answers; the same answer again changes nothing.
    expect(answer(state, ctx, ada, 's0', 99.7)).toBe(state);
    expect(state.activity.s0).toBe(2);
    // Submitting only locks the answers in, once there is at least one.
    expect(mod.validateInput(state, ada, {}, ctx)).toEqual({ ok: true });
    expect(mod.validateInput(state, { id: 'nobody', displayName: 'Nobody', connected: true }, {}, ctx)).toEqual({ ok: false, reason: 'Answer at least one first' });
  });

  it('puts every statement in the spotlight with a ten-range histogram, average and median', () => {
    const { ctx } = fakeCtx([ada, bea, cyd]);
    let state = mod.createInstance(config, ctx);
    state = answer(state, ctx, ada, 's1', 10);
    state = answer(state, ctx, bea, 's1', 40);
    state = answer(state, ctx, cyd, 's1', 100);
    state = answer(state, ctx, ada, 's0', 9);
    state = answer(state, ctx, bea, 's0', 74);
    const items = mod.spotlight!(state, ctx);
    expect(items.map((i) => [i.id, i.activity])).toEqual([
      ['s0', 2],
      ['s1', 3],
    ]);
    // 10 counts in the second range, 100 in the last.
    const rain = JSON.stringify(items[1]!.ui);
    expect(rain).toContain(
      '"columns":[{"label":"0–10%","count":0},{"label":"10–20%","count":1},{"label":"20–30%","count":0},{"label":"30–40%","count":0},{"label":"40–50%","count":1},' +
        '{"label":"50–60%","count":0},{"label":"60–70%","count":0},{"label":"70–80%","count":0},{"label":"80–90%","count":0},{"label":"90–100%","count":1}]',
    );
    expect(rain).toContain('3 answers · average 50% · median 40%');
    expect(rain).toContain('"marker":{"at":0.5,"label":"avg 50%"}');
    expect(rain).toContain('"axis":{"start":"0% · never","middle":"50%","end":"100% · certain"}');
    // Average and median are rounded to whole percents; the marker stays exact.
    const world = JSON.stringify(items[0]!.ui);
    expect(world).toContain('2 answers · average 42% · median 42%');
    expect(world).toContain('"marker":{"at":0.415,"label":"avg 42%"}');
    // Never who answered what.
    expect(JSON.stringify(items)).not.toContain('Ada');
    expect(JSON.stringify(mod.spotlight!(mod.createInstance(config, ctx), ctx)[0]!.ui)).toContain('No answers yet');
  });

  it('awards optional points per answered statement when it closes, and shows each player their own answers', () => {
    const { ctx } = fakeCtx([ada, bea]);
    let state = mod.createInstance({ ...config, pointsPerAnswer: 2 }, ctx);
    state = answer(state, ctx, ada, 's0', 75);
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
    expect(JSON.stringify(results.guestUi!(ada))).toContain('You: 75% · 1 answer');
    expect(JSON.stringify(results.guestUi!(ada))).toContain('"highlight":7');
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
