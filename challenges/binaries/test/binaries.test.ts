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
  statements: [{ text: 'Taylor Swift is overrated' }, { text: 'Pineapple belongs on pizza' }],
  pointsPerAnswer: 0,
};

type State = ReturnType<typeof mod.createInstance>;

/** Send one answer as the live action the phone sends. */
function answer(state: State, ctx: InstanceContext, who: PlayerRef, id: string, value: number): State {
  const payload = { answer: { id, value } };
  expect(mod.validateAction!(state, who, payload, ctx)).toEqual({ ok: true });
  return mod.onAction!(state, who, payload, ctx);
}

describe('binaries', () => {
  it('has a consistent manifest: a Hot Take scored when it closes', () => {
    expect(mod.manifest).toMatchObject({ id: 'binaries', version: '1.1.0', apiVersion: '2', results: 'onClose', suggestedCategory: 'Hot Takes' });
    expect(mod.manifest.evaluation).toEqual({ mode: 'automatic' });
  });

  it('lists every statement with Yes and No buttons, showing the player’s own answers', () => {
    const { ctx } = fakeCtx([ada]);
    let state = mod.createInstance(config, ctx);
    state = answer(state, ctx, ada, 's0', 1);
    const view = mod.guestView(state, ada, ctx);
    expect(view.canSubmit).toBe(false);
    expect(view.status).toBe('1 of 2 answered · change them any time');
    const json = JSON.stringify(view.ui);
    expect(json).toContain('Taylor Swift is overrated');
    expect(json).toContain(
      JSON.stringify({
        type: 'live-answer',
        action: 'answer',
        id: 's0',
        value: 1,
        min: 0,
        max: 1,
        options: [
          { value: 1, label: 'Yes', tone: 'success' },
          { value: 0, label: 'No', tone: 'danger' },
        ],
      }),
    );
    expect(json).toContain('"id":"s1","value":null');
    expect(json).toContain('come back later');
    expect(mod.playerNote!(state, ada, ctx)).toBe('1 of 2 answered');
  });

  it('accepts only Yes or No and lets players change their minds', () => {
    const { ctx } = fakeCtx([ada]);
    let state = mod.createInstance(config, ctx);
    expect(mod.validateAction!(state, ada, { answer: { id: 's9', value: 1 } }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateAction!(state, ada, { answer: { id: 's0', value: 0.5 } }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateAction!(state, ada, { answer: { id: 's0', value: 2 } }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateAction!(state, ada, { answer: { id: 's0', value: 'yes' } }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateAction!(state, ada, { other: 1 }, ctx)).toMatchObject({ ok: false });
    state = answer(state, ctx, ada, 's0', 1);
    expect(state.answers.s0).toEqual({ p1: 1 });
    state = answer(state, ctx, ada, 's0', 0);
    expect(state.answers.s0).toEqual({ p1: 0 });
    // Activity counts new and changed answers; the same answer again changes nothing.
    expect(answer(state, ctx, ada, 's0', 0)).toBe(state);
    expect(state.activity.s0).toBe(2);
    // Nothing to submit: answering is live only.
    expect(mod.validateInput(state, ada, {}, ctx)).toMatchObject({ ok: false });
  });

  it('puts every statement in the spotlight with a Yes/No bar chart and the share of yes', () => {
    const { ctx } = fakeCtx([ada, bea, cyd]);
    let state = mod.createInstance(config, ctx);
    state = answer(state, ctx, ada, 's1', 1);
    state = answer(state, ctx, bea, 's1', 0);
    state = answer(state, ctx, cyd, 's1', 1);
    state = answer(state, ctx, ada, 's0', 0);
    const items = mod.spotlight!(state, ctx);
    expect(items.map((i) => [i.id, i.activity])).toEqual([
      ['s0', 1],
      ['s1', 3],
    ]);
    const pizza = JSON.stringify(items[1]!.ui);
    expect(pizza).toContain(
      JSON.stringify({
        type: 'bar-chart',
        bars: [
          { label: 'Yes · 2', value: 2, tone: 'success' },
          { label: 'No · 1', value: 1, tone: 'danger' },
        ],
        percent: true,
      }),
    );
    expect(pizza).toContain('3 answers · 67% yes');
    expect(JSON.stringify(items[0]!.ui)).toContain('1 answer · 0% yes');
    // Never who answered what.
    expect(JSON.stringify(items)).not.toContain('Ada');
    expect(JSON.stringify(mod.spotlight!(mod.createInstance(config, ctx), ctx)[0]!.ui)).toContain('No answers yet: be the first!');
  });

  it('awards optional points per answered statement when it closes, and shows each player their own answers', () => {
    const { ctx } = fakeCtx([ada, bea]);
    let state = mod.createInstance({ ...config, pointsPerAnswer: 2 }, ctx);
    state = answer(state, ctx, ada, 's0', 1);
    state = answer(state, ctx, ada, 's1', 0);
    state = answer(state, ctx, bea, 's1', 0);
    const evaluation = mod.evaluate(state, [], ctx);
    expect(evaluation).toEqual({ answered: { p1: 2, p2: 1 } });
    expect(mod.calculateScores(state, evaluation, ctx)).toEqual([
      { playerId: 'p1', points: 4, reason: 'Answered 2 statements' },
      { playerId: 'p2', points: 2, reason: 'Answered 1 statement' },
    ]);
    expect(mod.getStatistics(state, [evaluation], ctx)).toEqual({ statements: 2, answers: 3, players: 2 });
    const results = mod.resultsView(state, [evaluation], ctx);
    const mine = JSON.stringify(results.guestUi!(ada));
    expect(mine).toContain('You: Yes · 1 answer · 100% yes');
    expect(mine).toContain('You: No · 2 answers · 0% yes');
    // Bea skipped the first statement: no "You:" there.
    expect(JSON.stringify(results.guestUi!(bea))).not.toContain('You: Yes');
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
