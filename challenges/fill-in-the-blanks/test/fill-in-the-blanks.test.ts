import { describe, expect, it } from 'vitest';
import type { InstanceContext, PlayerRef, SpoolNode, Submission } from '@challenge/contract';
import mod from '../server/index.ts';

const players: PlayerRef[] = ['Ada', 'Bea', 'Cyd'].map((name, i) => ({ id: `p${i + 1}`, displayName: name, connected: true }));

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

const config = {
  sentences: [{ text: 'The best thing about parties is ___.' }, { text: '___ and ___ walk into a bar' }, { text: 'No blank here' }],
  pointsPerSentence: 2,
  timeLimit: 0,
  showNames: true,
};

type State = ReturnType<typeof mod.createInstance>;

const sub = (playerId: string, payload: Record<string, unknown>): Submission<Record<string, unknown>> => ({
  id: `s-${playerId}`,
  playerId,
  payload,
  startedAt: 0,
  submittedAt: 1,
  judgements: [],
});

function fill(state: State, who: PlayerRef, payload: Record<string, unknown>) {
  state = mod.onAttemptStart!(state, who, ctx);
  expect(mod.validateInput(state, who, payload, ctx)).toEqual({ ok: true });
  state = mod.handleInput(state, who, payload, ctx);
  return { state, evaluation: mod.evaluate(state, [sub(who.id, payload)], ctx) };
}

describe('fill-in-the-blanks', () => {
  it('has a consistent manifest: creativity, automatic, immediate', () => {
    expect(mod.manifest).toMatchObject({ id: 'fill-in-the-blanks', version: '1.3.0', apiVersion: '2', category: 'creativity', results: 'immediate', resubmission: 'replace' });
    expect(mod.manifest.evaluation).toEqual({ mode: 'automatic' });
  });

  it('asks for every blank; a sentence without one gets it at the end', () => {
    const state = mod.createInstance(config, ctx);
    const json = JSON.stringify(mod.guestView(state, players[0]!, ctx).ui);
    for (const name of ['s0b0', 's1b0', 's1b1', 's2b0']) expect(json).toContain(`"name":"${name}"`);
    expect(json).not.toContain('"name":"s0b1"');
    expect(json).toContain('___(1) and ___(2) walk into a bar');
    expect(json).toContain('No blank here ___');
    // Staying anonymous is offered up front, and off unless the player switches it on.
    expect(json).toContain('{"type":"toggle","name":"anonymous","label":"Stay anonymous","value":false}');
    expect(JSON.stringify(mod.guestView(mod.createInstance({ ...config, showNames: false }, ctx), players[0]!, ctx).ui)).not.toContain('anonymous');
  });

  it('leaves the name off for players who chose to stay anonymous', () => {
    let state = mod.createInstance(config, ctx);
    const a = fill(state, players[0]!, { s0b0: 'the snacks', anonymous: false });
    const b = fill(a.state, players[1]!, { s0b0: 'the music', anonymous: true });
    state = b.state;
    expect(b.evaluation).toMatchObject({ anonymous: true, completed: 1 });
    expect(mod.playerNote!(state, players[1]!, ctx)).toBe('1 of 3 sentences filled in, anonymously');
    const spool = mod.presentation!(state, [a.evaluation, b.evaluation], ctx)[0]!.steps[0] as SpoolNode;
    expect(spool.entries).toEqual([{ blanks: ['the snacks'], by: 'Ada' }, { blanks: ['the music'] }]);
    const results = JSON.stringify(mod.resultsView(state, [a.evaluation, b.evaluation], ctx).ui);
    expect(results).toContain('"value":"Anonymous"');
    expect(results).not.toContain('Bea');
    expect(mod.validateInput(state, players[2]!, { s0b0: 'x', anonymous: 'yes' }, ctx)).toMatchObject({ ok: false });
  });

  it('scores every completed sentence and ignores half-filled ones', () => {
    const { evaluation } = fill(mod.createInstance(config, ctx), players[0]!, { s0b0: '  the  snacks ', s1b0: 'A duck', s1b1: '', s2b0: 'ok' });
    expect(evaluation).toMatchObject({ completed: 2, points: 4, blanks: [['the snacks'], ['A duck', ''], ['ok']] });
    expect(mod.calculateScores(mod.createInstance(config, ctx), evaluation, ctx)).toEqual([{ playerId: 'p1', points: 4, reason: '2 sentences filled in' }]);
  });

  it('needs at least one complete sentence and short entries', () => {
    const state = mod.createInstance(config, ctx);
    expect(mod.validateInput(state, players[0]!, { s1b0: 'only one' }, ctx)).toMatchObject({ ok: false, reason: 'Fill in every blank of at least one sentence' });
    expect(mod.validateInput(state, players[0]!, { s0b0: 'x'.repeat(41) }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, players[0]!, { s0b0: 42 }, ctx)).toMatchObject({ ok: false });
  });

  it('presents a slide per sentence with every entry rolling through its blanks', () => {
    let state = mod.createInstance(config, ctx);
    const evaluations = [];
    for (const [p, payload] of [
      [players[0]!, { s0b0: 'the snacks', s1b0: 'A duck', s1b1: 'a goose' }],
      [players[1]!, { s0b0: 'going home early' }],
      [players[2]!, { s0b0: 'cake', s1b0: 'Bob', s1b1: 'Alice' }],
    ] as const) {
      const r = fill(state, p, payload);
      state = r.state;
      evaluations.push(r.evaluation);
    }
    const slides = mod.presentation!(state, evaluations, ctx);
    // The third sentence has no entries: no slide.
    expect(slides.map((s) => [s.caption, s.steps.length])).toEqual([
      ['Sentence 1 of 3', 3],
      ['Sentence 2 of 3', 2],
    ]);
    const step = slides[1]!.steps[1] as SpoolNode;
    expect(step).toEqual({
      type: 'spool',
      parts: ['', ' and ', ' walk into a bar'],
      entries: [
        { blanks: ['A duck', 'a goose'], by: 'Ada' },
        { blanks: ['Bob', 'Alice'], by: 'Cyd' },
      ],
      index: 1,
    });
    // Every step of a slide is the same sentence: only the entry shown changes.
    expect(slides[0]!.steps.map((s) => (s as SpoolNode).index)).toEqual([0, 1, 2]);
    expect(slides[0]!.stepSeconds).toBe(4);
    // Names stay off the big screen when the host says so.
    const anonymous = mod.presentation!({ ...state, config: { ...config, showNames: false } }, evaluations, ctx);
    expect(JSON.stringify(anonymous)).not.toContain('"by"');
  });

  it('lists everyone’s sentences in the results', () => {
    let state = mod.createInstance(config, ctx);
    const a = fill(state, players[0]!, { s0b0: 'the snacks' });
    state = a.state;
    const results = mod.resultsView(state, [a.evaluation], ctx);
    expect(JSON.stringify(results.ui)).toContain('"label":"The best thing about parties is the snacks.","value":"Ada"');
    expect(JSON.stringify(results.guestUi!(players[0]!))).toContain('+2 points');
  });

  it('shows the sentences on the big screen while open: the first at once, then a new one a minute', () => {
    const scheduled: string[] = [];
    const timed: InstanceContext = { ...ctx, schedule: (tag, seconds) => void scheduled.push(`${tag}:${seconds}`), cancel: (tag) => void scheduled.push(`cancel:${tag}`) };
    let state = mod.onPhaseChange!(mod.createInstance(config, timed), 'ACTIVE', timed);
    expect(scheduled).toEqual(['feed:60']);
    expect(JSON.stringify(mod.displayPanel!(state, timed))).toContain('appear here as they come in');
    state = fill(state, players[0]!, { s0b0: 'the snacks', s1b0: 'A duck', s1b1: 'a goose' }).state;
    // Ada's first sentence at once.
    const first = mod.displayPanel!(state, timed);
    expect(JSON.stringify(first)).toContain('"entries":[{"blanks":["the snacks"],"by":"Ada"}],"index":0');
    expect(JSON.stringify(first)).toContain('2 sentences so far');
    state = fill(state, players[1]!, { s0b0: 'the music', anonymous: true }).state;
    // A minute later: the next one that came in (Ada's second sentence), then Bea's.
    state = mod.onTimer!(state, 'feed', timed);
    expect(JSON.stringify(mod.displayPanel!(state, timed))).toContain('"parts":[""," and "," walk into a bar"],"entries":[{"blanks":["A duck","a goose"],"by":"Ada"}]');
    state = mod.onTimer!(state, 'feed', timed);
    // Bea's goes with Ada's for the same sentence (it rolls in), without her name.
    expect(JSON.stringify(mod.displayPanel!(state, timed))).toContain('"entries":[{"blanks":["the snacks"],"by":"Ada"},{"blanks":["the music"]}],"index":1');
    // Nothing new: it stays.
    const before = JSON.stringify(mod.displayPanel!(state, timed));
    state = mod.onTimer!(state, 'feed', timed);
    expect(JSON.stringify(mod.displayPanel!(state, timed))).toBe(before);
    expect(scheduled.filter((t) => t === 'feed:60')).toHaveLength(4);
    // Closed: nothing on the big screen.
    state = mod.onPhaseChange!(state, 'LOCKED', timed);
    expect(mod.displayPanel!(state, timed)).toBeNull();
    expect(scheduled.at(-1)).toBe('cancel:feed');
  });
});

describe('fill-in-the-blanks: save and come back', () => {
  it('keeps saved words, offers Save before Done, and feeds each sentence once', () => {
    const ada = players[0]!;
    let state = mod.onPhaseChange!(mod.createInstance(config, ctx), 'ACTIVE', ctx);
    state = mod.onAttemptStart!(state, ada, ctx);
    state = mod.handleInput(state, ada, { s0b0: 'the snacks' }, ctx);
    // Back later: the first sentence is still filled in; the second is added and saved again.
    const view = JSON.stringify(mod.guestView(state, ada, ctx).ui);
    expect(view).toContain('"name":"s0b0"');
    expect(view).toContain('"value":"the snacks"');
    expect(view.indexOf('"final":false')).toBeGreaterThan(-1);
    expect(view.indexOf('Save')).toBeLessThan(view.indexOf('Done: lock in'));
    expect(mod.guestView(state, ada, ctx).status).toBe('1 of 3 sentences saved · come back any time');
    state = mod.handleInput(state, ada, { s0b0: 'the snacks!', s1b0: 'A duck', s1b1: 'a goose' }, ctx);
    expect(state.feed).toEqual([
      { playerId: 'p1', sentence: 0 },
      { playerId: 'p1', sentence: 1 },
    ]);
    expect(state.entries.p1![0]).toEqual(['the snacks!']);
  });

  it('shows a player only their own sentences until the challenge is closed', () => {
    let state = mod.onPhaseChange!(mod.createInstance(config, ctx), 'ACTIVE', ctx);
    const a = fill(state, players[0]!, { s0b0: 'the snacks' });
    const b = fill(a.state, players[1]!, { s0b0: 'the music' });
    state = b.state;
    const open = JSON.stringify(mod.resultsView(state, [a.evaluation, b.evaluation], ctx).guestUi!(players[0]!));
    expect(open).toContain('the snacks');
    expect(open).not.toContain('the music');
    state = mod.onPhaseChange!(state, 'LOCKED', ctx);
    expect(JSON.stringify(mod.resultsView(state, [a.evaluation, b.evaluation], ctx).guestUi!(players[0]!))).toContain('the music');
  });
});
