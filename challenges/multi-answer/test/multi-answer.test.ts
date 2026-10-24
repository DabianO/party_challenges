import { describe, expect, it } from 'vitest';
import type { InstanceContext, PlayerRef, Submission } from '@challenge/contract';
import mod, { matches, normalise, scoreFor } from '../server/index.ts';

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

const sub = (playerId: string, answers: string[]): Submission<Record<string, string>> => ({
  id: `s-${playerId}`,
  playerId,
  payload: Object.fromEntries(answers.map((a, i) => [`a${i}`, a])),
  startedAt: 0,
  submittedAt: 1,
  judgements: [],
});

describe('multi-answer', () => {
  it('has a consistent manifest', () => {
    expect(mod.manifest).toMatchObject({ id: 'multi-answer', version: '1.0.0', apiVersion: '2', results: 'immediate', resubmission: 'none' });
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
    expect(mod.validateInput(state, players[0]!, { a0: 5 } as never, ctx)).toMatchObject({ ok: false });
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
});
