import { describe, expect, it } from 'vitest';
import type { InstanceContext, PlayerRef, Submission } from '@challenge/contract';
import mod, { allowance, distance, matchAnswer, simplify } from '../server/index.ts';

function fakeCtx(players: PlayerRef[]) {
  const scheduled: { tag: string; seconds: number; playerId?: string }[] = [];
  const ctx: InstanceContext = {
    gameId: 'g1',
    instanceId: 'i1',
    rng: () => 0.5,
    now: () => 1_700_000_000_000,
    players: () => players,
    schedule: (tag, seconds, playerId) => scheduled.push({ tag, seconds, playerId }),
    cancel: () => {},
    emit: () => {},
    mediaUrl: (ref) => ref,
  };
  return { ctx, scheduled };
}

const ada: PlayerRef = { id: 'p1', displayName: 'Ada', connected: true };
const bea: PlayerRef = { id: 'p2', displayName: 'Bea', connected: true };

const rovers = {
  prompt: 'Name the Mars rovers',
  answers: [
    { answer: 'Sojourner' },
    { answer: 'Spirit' },
    { answer: 'Opportunity' },
    { answer: 'Curiosity' },
    { answer: 'Perseverance', points: 3 },
    { answer: 'Zhurong', alternatives: 'Zhu Rong' },
  ],
  pointsEach: 1,
  timeLimit: 60,
  spelling: 'normal' as const,
  showFound: true,
};

type State = ReturnType<typeof mod.createInstance>;

function guess(state: State, ctx: InstanceContext, who: PlayerRef, text: string): State {
  const payload = { guess: text };
  expect(mod.validateAction!(state, who, payload, ctx)).toEqual({ ok: true });
  return mod.onAction!(state, who, payload, ctx);
}

function submission(playerId: string): Submission<Record<string, unknown>> {
  return { id: `s-${playerId}`, playerId, payload: {}, startedAt: 0, submittedAt: 1, judgements: [] };
}

describe('name-them-all matching', () => {
  it('ignores capitals, accents, spaces, hyphens, punctuation and a leading "the"', () => {
    expect(simplify('  Jean-Luc  Picard! ')).toBe('jeanlucpicard');
    expect(simplify('Pokémon')).toBe('pokemon');
    expect(simplify('The Beatles')).toBe('beatles');
    expect(simplify('Rock & Roll')).toBe('rockandroll');
  });

  it('counts a swap of neighbouring letters as one mistake', () => {
    expect(distance('perseverance', 'persaverance')).toBe(1);
    expect(distance('saturn', 'satrun')).toBe(1);
    expect(distance('kitten', 'sitting')).toBe(3);
    expect(distance('', 'abc')).toBe(3);
  });

  it('allows more mistakes in longer answers, none in short ones', () => {
    expect([3, 4, 5, 8, 9, 14].map((n) => allowance(n, 'normal'))).toEqual([0, 0, 1, 1, 2, 2]);
    expect([3, 4, 7, 11].map((n) => allowance(n, 'loose'))).toEqual([0, 1, 2, 3]);
    expect(allowance(20, 'exact')).toBe(0);
  });

  it('accepts small spelling mistakes and alternatives', () => {
    expect(matchAnswer(rovers, 'persaverance')).toBe(4);
    expect(matchAnswer(rovers, 'PERSEVERANCE')).toBe(4);
    expect(matchAnswer(rovers, 'Oportunity')).toBe(2);
    expect(matchAnswer(rovers, 'sojurner')).toBe(0);
    expect(matchAnswer(rovers, 'zhu-rong')).toBe(5);
    expect(matchAnswer(rovers, 'the spirit')).toBe(1);
    expect(matchAnswer(rovers, 'Pathfinder')).toBeNull();
    expect(matchAnswer(rovers, 'persavaranse')).toBeNull(); // three mistakes is too many
    expect(matchAnswer({ ...rovers, spelling: 'exact' }, 'persaverance')).toBeNull();
    expect(matchAnswer({ ...rovers, spelling: 'loose' }, 'persavaranse')).toBe(4);
  });

  it('keeps short answers exact and prefers an answer not named yet', () => {
    const planets = { ...rovers, answers: [{ answer: 'Mars' }, { answer: 'Pluto' }, { answer: 'Plato' }] };
    expect(matchAnswer(planets, 'Mary')).toBeNull();
    expect(matchAnswer(planets, 'plito')).toBe(1);
    expect(matchAnswer(planets, 'plito', new Set([1]))).toBe(2);
    expect(matchAnswer(planets, 'pluto', new Set([1]))).toBe(1); // the exact answer wins over a near one
  });
});

describe('name-them-all', () => {
  it('has a consistent manifest', () => {
    expect(mod.manifest).toMatchObject({ id: 'name-them-all', version: '1.0.0', apiVersion: '2', results: 'immediate', category: 'knowledge' });
    expect(mod.manifest.evaluation).toEqual({ mode: 'automatic' });
  });

  it('starts the clock and a fresh list on every attempt', () => {
    const { ctx, scheduled } = fakeCtx([ada]);
    let state = mod.onAttemptStart!(mod.createInstance(rovers, ctx), ada, ctx);
    expect(scheduled).toEqual([{ tag: 'lock', seconds: 60, playerId: 'p1' }]);
    state = guess(state, ctx, ada, 'Spirit');
    state = mod.onAttemptStart!(state, ada, ctx);
    expect(state.entries.p1).toEqual([]);
    const untimed = mod.onAttemptStart!(mod.createInstance({ ...rovers, timeLimit: 0 }, ctx), ada, ctx);
    expect(untimed.entries.p1).toEqual([]);
    expect(scheduled).toHaveLength(2);
  });

  it('shows what came of every entry, newest first, and never the answers still to find', () => {
    const { ctx } = fakeCtx([ada]);
    let state = mod.onAttemptStart!(mod.createInstance(rovers, ctx), ada, ctx);
    for (const text of ['persaverance', 'Pathfinder', 'Perseverance', 'spirit']) state = guess(state, ctx, ada, text);
    expect(state.entries.p1!.map((e) => [e.answer, e.repeat ?? false])).toEqual([
      [4, false],
      [null, false],
      [4, true],
      [1, false],
    ]);
    const vm = mod.guestView(state, ada, ctx);
    const json = JSON.stringify(vm.ui);
    expect(json).toContain('"type":"word-entry"');
    expect(json).toContain('Perseverance (persaverance)');
    expect(json).toContain('not on the list');
    expect(json).toContain('already named');
    expect(json.indexOf('Spirit')).toBeLessThan(json.indexOf('Pathfinder'));
    for (const hidden of ['Sojourner', 'Opportunity', 'Curiosity', 'Zhurong']) expect(json).not.toContain(hidden);
    expect(vm.canSubmit).toBe(true);
    expect(vm.status).toBe('2 of 6 named');
    expect(mod.playerNote!(state, ada, ctx)).toBe('2 of 6 named');
  });

  it('with the list hidden only shows what was entered', () => {
    const { ctx } = fakeCtx([ada]);
    const config = { ...rovers, showFound: false };
    let state = mod.onAttemptStart!(mod.createInstance(config, ctx), ada, ctx);
    for (const text of ['persaverance', 'Perseverance', 'perseverance']) state = guess(state, ctx, ada, text);
    // A different spelling of a named answer is not flagged: that would tell it counted.
    expect(state.entries.p1!.map((e) => e.repeat ?? false)).toEqual([false, false, true]);
    const vm = mod.guestView(state, ada, ctx);
    const json = JSON.stringify(vm.ui);
    expect(json).not.toContain('✓');
    expect(json).not.toContain('Perseverance (');
    expect(vm.status).toBe('2 answers entered');
    expect(mod.playerNote!(state, ada, ctx)).toBe('2 answers entered');
  });

  it('refuses empty, long and endless entries', () => {
    const { ctx } = fakeCtx([ada]);
    let state = mod.onAttemptStart!(mod.createInstance(rovers, ctx), ada, ctx);
    expect(mod.validateAction!(state, ada, { guess: '   ' }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateAction!(state, ada, { guess: 'x'.repeat(81) }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateAction!(state, ada, { other: 'Spirit' }, ctx)).toMatchObject({ ok: false });
    state = { ...state, entries: { p1: Array.from({ length: 300 }, () => ({ text: 'x', answer: null })) } };
    expect(mod.validateAction!(state, ada, { guess: 'Spirit' }, ctx)).toMatchObject({ ok: false, reason: 'That is enough answers' });
  });

  it('locks in whatever was entered when the time runs out', () => {
    const { ctx } = fakeCtx([ada]);
    let state = mod.onAttemptStart!(mod.createInstance(rovers, ctx), ada, ctx);
    expect(mod.lockInput!(state, ada, ctx)).toBeNull(); // nothing entered: missed
    state = guess(state, ctx, ada, 'Curiosity');
    expect(mod.lockInput!(state, ada, ctx)).toEqual({});
  });

  it('scores every answer named once, with its own points', () => {
    const { ctx } = fakeCtx([ada, bea]);
    let state = mod.onAttemptStart!(mod.createInstance(rovers, ctx), ada, ctx);
    for (const text of ['perseverance', 'Persaverance', 'Spirit', 'Pathfinder']) state = guess(state, ctx, ada, text);
    const evaluation = mod.evaluate(state, [submission('p1')], ctx);
    expect(evaluation).toEqual({ playerId: 'p1', displayName: 'Ada', found: [1, 4], entered: 3, points: 4 });
    expect(mod.calculateScores(state, evaluation, ctx)).toEqual([{ playerId: 'p1', points: 4, reason: 'Named 2 of 6' }]);

    state = mod.onAttemptStart!(state, bea, ctx);
    const empty = mod.evaluate(state, [submission('p2')], ctx);
    expect(empty.points).toBe(0);
    const stats = mod.getStatistics(state, [evaluation, empty], ctx);
    expect(stats).toMatchObject({ answers: 6, players: 2, averageFound: 1 });
    expect((stats.perAnswer as { found: number }[]).map((a) => a.found)).toEqual([0, 1, 0, 0, 1, 0]);

    const results = mod.resultsView(state, [evaluation, empty], ctx);
    const mine = JSON.stringify(results.guestUi!(ada));
    expect(mine).toContain('You named 2 of 6');
    expect(mine).toContain('✓ 3 pts');
    expect(JSON.stringify(results.guestUi!(bea))).toContain('You named 0 of 6');
  });

  it('presents every answer with how many named it, most named first, without points', () => {
    const { ctx } = fakeCtx([ada]);
    let state = mod.onAttemptStart!(mod.createInstance(rovers, ctx), ada, ctx);
    state = guess(state, ctx, ada, 'Zhurong');
    const evaluation = mod.evaluate(state, [submission('p1')], ctx);
    const slides = mod.presentation!(state, [evaluation], ctx);
    expect(slides).toHaveLength(1);
    const json = JSON.stringify(slides[0]!.steps);
    expect(json.indexOf('Zhurong')).toBeLessThan(json.indexOf('Sojourner'));
    expect(json).toContain('Nobody named 5 of them');
    expect(json).not.toMatch(/point|pts/);
  });
});
