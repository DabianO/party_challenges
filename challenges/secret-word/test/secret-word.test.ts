import { describe, expect, it } from 'vitest';
import type { InstanceContext, PlayerRef, Submission } from '@challenge/contract';
import mod from '../server/index.ts';
import words from '../words.json' with { type: 'json' };

/** Small deterministic RNG (mulberry32) so word picks look like the real seeded one. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fakeCtx(players: PlayerRef[], rng: () => number = seeded(42)) {
  const clock = { now: 1_700_000_000_000 };
  const ctx: InstanceContext = {
    gameId: 'g1',
    instanceId: 'i1',
    rng,
    now: () => clock.now,
    players: () => players,
    schedule: () => {},
    cancel: () => {},
    emit: () => {},
    mediaUrl: (ref) => ref,
  };
  return { ctx, clock };
}

const ada: PlayerRef = { id: 'p1', displayName: 'Ada', connected: true };
const bea: PlayerRef = { id: 'p2', displayName: 'Bea', connected: true };

const config = { maxPoints: 10, pointsPerWord: 2 };

type State = ReturnType<typeof mod.createInstance>;

const sub = (playerId: string, word: string, succeeded: boolean): Submission<{ word: string; succeeded: boolean }> => ({
  id: `s-${playerId}-${word}`,
  playerId,
  payload: { word, succeeded },
  startedAt: 0,
  submittedAt: 1,
  judgements: [],
});

/** Start an attempt, answer the word it hands out, and return the new state and the word. */
function play(state: State, ctx: InstanceContext, who: PlayerRef, succeeded: boolean): { state: State; word: string } {
  expect(mod.canStart!(state, who, ctx)).toMatchObject({ ok: true });
  const started = mod.onAttemptStart!(state, who, ctx);
  const word = started.players[who.id]!.current!;
  expect(mod.validateInput(started, who, { word, succeeded }, ctx)).toEqual({ ok: true });
  return { state: mod.handleInput(started, who, { word, succeeded }, ctx), word };
}

describe('secret-word', () => {
  it('has a consistent manifest: automatic, immediate, one word per attempt', () => {
    expect(mod.manifest).toMatchObject({ id: 'secret-word', version: '1.0.0', apiVersion: '2', results: 'immediate', attempts: 'repeat', resubmission: 'none' });
    expect(mod.manifest.evaluation).toEqual({ mode: 'automatic' });
  });

  it('ships a built-in list of well over 1000 different words', () => {
    const list = words as string[];
    expect(list.length).toBeGreaterThanOrEqual(1000);
    expect(new Set(list.map((w) => w.toLowerCase())).size).toBe(list.length);
    expect(list.every((w) => /^[a-z]+$/.test(w))).toBe(true);
  });

  it('hands out words one at a time: the next only after answering the current one', () => {
    const { ctx } = fakeCtx([ada]);
    let state = mod.createInstance(config, ctx);
    expect(mod.canStart!(state, ada, ctx)).toEqual({ ok: true, hint: 'Get word 1 of 5' });
    state = mod.onAttemptStart!(state, ada, ctx);
    const first = state.players.p1!.current!;
    expect(first).toBeTruthy();
    // Leaving and coming back (or the engine restarting the attempt) keeps the same word.
    expect(mod.onAttemptStart!(state, ada, ctx).players.p1!.current).toBe(first);
    expect(mod.validateInput(state, ada, { word: 'not-mine', succeeded: true }, ctx)).toEqual({ ok: false, reason: 'That is not your current word' });
    expect(mod.validateInput(state, ada, { word: first } as never, ctx)).toEqual({ ok: false, reason: 'Say whether it worked' });

    state = mod.handleInput(state, ada, { word: first, succeeded: true }, ctx);
    expect(state.players.p1).toMatchObject({ current: null, history: [{ word: first, succeeded: true }] });
    // A late second tap on the old screen does not answer anything.
    expect(mod.validateInput(state, ada, { word: first, succeeded: false }, ctx)).toMatchObject({ ok: false });
    expect(mod.canStart!(state, ada, ctx)).toEqual({ ok: true, hint: 'Get word 2 of 5' });
  });

  it('stops after maxPoints / pointsPerWord words', () => {
    const { ctx } = fakeCtx([ada]);
    let state = mod.createInstance(config, ctx);
    for (let i = 0; i < 5; i++) state = play(state, ctx, ada, i % 2 === 0).state;
    expect(mod.canStart!(state, ada, ctx)).toEqual({ ok: false, reason: 'All your words are done' });
    expect(mod.playerNote!(state, ada, ctx)).toBe('5/5 words · 3 unnoticed');

    // Uneven: 10 points at 3 per word = 3 words; more per word than the maximum = 1 word worth the maximum.
    expect(mod.canStart!(mod.createInstance({ maxPoints: 10, pointsPerWord: 3 }, ctx), ada, ctx)).toEqual({ ok: true, hint: 'Get word 1 of 3' });
    const big = mod.createInstance({ maxPoints: 10, pointsPerWord: 25 }, ctx);
    expect(mod.canStart!(big, ada, ctx)).toEqual({ ok: true, hint: 'Get word 1 of 1' });
    expect(mod.evaluate(big, [sub('p1', 'x', true)], ctx).points).toBe(10);
  });

  it('never gives two players the same word: 100 players × 10 words', () => {
    const players = Array.from({ length: 100 }, (_, i): PlayerRef => ({ id: `p${i}`, displayName: `P${i}`, connected: true }));
    const { ctx } = fakeCtx(players, seeded(7));
    let state = mod.createInstance({ maxPoints: 10, pointsPerWord: 1 }, ctx);
    const handed: string[] = [];
    for (let round = 0; round < 10; round++) {
      for (const p of players) {
        const next = play(state, ctx, p, round % 3 === 0);
        handed.push(next.word);
        state = next.state;
      }
    }
    expect(handed).toHaveLength(1000);
    expect(new Set(handed).size).toBe(1000);
  });

  it('uses the host’s own words instead, and shares them out again once they run out', () => {
    const { ctx } = fakeCtx([ada, bea]);
    let state = mod.createInstance({ maxPoints: 3, pointsPerWord: 1, customWords: ' Fiets, paraplu\nfiets\n\n  hagelslag  ;' }, ctx);
    const got: string[] = [];
    for (const who of [ada, bea, ada]) {
      const next = play(state, ctx, who, true);
      got.push(next.word);
      state = next.state;
    }
    // Duplicates ("fiets") and blanks are dropped: exactly three different words.
    expect(new Set(got)).toEqual(new Set(['Fiets', 'paraplu', 'hagelslag']));
    // All three are used now: the next word repeats one rather than leaving Bea without a word.
    const extra = play(state, ctx, bea, false);
    expect(['Fiets', 'paraplu', 'hagelslag']).toContain(extra.word);
  });

  it('scores each answered word on its own: points only for unnoticed words', () => {
    const { ctx } = fakeCtx([ada]);
    const state = mod.createInstance(config, ctx);
    const yes = mod.evaluate(state, [sub('p1', 'pineapple', true)], ctx);
    const no = mod.evaluate(state, [sub('p1', 'volcano', false)], ctx);
    expect(yes).toEqual({ playerId: 'p1', displayName: 'Ada', word: 'pineapple', succeeded: true, points: 2 });
    expect(no).toMatchObject({ succeeded: false, points: 0 });
    expect(mod.calculateScores(state, yes, ctx)).toEqual([{ playerId: 'p1', points: 2, reason: 'Slipped “pineapple” in unnoticed' }]);
    expect(mod.calculateScores(state, no, ctx)).toEqual([{ playerId: 'p1', points: 0, reason: '“volcano” did not work out' }]);
    expect(mod.getStatistics(state, [yes, no], ctx)).toEqual({ wordsPlayed: 2, succeeded: 1, spotted: 1, successRate: 50, players: 1, best: { name: 'Ada', words: 1 } });
    expect(mod.getStatistics(state, [], ctx)).toMatchObject({ wordsPlayed: 0, successRate: null, best: null });
  });

  it('shows only the player’s own word, with yes/no answers and a way back to the board', () => {
    const { ctx } = fakeCtx([ada, bea]);
    let state = mod.createInstance(config, ctx);
    state = mod.onAttemptStart!(state, ada, ctx);
    state = mod.onAttemptStart!(state, bea, ctx);
    const adaWord = state.players.p1!.current!;
    const beaWord = state.players.p2!.current!;
    expect(adaWord).not.toBe(beaWord);
    const view = mod.guestView(state, ada, ctx);
    const json = JSON.stringify(view.ui);
    expect(view.canSubmit).toBe(true);
    expect(view.status).toBe('Word 1 of 5 · keep it secret!');
    expect(json).toContain(adaWord);
    expect(json).not.toContain(beaWord);
    expect(json).toContain(JSON.stringify({ word: adaWord, succeeded: true }));
    expect(json).toContain(JSON.stringify({ word: adaWord, succeeded: false }));
    expect(json).toContain('Back');
    // Nothing public gives a word away.
    expect(JSON.stringify(mod.mainView!(state, ctx))).not.toContain(adaWord);
    expect(JSON.stringify(mod.introView!(state, ada, ctx))).toContain('5 words');
  });

  it('results rank players by unnoticed words and reveal the words that slipped by', () => {
    const { ctx } = fakeCtx([ada, bea]);
    const state = mod.createInstance(config, ctx);
    const evaluations = [
      mod.evaluate(state, [sub('p1', 'pineapple', true)], ctx),
      mod.evaluate(state, [sub('p1', 'volcano', false)], ctx),
      mod.evaluate(state, [sub('p2', 'submarine', true)], ctx),
      mod.evaluate(state, [sub('p2', 'lighthouse', true)], ctx),
    ];
    const results = mod.resultsView(state, evaluations, ctx);
    const rows = (results.ui as { children: { type: string; rows?: { name: string; value: string; points: number }[] }[] }).children.find((n) => n.type === 'ranking')!.rows!;
    expect(rows).toMatchObject([
      { rank: 1, name: 'Bea', value: '2 of 2 unnoticed', points: 4 },
      { rank: 2, name: 'Ada', value: '1 of 2 unnoticed', points: 2 },
    ]);
    const shared = JSON.stringify(results.ui);
    expect(shared).toContain('Bea: submarine, lighthouse');
    expect(shared).toContain('Ada: pineapple');
    expect(shared).not.toContain('volcano');
    const mine = JSON.stringify(results.guestUi!(ada));
    expect(mine).toContain('1 of 2');
    expect(mine).toContain('pineapple');
    expect(JSON.stringify(mod.resultsView(state, [], ctx).ui)).toContain('Nobody has answered yet');
  });
});
