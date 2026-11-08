import { describe, expect, it } from 'vitest';
import type { InstanceContext, PlayerRef, QuickRoundsNode, Submission, UINode } from '@challenge/contract';
import { walkUI } from '@challenge/contract';
import mod, { DEFAULT_LEVELS } from '../server/index.ts';

const ada: PlayerRef = { id: 'p1', displayName: 'Ada', connected: true };
const bea: PlayerRef = { id: 'p2', displayName: 'Bea', connected: true };

/** A seeded RNG, so deals are random but repeatable. */
function fakeCtx(seed = 7) {
  let s = seed;
  const clock = { now: 1_700_000_000_000 };
  const ctx: InstanceContext = {
    gameId: 'g1',
    instanceId: 'i1',
    rng: () => {
      s = (s * 1103515245 + 12345) % 2 ** 31;
      return s / 2 ** 31;
    },
    now: () => clock.now,
    players: () => [ada, bea],
    schedule: () => {},
    cancel: () => {},
    emit: () => {},
    mediaUrl: (ref) => ref,
  };
  return { ctx, clock };
}

/** Level 1 gets 2 s here, so the timing checks below stay simple. */
const config = { rounds: 10, levels: [{ ...DEFAULT_LEVELS[0]!, secondsPerRound: 2 }, DEFAULT_LEVELS[1]!, DEFAULT_LEVELS[2]!] };
type State = ReturnType<typeof mod.createInstance>;

function quickRounds(node: UINode): QuickRoundsNode {
  let found: QuickRoundsNode | undefined;
  walkUI(node, (n) => {
    if (n.type === 'quick-rounds') found = n;
  });
  return found!;
}

const ink: Record<string, string> = { '#ef4444': 'red', '#3b82f6': 'blue', '#22c55e': 'green', '#facc15': 'yellow', '#a855f7': 'purple', '#f97316': 'orange' };

/** Start a try at a level and answer it: `right` correct answers first, the rest wrong, each in `ms`. */
function play(state: State, ctx: InstanceContext, who: PlayerRef, right: number, ms = 600, level = '1') {
  state = mod.onAttemptStart!(state, who, ctx);
  const start = { colors: 'start', choice: level };
  expect(mod.validateAction!(state, who, start, ctx)).toEqual({ ok: true });
  state = mod.onAction!(state, who, start, ctx);
  const node = quickRounds(mod.guestView(state, who, ctx).ui);
  const answers = node.rounds.map((r, i) => {
    const correct = ink[r.prompt.color!]!;
    return { choice: i < right ? correct : r.options.find((o) => o.id !== correct)!.id, ms };
  });
  const input = { colors: { runId: node.runId!, answers } };
  expect(mod.validateInput(state, who, input, ctx)).toEqual({ ok: true });
  state = mod.handleInput(state, who, input, ctx);
  return { state, input, node };
}

const sub = (playerId: string, input: { colors: { runId: string; answers: { choice: string | null; ms: number }[] } }, submittedAt: number): Submission<typeof input> => ({
  id: `s-${playerId}`,
  playerId,
  payload: input,
  startedAt: 0,
  submittedAt,
  judgements: [],
});

describe('color-match', () => {
  it('has a consistent manifest: automatic, immediate, replays on by default', () => {
    expect(mod.manifest).toMatchObject({ id: 'color-match', version: '1.2.0', apiVersion: '2', category: 'skill', results: 'immediate', suggestedReplay: true });
    expect(mod.manifest.evaluation).toEqual({ mode: 'automatic' });
  });

  it('deals words in a different colour on Start, never the same set twice', () => {
    const { ctx } = fakeCtx();
    let state = mod.onAttemptStart!(mod.createInstance(config, ctx), ada, ctx);
    expect(quickRounds(mod.guestView(state, ada, ctx).ui)).toMatchObject({ runId: null, rounds: [] });
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) {
      state = mod.onAction!(state, ada, { colors: 'start' }, ctx);
      const node = quickRounds(mod.guestView(state, ada, ctx).ui);
      expect(node.rounds).toHaveLength(10);
      for (const [j, r] of node.rounds.entries()) {
        expect(r.options.map((o) => o.id)).toEqual(['red', 'blue', 'green', 'yellow']);
        // The word never names its own colour, and neither repeats straight after itself.
        expect(r.prompt.text.toLowerCase()).not.toBe(ink[r.prompt.color!]);
        const prev = node.rounds[j - 1];
        if (prev) {
          expect(r.prompt.color).not.toBe(prev.prompt.color);
          expect(r.prompt.text).not.toBe(prev.prompt.text);
        }
      }
      const key = JSON.stringify(node.rounds.map((r) => r.prompt));
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    expect(new Set(state.dealt.p1).size).toBe(30);
  });

  it('deals a different set even when the random numbers repeat (e.g. after a server restart)', () => {
    const { ctx } = fakeCtx();
    let state = mod.createInstance(config, ctx);
    state = mod.onAction!(state, ada, { colors: 'start' }, fakeCtx(3).ctx);
    const first = JSON.stringify(state.runs.p1!.deals);
    state = mod.onAction!(state, ada, { colors: 'start' }, fakeCtx(3).ctx);
    expect(JSON.stringify(state.runs.p1!.deals)).not.toBe(first);
  });

  it('only takes answers to the words on screen', () => {
    const { ctx } = fakeCtx();
    const { state, input } = play(mod.createInstance(config, ctx), ctx, ada, 10);
    expect(mod.validateInput(state, ada, { colors: { ...input.colors, runId: 'r999' } }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, ada, { colors: { ...input.colors, answers: input.colors.answers.slice(1) } }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, ada, { colors: { ...input.colors, answers: input.colors.answers.map((a) => ({ ...a, ms: 2500 })) } }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, bea, input, ctx)).toMatchObject({ ok: false, reason: 'Pick a level to play' });
    expect(mod.validateAction!(state, ada, { colors: 'stop' }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateAction!(state, ada, { colors: 'start', choice: '4' }, ctx)).toMatchObject({ ok: false });
  });

  it('scores a point per correct tap; a try that took too long does not count', () => {
    const { ctx, clock } = fakeCtx();
    const { state, input } = play(mod.createInstance(config, ctx), ctx, ada, 7, 800);
    const dealt = state.runs.p1!.dealtAt;
    const e = mod.evaluate(state, [sub('p1', input, dealt + 3000 + 10 * 900)], ctx);
    expect(e).toMatchObject({ correct: 7, wrong: 3, missed: 0, rounds: 10, avgMs: 800, tooSlow: false, points: 7 });
    expect(mod.calculateScores(state, e, ctx)).toEqual([{ playerId: 'p1', points: 7, reason: 'Level 1: 7 of 10 colours right' }]);
    // Ten rounds of 2 s with a 3 s countdown, gaps and 5 s of network: well under 31 s.
    const slow = mod.evaluate(state, [sub('p1', input, dealt + 40_000)], ctx);
    expect(slow).toMatchObject({ tooSlow: true, points: 0 });
    // A tap at the limit is a miss.
    const late = { colors: { ...input.colors, answers: input.colors.answers.map((a, i) => (i === 0 ? { ...a, ms: 2000 } : a)) } };
    expect(mod.evaluate(state, [sub('p1', late, dealt + 5000)], ctx)).toMatchObject({ correct: 6, missed: 1 });
    expect(clock.now).toBe(dealt);
  });

  it('gives practice feedback across replays and ranks players by score, then speed', () => {
    const { ctx } = fakeCtx();
    let state = mod.createInstance(config, ctx);
    // Each try is evaluated as soon as it is submitted (immediate results).
    const first = play(state, ctx, ada, 8, 700);
    state = first.state;
    const adaBest = mod.evaluate(state, [sub('p1', first.input, 0)], ctx);
    expect(mod.playerNote!(state, ada, ctx)).toBe('Level 1: 8 of 10 right · 0.70 s per word');
    state = play(state, ctx, ada, 6, 500).state;
    expect(mod.playerNote!(state, ada, ctx)).toBe('Level 1: 6 of 10 right · 0.50 s per word · best 8 points');
    const bTry = play(state, ctx, bea, 8, 600);
    state = bTry.state;
    // With replays the engine hands over each player's best try.
    const evaluations = [adaBest, mod.evaluate(state, [sub('p2', bTry.input, 0)], ctx)];
    const json = JSON.stringify(mod.resultsView(state, evaluations, ctx).ui);
    expect(json).toMatch(/"name":"Bea","value":"L1 · 8\/10 · 0.60 s","points":8.*"name":"Ada","value":"L1 · 8\/10 · 0.70 s"/);
    expect(mod.getStatistics(state, evaluations, ctx)).toMatchObject({ tries: 2, perfect: 0, best: { name: 'Bea', correct: 8 } });
  });

  it('lets the player pick one of three levels, each with its own colours, time and points', () => {
    const { ctx } = fakeCtx();
    let state = mod.createInstance({ rounds: 10, levels: DEFAULT_LEVELS }, ctx);
    // The numbers per level, on the intro and on the start buttons.
    const intro = JSON.stringify(mod.introView!(state, ada, ctx));
    expect(intro).toContain('"label":"Level 2","value":"5 colours · 1 s per word · 2 points per correct tap"');
    state = mod.onAttemptStart!(state, ada, ctx);
    expect(quickRounds(mod.guestView(state, ada, ctx).ui).choices).toEqual([
      { id: '1', label: 'Level 1', detail: '4 colours · 1.5 s per word · 1 point per correct tap' },
      { id: '2', label: 'Level 2', detail: '5 colours · 1 s per word · 2 points per correct tap' },
      { id: '3', label: 'Level 3', detail: '6 colours · 0.75 s per word · 3 points per correct tap' },
    ]);
    const third = play(state, ctx, ada, 8, 500, '3');
    expect(third.node).toMatchObject({ secondsPerRound: 0.75 });
    expect(third.node.rounds[0]!.options).toHaveLength(6);
    const e = mod.evaluate(third.state, [sub('p1', third.input, third.state.runs.p1!.dealtAt + 5000)], ctx);
    expect(e).toMatchObject({ level: 3, correct: 8, points: 24 });
    // Level 3 answers are checked against its own time: 0.8 s is too late.
    expect(mod.validateInput(third.state, ada, { colors: { ...third.input.colors, answers: third.input.colors.answers.map((a) => ({ ...a, ms: 800 })) } }, ctx)).toMatchObject({ ok: false });
    // Without a choice (an older phone page): level 1.
    const plain = mod.onAction!(mod.onAttemptStart!(state, bea, ctx), bea, { colors: 'start' }, ctx);
    expect(quickRounds(mod.guestView(plain, bea, ctx).ui)).toMatchObject({ secondsPerRound: 1.5 });
    expect(quickRounds(mod.guestView(plain, bea, ctx).ui).rounds[0]!.options).toHaveLength(4);
  });

  it('presents the room taps and levels without names, points or rankings', () => {
    const { ctx } = fakeCtx();
    let state = mod.createInstance(config, ctx);
    expect(mod.presentation!(state, [], ctx)).toEqual([]);
    const a = play(state, ctx, ada, 8, 700);
    state = a.state;
    const b = play(state, ctx, bea, 10, 500, '2');
    state = b.state;
    const evaluations = [mod.evaluate(state, [sub('p1', a.input, 0)], ctx), mod.evaluate(state, [sub('p2', b.input, 0)], ctx)];
    const slides = mod.presentation!(state, evaluations, ctx);
    expect(slides.map((s) => s.caption)).toEqual(['Tap the colour, not the word', 'Levels played']);
    expect(slides[0]!.steps).toHaveLength(2);
    const json = JSON.stringify(slides);
    expect(json).toContain('"text":"20"'); // colour words in both tries
    expect(json).toContain('1 perfect try');
    expect(json).toContain('{"label":"Right colour","value":18,"tone":"success"}');
    expect(json).toContain('{"label":"Fell for the word","value":2,"tone":"danger"}');
    expect(json).toContain('On average 9 of 10 right · 0.59 s per correct tap'); // (8 × 0.7 + 10 × 0.5) / 18
    expect(json).toMatch(/"label":"Level 1 · [^"]*","value":1\}.*"label":"Level 2 · [^"]*","value":1\}/);
    expect(json).not.toMatch(/Ada|Bea|points"|"ranking"/);
  });

  it('plays games made before levels with the default levels', () => {
    const { ctx } = fakeCtx();
    const old = mod.createInstance({ rounds: 10, secondsPerRound: 2, colors: 4, pointsPerCorrect: 1 } as never, ctx);
    expect(JSON.stringify(mod.introView!(old, ada, ctx))).toContain('Level 3');
  });
});
