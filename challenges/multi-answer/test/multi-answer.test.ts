import { describe, expect, it } from 'vitest';
import type { InstanceContext, PlayerRef, Submission } from '@challenge/contract';
import mod, { answerText, matches, normalise, numericBox, scoreFor } from '../server/index.ts';

const players: PlayerRef[] = [
  { id: 'p1', displayName: 'Ada', connected: true },
  { id: 'p2', displayName: 'Bea', connected: true },
];

function fakeCtx() {
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

const capitals = {
  question: 'Name the capitals',
  answers: [
    { label: 'France', answer: 'Paris' },
    { label: 'Belgium', answer: 'Brussels', alternatives: 'Brussel, Bruxelles' },
    { label: 'USA', answer: 'Washington D.C.', alternatives: 'Washington' },
  ],
  anyOrder: false,
  timeLimit: 60,
  points: 10,
};

const sub = (playerId: string, answers: (string | number)[]): Submission<Record<string, string | number>> => ({
  id: `s-${playerId}`,
  playerId,
  payload: Object.fromEntries(answers.map((a, i) => [`a${i}`, a])),
  startedAt: 0,
  submittedAt: 1,
  judgements: [],
});

describe('multi-answer', () => {
  it('has a consistent manifest', () => {
    expect(mod.manifest).toMatchObject({ id: 'multi-answer', version: '1.2.0', apiVersion: '2', results: 'immediate', resubmission: 'none' });
    expect(mod.manifest.evaluation).toEqual({ mode: 'automatic' });
  });

  it('splits points into whole shares and gives the remainder only for a full set', () => {
    // 10 points over 3 answers: 3 per answer, all three right = 10.
    expect([0, 1, 2, 3].map((n) => scoreFor(10, 3, n))).toEqual([0, 3, 6, 10]);
    expect([0, 1, 2, 3, 4].map((n) => scoreFor(10, 4, n))).toEqual([0, 2, 4, 6, 10]);
    expect([0, 1, 2].map((n) => scoreFor(1, 2, n))).toEqual([0, 0, 1]);
  });

  it('compares answers leniently', () => {
    expect(normalise('  Ça   VA? ')).toBe('ca va');
    expect(matches({ answer: 'St. Louis' }, 'st louis')).toBe(true);
    expect(matches({ answer: 'Washington D.C.' }, 'washington dc')).toBe(true);
    expect(matches({ answer: 'Jean-Paul' }, 'jean paul')).toBe(true);
    expect(matches({ answer: '3.5' }, '3,50')).toBe(true);
    expect(matches({ answer: '42' }, '42.0')).toBe(true);
    expect(matches({ answer: '42' }, '43')).toBe(false);
    expect(matches({ answer: 'Brussels', alternatives: 'Brussel, Bruxelles' }, 'BRUXELLES')).toBe(true);
    expect(matches({ answer: 'Paris' }, '')).toBe(false);
  });

  it('shows one box per answer, schedules the time limit and validates input', () => {
    const { ctx, scheduled } = fakeCtx();
    const state = mod.onAttemptStart!(mod.createInstance(capitals, ctx), players[0]!, ctx);
    expect(scheduled).toEqual([{ tag: 'lock', seconds: 60, playerId: 'p1' }]);
    const view = mod.guestView(state, players[0]!, ctx);
    expect(JSON.stringify(view.ui).match(/"text-input"/g)).toHaveLength(3);
    expect(JSON.stringify(view.ui)).toContain('"label":"Belgium"');
    expect(view.status).toBe('3 per correct answer · 10 for all 3');
    expect(mod.validateInput(state, players[0]!, { a0: 'Paris' }, ctx)).toEqual({ ok: true });
    expect(mod.validateInput(state, players[0]!, { a0: ' ', a1: '' }, ctx)).toEqual({ ok: false, reason: 'Fill in at least one answer' });
    expect(mod.validateInput(state, players[0]!, { a0: true } as never, ctx)).toMatchObject({ ok: false });
  });

  it('scores each answer box, full marks only for the full set', () => {
    const { ctx } = fakeCtx();
    const state = mod.createInstance(capitals, ctx);
    const full = mod.evaluate(state, [sub('p1', ['paris', 'Brussel', 'washington dc'])], ctx);
    expect(full).toMatchObject({ correct: [true, true, true], allCorrect: true, points: 10 });
    expect(mod.calculateScores(state, full, ctx)).toEqual([{ playerId: 'p1', points: 10, reason: 'All 3 correct' }]);
    const partial = mod.evaluate(state, [sub('p2', ['Paris', 'Antwerp'])], ctx);
    expect(partial).toMatchObject({ correct: [true, false, false], correctCount: 1, points: 3 });
    expect(mod.calculateScores(state, partial, ctx)).toEqual([{ playerId: 'p2', points: 3, reason: '1 of 3 correct' }]);

    expect(mod.getStatistics(state, [full, partial], ctx)).toMatchObject({ allCorrect: 1, averageCorrect: 2, perAnswer: [{ correct: 2 }, { correct: 1 }, { correct: 1 }] });
    const mine = JSON.stringify(mod.resultsView(state, [full, partial], ctx).guestUi!(players[1]!));
    expect(mine).toContain('1 of 3 correct');
    expect(mine).toContain('✕ Brussels');
  });

  it('accepts answers in any order, each correct answer once', () => {
    const { ctx } = fakeCtx();
    const colours = {
      ...capitals,
      question: 'Name the primary colours',
      anyOrder: true,
      answers: [{ answer: 'red' }, { answer: 'yellow' }, { answer: 'blue' }],
    };
    const state = mod.createInstance(colours, ctx);
    expect(mod.evaluate(state, [sub('p1', ['Blue', 'red', 'YELLOW'])], ctx)).toMatchObject({ allCorrect: true, points: 10 });
    // Naming the same colour twice only counts once.
    expect(mod.evaluate(state, [sub('p2', ['red', 'red', 'green'])], ctx)).toMatchObject({ correct: [true, false, false], points: 3 });
    expect(JSON.stringify(mod.guestView(state, players[0]!, ctx).ui)).toContain('"label":"Answer 2"');
  });

  it('asks a single question with one text answer', () => {
    const { ctx } = fakeCtx();
    const state = mod.createInstance({ question: 'Who painted the Night Watch?', answers: [{ answer: 'Rembrandt', alternatives: 'Rembrandt van Rijn' }], anyOrder: false, timeLimit: 30, points: 5 }, ctx);
    const view = mod.guestView(state, players[0]!, ctx);
    expect(JSON.stringify(view.ui)).toContain('"label":"Your answer"');
    expect(JSON.stringify(view.ui)).toContain('Lock in my answer"');
    expect(view.status).toBe('5 points');
    expect(mod.validateInput(state, players[0]!, { a0: '' }, ctx)).toEqual({ ok: false, reason: 'Fill in your answer' });

    const right = mod.evaluate(state, [sub('p1', ['rembrandt van rijn'])], ctx);
    expect(mod.calculateScores(state, right, ctx)).toEqual([{ playerId: 'p1', points: 5, reason: 'Correct' }]);
    const wrong = mod.evaluate(state, [sub('p2', ['Vermeer'])], ctx);
    expect(mod.calculateScores(state, wrong, ctx)).toEqual([{ playerId: 'p2', points: 0, reason: 'Wrong' }]);
    const results = mod.resultsView(state, [right, wrong], ctx);
    expect(JSON.stringify(results.ui)).toContain('1 of 2 right');
    const mine = JSON.stringify(results.guestUi!(players[1]!));
    expect(mine).toContain('Not quite');
    expect(mine).toContain('You answered Vermeer');
  });

  it('takes numbers in a number box, within the tolerance (the old Numeric Answer)', () => {
    const { ctx } = fakeCtx();
    const piano = { question: 'How many keys does a piano have?', answers: [{ answer: '88', tolerance: 2, unit: 'keys' }], anyOrder: false, timeLimit: 20, points: 10, media: 'media://piano' };
    const state = mod.createInstance(piano, ctx);
    expect(numericBox(state.config, 0)).toBe(true);
    const ui = JSON.stringify(mod.guestView(state, players[0]!, ctx).ui);
    expect(ui).toContain('"type":"number-input"');
    expect(ui).toContain('"unit":"keys"');
    expect(ui).toContain('media://piano');
    expect(mod.validateInput(state, players[0]!, { a0: 86 }, ctx)).toEqual({ ok: true });
    expect(mod.validateInput(state, players[0]!, { a0: Number.NaN }, ctx)).toMatchObject({ ok: false });

    expect(mod.evaluate(state, [sub('p1', [86])], ctx)).toMatchObject({ allCorrect: true, points: 10 });
    expect(mod.evaluate(state, [sub('p1', [90.5])], ctx)).toMatchObject({ allCorrect: false, points: 0 });
    expect(mod.evaluate(state, [sub('p1', ['89,5'])], ctx)).toMatchObject({ allCorrect: true });
    expect(answerText(piano.answers[0]!)).toBe('88 keys (± 2 keys)');
    // Text answers ignore the tolerance; mixed sets get a number box only where the answer is a number.
    expect(matches({ answer: 'Paris', tolerance: 3 }, 'Pari')).toBe(false);
    expect(numericBox({ ...capitals, answers: [{ answer: 'Paris' }, { answer: '1889' }] }, 1)).toBe(true);
    expect(numericBox({ ...capitals, anyOrder: true, answers: [{ answer: 'Paris' }, { answer: '1889' }] }, 1)).toBe(false);
  });

  it('presents several answers hidden, then revealed with how many got each, without names or points', () => {
    const { ctx } = fakeCtx();
    const state = mod.createInstance(capitals, ctx);
    expect(mod.presentation!(state, [], ctx)).toEqual([]);
    const evaluations = [mod.evaluate(state, [sub('p1', ['paris', 'Brussel', 'washington dc'])], ctx), mod.evaluate(state, [sub('p2', ['Paris', 'Antwerp'])], ctx)];
    const slides = mod.presentation!(state, evaluations, ctx);
    expect(slides).toHaveLength(1);
    expect(slides[0]!.steps).toHaveLength(2);
    const [ask, reveal] = slides[0]!.steps.map((s) => JSON.stringify(s));
    expect(ask).toContain('Name the capitals');
    expect(ask).toContain('Belgium');
    expect(ask).not.toContain('Brussels');
    expect(reveal).toContain('Brussels');
    expect(reveal).toContain('2 of 2 right');
    expect(reveal).toContain('1 of 2 got all 3');
    const all = JSON.stringify(slides);
    for (const p of players) expect(all).not.toContain(p.displayName);
    expect(all).not.toMatch(/point|ranking/i);
  });

  it('presents a single answer as the room’s most common answers, the right ones lit up on reveal', () => {
    const { ctx } = fakeCtx();
    const state = mod.createInstance({ question: 'Who painted the Night Watch?', answers: [{ answer: 'Rembrandt', alternatives: 'Rembrandt van Rijn' }], anyOrder: false, timeLimit: 30, points: 5 }, ctx);
    const given = ['rembrandt', 'Vermeer', 'Rembrandt van Rijn', 'vermeer', 'Van Gogh', 'Hals', 'Steen', 'Dou', 'Bol', ''];
    const evaluations = given.map((g, i) => mod.evaluate(state, [{ ...sub('p1', [g]), id: `s${i}` }], ctx));
    const slides = mod.presentation!(state, evaluations, ctx);
    const [ask, reveal] = slides[0]!.steps.map((s) => s as unknown as { children: { type: string; bars?: { label: string; value: number; highlight?: boolean }[] }[] });
    const bars = (step: typeof ask) => step!.children.find((n) => n.type === 'bar-chart')!.bars!;
    expect(bars(ask).map((b) => [b.label, b.value])).toEqual([
      ['Rembrandt', 2],
      ['Vermeer', 2],
      ['Van Gogh', 1],
      ['Hals', 1],
      ['Steen', 1],
      ['Something else', 2],
    ]);
    expect(bars(ask).some((b) => b.highlight)).toBe(false);
    expect(bars(reveal).filter((b) => b.highlight).map((b) => b.label)).toEqual(['Rembrandt']);
    expect(JSON.stringify(reveal)).toContain('2 of 10 right');
    expect(JSON.stringify(slides)).not.toMatch(/point/i);
  });
});
