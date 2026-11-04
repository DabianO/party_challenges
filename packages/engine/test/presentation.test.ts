import { describe, expect, it } from 'vitest';
import type { GameEvent, GameSnapshot } from '@challenge/contract';
import { Engine, MemoryRepository, ModuleRegistry } from '../src/index.ts';
import { locate, move, type DeckSlide } from '../src/presentation.ts';
import fillInTheBlanks from '../../../challenges/fill-in-the-blanks/server/index.ts';
import binaries from '../../../challenges/binaries/server/index.ts';
import closestNumber from '../../../challenges/closest-number/server/index.ts';
import colorMatch from '../../../challenges/color-match/server/index.ts';
import groupMessage from '../../../challenges/group-message/server/index.ts';
import { createFakeTime } from './helpers.ts';

const deck: DeckSlide[] = [
  { instanceId: 'a', slide: 0, steps: 3, stepSeconds: 4 },
  { instanceId: 'a', slide: 1, steps: 1, stepSeconds: 4 },
  { instanceId: 'b', slide: 0, steps: 1, stepSeconds: 10 },
];

describe('presentation moves', () => {
  it('steps through a slide, then on to the next; slides skip the remaining steps', () => {
    const at = { instanceId: 'a', slide: 0, step: 0, index: 0 };
    expect(move(deck, at, 'next')).toEqual({ instanceId: 'a', slide: 0, step: 1, index: 0 });
    expect(move(deck, { ...at, step: 2 }, 'next')).toEqual({ instanceId: 'a', slide: 1, step: 0, index: 1 });
    expect(move(deck, at, 'next-slide')).toEqual({ instanceId: 'a', slide: 1, step: 0, index: 1 });
    expect(move(deck, { instanceId: 'b', slide: 0, step: 0, index: 2 }, 'next')).toBeNull();
    // Back: a step, or the previous slide from its start; "previous slide" first goes back to the start of this one.
    expect(move(deck, { ...at, step: 2 }, 'previous')).toEqual({ ...at, step: 1 });
    expect(move(deck, { instanceId: 'a', slide: 1, step: 0, index: 1 }, 'previous')).toEqual(at);
    expect(move(deck, { ...at, step: 2 }, 'previous-slide')).toEqual(at);
    expect(move(deck, at, 'previous-slide')).toBeNull();
    expect(move(deck, at, { instanceId: 'b' })).toEqual({ instanceId: 'b', slide: 0, step: 0, index: 2 });
    expect(move(deck, at, { instanceId: 'c' })).toBeNull();
  });

  it('keeps its place when challenges drop out of the deck', () => {
    expect(locate(deck, { instanceId: 'a', slide: 1, step: 0, index: 1 })).toEqual({ instanceId: 'a', slide: 1, step: 0, index: 1 });
    // "a" was reopened: its slides are gone; the slide that took its place in the running order.
    const without = deck.filter((d) => d.instanceId !== 'a');
    expect(locate(without, { instanceId: 'a', slide: 1, step: 2, index: 1 })).toEqual({ instanceId: 'b', slide: 0, step: 0, index: 0 });
    // Fewer steps than before: the last one.
    expect(locate([{ ...deck[0]!, steps: 2 }], { instanceId: 'a', slide: 0, step: 2, index: 0 })).toMatchObject({ step: 1 });
    expect(locate([], { instanceId: 'a', slide: 0, step: 0, index: 0 })).toBeNull();
  });
});

function setup() {
  const registry = new ModuleRegistry();
  for (const mod of [fillInTheBlanks, binaries, closestNumber, colorMatch, groupMessage]) registry.register(mod as never, null);
  const time = createFakeTime();
  const events: GameEvent[] = [];
  const engine = new Engine({
    registry,
    repo: new MemoryRepository(),
    sink: { emit: (e) => events.push(e), kickPlayer: () => {} },
    joinUrl: (code) => `http://localhost/join/${code}`,
    mediaUrl: (ref) => ref,
    clock: time.clock,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    random: () => 0,
  });
  return { engine, time, events };
}

function lastSnapshot(events: GameEvent[], audience: string): GameSnapshot {
  const e = [...events].reverse().find((ev) => ev.type === 'GAME_STATE_SNAPSHOT' && ev.audience === audience);
  if (!e) throw new Error(`no snapshot for ${audience}`);
  return e.payload as GameSnapshot;
}

describe('the results presentation', () => {
  it('shows closed challenges as slides on the big screen, stepped by the host or played by itself', () => {
    const { engine, time, events } = setup();
    const { runtime: game } = engine.createGame({ name: 'Party' });
    const blanks = game.addChallenge('fill-in-the-blanks', { sentences: [{ text: 'Parties need ___.' }, { text: '___ and ___ walk into a bar' }] }, { title: 'Blanks' });
    const yesNo = game.addChallenge('binaries', { statements: [{ text: 'Pineapple belongs on pizza' }] }, { category: 'Hot Takes' });
    game.addChallenge('closest-number', { question: 'Jar?', correctAnswer: 7, timeLimit: 30 });
    game.performHostAction({ action: 'open-lobby' });
    const ada = game.join('Ada').player;
    const bea = game.join('Bea').player;
    game.connect({ role: 'host' });
    game.connect({ role: 'main' });
    game.connect({ role: 'player', playerId: ada.id });
    game.performHostAction({ action: 'start-game' });
    const main = () => lastSnapshot(events, 'main').presentation;
    const host = () => lastSnapshot(events, 'host');
    const go = (to: Parameters<typeof move>[2]) => game.performHostAction({ action: 'move-presentation', to });

    expect(() => game.performHostAction({ action: 'start-presentation' })).toThrow(/No closed challenge/);
    game.startAttempt(ada.id, blanks.id);
    game.submit(ada.id, blanks.id, { s0b0: 'snacks', s1b0: 'A duck', s1b1: 'a goose' }, true);
    game.startAttempt(bea.id, blanks.id);
    game.submit(bea.id, blanks.id, { s0b0: 'music' }, true);
    game.startAttempt(ada.id, yesNo.id);
    game.moduleAction(ada.id, yesNo.id, { answer: { id: 's0', value: 1 } });
    game.performHostAction({ action: 'close-challenge', instanceId: blanks.id });
    // Only closed challenges can be presented.
    expect(host().presentationDeck).toEqual([{ instanceId: blanks.id, title: 'Blanks', category: '', slides: 2, included: false }]);
    expect(() => game.performHostAction({ action: 'start-presentation', instanceIds: [yesNo.id] })).toThrow(/nothing to present \(is it closed\?\)/);
    game.performHostAction({ action: 'close-challenge', instanceId: yesNo.id });

    // Hidden results do not matter: slides carry no points.
    const playerSnapshots = () => events.filter((e) => e.type === 'GAME_STATE_SNAPSHOT' && e.audience === `player:${ada.id}`).length;
    const phones = playerSnapshots();
    game.performHostAction({ action: 'start-presentation' });
    // Only the host and the big screen show it: phones get no snapshot for its steps.
    expect(playerSnapshots()).toBe(phones);
    expect(main()).toMatchObject({ instanceId: blanks.id, title: 'Blanks', caption: 'Sentence 1 of 2', slide: 0, slideCount: 2, step: 0, stepCount: 2, index: 0, total: 3, autoplay: false, endsAt: null });
    expect(main()!.ui).toMatchObject({ type: 'spool', index: 0 });
    expect(host().presentation).toEqual(main());
    expect(host().presentationDeck.map((d) => [d.title, d.slides, d.included])).toEqual([
      ['Blanks', 2, true],
      ['Binaries', 1, true],
    ]);
    expect(lastSnapshot(events, `player:${ada.id}`).presentation).toBeNull();

    go('next');
    expect(main()).toMatchObject({ slide: 0, step: 1, ui: { type: 'spool', index: 1 } });
    go('next');
    expect(main()).toMatchObject({ slide: 1, step: 0, stepCount: 1, index: 1 });
    go('previous');
    expect(main()).toMatchObject({ slide: 0, step: 0, index: 0 });
    go('next-slide');
    go('next-slide');
    expect(main()).toMatchObject({ instanceId: yesNo.id, category: 'Hot Takes', index: 2 });
    go('next'); // the end: nothing happens
    expect(main()).toMatchObject({ index: 2 });
    go({ instanceId: blanks.id, slide: 1 });
    expect(main()).toMatchObject({ instanceId: blanks.id, slide: 1 });
    expect(() => go({ instanceId: blanks.id, slide: 5 })).toThrow(/not in the presentation/);

    // Playing by itself: each step for its time, then it stops on the last slide.
    go({ instanceId: blanks.id });
    game.performHostAction({ action: 'autoplay-presentation', on: true });
    expect(main()!.endsAt! - main()!.startedAt).toBe(4_000);
    time.advance(4_000);
    expect(main()).toMatchObject({ slide: 0, step: 1, autoplay: true });
    time.advance(4_000);
    time.advance(4_000);
    expect(main()).toMatchObject({ instanceId: yesNo.id, autoplay: false, endsAt: null });
    // Playing again from the end starts over.
    game.performHostAction({ action: 'autoplay-presentation', on: true });
    expect(main()).toMatchObject({ index: 0, step: 0, autoplay: true });
    game.performHostAction({ action: 'autoplay-presentation', on: false });
    expect(main()).toMatchObject({ autoplay: false, endsAt: null });
    time.advance(60_000);
    expect(main()).toMatchObject({ index: 0, step: 0 });

    // A reopened challenge drops out; the presentation goes on with the rest.
    game.performHostAction({ action: 'reopen-challenge', instanceId: blanks.id });
    expect(main()).toMatchObject({ instanceId: yesNo.id, index: 0, total: 1 });

    // A finished game can still be presented: that is what it is for.
    game.performHostAction({ action: 'end-game' });
    game.performHostAction({ action: 'close-game' });
    game.performHostAction({ action: 'start-presentation', instanceIds: [blanks.id, yesNo.id] });
    expect(main()).toMatchObject({ instanceId: blanks.id, total: 3 });
    game.performHostAction({ action: 'stop-presentation' });
    expect(main()).toBeNull();
    expect(() => go('next')).toThrow(/No presentation is running/);
  });

  it('switches replays on for modules that suggest them', () => {
    const { engine } = setup();
    const { runtime: game } = engine.createGame({ name: 'Party' });
    expect(game.addChallenge('color-match', {}).allowReplay).toBe(true);
    expect(game.addChallenge('color-match', {}, { allowReplay: false }).allowReplay).toBe(false);
    expect(game.addChallenge('binaries', { statements: [{ text: 'Cats' }] }).allowReplay).toBe(false);
  });

  it('puts a challenge’s line in the big screen’s top bar while it is open', () => {
    const { engine, events } = setup();
    const { runtime: game } = engine.createGame({ name: 'Party' });
    const story = game.addChallenge('group-message', { prompt: 'Story' });
    game.performHostAction({ action: 'open-lobby' });
    const ada = game.join('Ada').player;
    game.connect({ role: 'host' });
    game.connect({ role: 'main' });
    game.connect({ role: 'player', playerId: ada.id });
    game.performHostAction({ action: 'start-game' });
    const banner = (audience: string) => lastSnapshot(events, audience).challenges.find((c) => c.id === story.id)!.displayBanner;
    expect(banner('main')!.map((p) => p.text).join('')).toBe("✍️ Ada's turn to write: open your phone");
    expect(banner('main')![1]).toEqual({ text: 'Ada', color: expect.stringMatching(/^#[0-9a-f]{6}$/i) });
    expect(banner('host')).toBeUndefined();
    expect(banner(`player:${ada.id}`)).toBeUndefined();
    game.performHostAction({ action: 'close-challenge', instanceId: story.id });
    expect(banner('main')).toBeNull();
  });
});

describe('continuing a closed game', () => {
  it('reopens every closed challenge at once; Hot Takes give their points back and players carry on', () => {
    const { engine, events } = setup();
    const { runtime: game } = engine.createGame({ name: 'Party' });
    const yesNo = game.addChallenge('binaries', { statements: [{ text: 'Cats rule' }], pointsPerAnswer: 3 });
    const blanks = game.addChallenge('fill-in-the-blanks', { sentences: [{ text: 'A party needs ___.' }], pointsPerSentence: 2 });
    game.performHostAction({ action: 'open-lobby' });
    const ada = game.join('Ada').player;
    game.join('Bea');
    game.connect({ role: 'host' });
    game.performHostAction({ action: 'start-game' });
    const total = () => lastSnapshot(events, 'host').leaderboard.find((e) => e.playerId === ada.id)!.total;
    expect(() => game.performHostAction({ action: 'reopen-challenge', instanceId: yesNo.id })).toThrow(/already open/);

    game.startAttempt(ada.id, yesNo.id);
    game.moduleAction(ada.id, yesNo.id, { answer: { id: 's0', value: 1 } });
    game.startAttempt(ada.id, blanks.id);
    game.submit(ada.id, blanks.id, { s0b0: 'snacks' }, true);
    game.performHostAction({ action: 'end-game' });
    game.performHostAction({ action: 'close-game' });
    expect(total()).toBe(5);
    game.performHostAction({ action: 'reopen-game' });
    const rows = game.doc.ledger.length;

    expect(game.performHostAction({ action: 'reopen-all-challenges' })).toEqual({ ok: true, message: '2 challenges open again' });
    expect(game.doc.instances.map((i) => i.phase)).toEqual(['ACTIVE', 'ACTIVE']);
    // The Hot Take's points come back at its next close; Fill in the Blanks keeps Ada's.
    expect(total()).toBe(2);
    expect(game.doc.ledger.length).toBeGreaterThan(rows); // reversal rows, never deletions
    // Ada carries on answering the Hot Take; her sentences stay played.
    expect(game.attemptOf(yesNo.id, ada.id)?.status).toBe('in_progress');
    expect(game.moduleAction(ada.id, yesNo.id, { answer: { id: 's0', value: 0 } })).toEqual({ ok: true });
    expect(game.startAttempt(ada.id, blanks.id)).toMatchObject({ ok: false });
    expect(game.performHostAction({ action: 'reopen-all-challenges' })).toEqual({ ok: true, message: 'Every challenge is already open' });

    game.performHostAction({ action: 'close-challenge', instanceId: yesNo.id });
    expect(total()).toBe(5);
    // Reopening a single one works the same way, as often as needed.
    game.performHostAction({ action: 'reopen-challenge', instanceId: yesNo.id });
    expect(total()).toBe(2);
    game.performHostAction({ action: 'close-challenge', instanceId: yesNo.id });
    expect(total()).toBe(5);
  });
});
