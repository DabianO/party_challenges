import { describe, expect, it } from 'vitest';
import type { GameEvent, GameSnapshot } from '@challenge/contract';
import { Engine, MemoryRepository, ModuleRegistry } from '../src/index.ts';
import { emptySpotlight, pickSpotlight, type SpotlightCandidate } from '../src/spotlight.ts';
import slidingScales from '../../../challenges/sliding-scales/server/index.ts';
import binaries from '../../../challenges/binaries/server/index.ts';
import closestNumber from '../../../challenges/closest-number/server/index.ts';
import { createFakeTime } from './helpers.ts';

const c = (key: string, activity: number): SpotlightCandidate => ({ key, activity });

describe('pickSpotlight', () => {
  it('shows the item with the most new answers since it was last shown', () => {
    const state = { ...emptySpotlight(), seen: { a: 5, b: 0 } };
    // a: 7 - 5 = 2 new, b: 3 new, c: 1 new.
    expect(pickSpotlight([c('a', 7), c('b', 3), c('c', 1)], state, null, () => 0)).toEqual({ key: 'b', round: ['b'] });
  });

  it('picks at random when nothing has new answers, and never the item on screen when there are others', () => {
    const state = { ...emptySpotlight(), seen: { a: 2, b: 1, c: 0 } };
    const items = [c('a', 2), c('b', 1), c('c', 0)];
    expect(pickSpotlight(items, state, null, () => 0)?.key).toBe('a');
    expect(pickSpotlight(items, state, null, () => 0.99)?.key).toBe('c');
    expect(pickSpotlight(items, state, 'a', () => 0)?.key).toBe('b');
    expect(pickSpotlight([c('a', 9)], { ...state, round: ['a'] }, 'a', () => 0)).toEqual({ key: 'a', round: ['a'] });
    expect(pickSpotlight([], state, null, () => 0)).toBeNull();
  });

  it('shows every item once before any item is shown again', () => {
    // b keeps getting answers, but a and c have not had their turn yet.
    const state = { ...emptySpotlight(), seen: { b: 0 }, round: ['b'] };
    expect(pickSpotlight([c('a', 0), c('b', 50), c('c', 0)], state, 'b', () => 0)).toEqual({ key: 'a', round: ['b', 'a'] });
    // All shown: a new round starts, and the busiest goes first.
    const full = { ...emptySpotlight(), seen: { a: 0, b: 0, c: 0 }, round: ['b', 'a', 'c'] };
    expect(pickSpotlight([c('a', 0), c('b', 50), c('c', 0)], full, 'c', () => 0)).toEqual({ key: 'b', round: ['b'] });
    // Items that went away no longer count towards the round.
    expect(pickSpotlight([c('a', 0), c('b', 0)], { ...emptySpotlight(), round: ['a', 'gone'] }, null, () => 0)).toEqual({ key: 'b', round: ['a', 'b'] });
  });
});

function setup() {
  const registry = new ModuleRegistry();
  registry.register(slidingScales as never, null);
  registry.register(binaries as never, null);
  registry.register(closestNumber as never, null);
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

describe('the big screen spotlight', () => {
  it('rotates through the statements of open Hot Takes, a minute each, busiest first', () => {
    const { engine, time, events } = setup();
    const { runtime: game } = engine.createGame({ name: 'Hot takes' });
    const scales = game.addChallenge('sliding-scales', { statements: [{ text: 'Shower minutes', min: 0, max: 60 }, { text: 'Pets', min: 0, max: 5 }] }, { category: 'Hot Takes' });
    const yesNo = game.addChallenge('binaries', { statements: [{ text: 'Taylor Swift is overrated' }] }, { title: 'Yes or no', category: 'Hot Takes' });
    game.addChallenge('closest-number', { question: 'Jar?', correctAnswer: 7, timeLimit: 30 });
    game.performHostAction({ action: 'open-lobby' });
    const ada = game.join('Ada').player;
    const bea = game.join('Bea').player;
    game.connect({ role: 'main' });
    game.connect({ role: 'player', playerId: ada.id });
    expect(game.doc.spotlight.current).toBeNull();

    game.performHostAction({ action: 'start-game' });
    // Nobody answered yet: a random statement (random() = 0 → the first one), for a minute.
    const shown = () => lastSnapshot(events, 'main').spotlight;
    expect(shown()).toMatchObject({ instanceId: scales.id, itemId: 's0', category: 'Hot Takes', total: 3 });
    expect(shown()!.endsAt - shown()!.startedAt).toBe(60_000);
    expect(JSON.stringify(shown()!.ui)).toContain('Shower minutes');
    expect(lastSnapshot(events, `player:${ada.id}`).spotlight).toBeNull();

    // Answers come in: the yes/no statement gets the most, and it updates live on screen.
    for (const p of [ada, bea]) {
      expect(game.startAttempt(p.id, yesNo.id)).toEqual({ ok: true });
      expect(game.moduleAction(p.id, yesNo.id, { answer: { id: 's0', value: 1 } })).toEqual({ ok: true });
    }
    expect(game.startAttempt(ada.id, scales.id)).toEqual({ ok: true });
    expect(game.moduleAction(ada.id, scales.id, { answer: { id: 's1', value: 2 } })).toEqual({ ok: true });
    expect(game.moduleAction(ada.id, scales.id, { answer: { id: 's0', value: 9 } })).toEqual({ ok: true });
    time.advance(300);
    expect(JSON.stringify(shown()!.ui)).toContain('1 answer');

    time.advance(60_000);
    expect(shown()).toMatchObject({ instanceId: yesNo.id, itemId: 's0', title: 'Yes or no' });
    time.advance(60_000);
    // The last one of the round, although s0 has a new answer since it was shown.
    expect(shown()).toMatchObject({ instanceId: scales.id, itemId: 's1' });
    time.advance(60_000);
    // New round: s0 got an answer after it was shown, the others got none since.
    expect(shown()).toMatchObject({ instanceId: scales.id, itemId: 's0' });
    expect(game.doc.spotlight.round).toEqual([`${scales.id}/s0`]);

    // Closing a challenge takes its statements off the screen at once.
    game.performHostAction({ action: 'close-challenge', instanceId: scales.id });
    expect(shown()).toMatchObject({ instanceId: yesNo.id });
    // The game ends: nothing in the spotlight, and no timer keeps running for it.
    game.performHostAction({ action: 'end-game' });
    expect(shown()).toBeNull();
    const before = events.length;
    time.advance(10 * 60_000);
    expect(events.length).toBe(before);
  });

  it('lets the host show a chosen item now, or keep it on screen until released', () => {
    const { engine, time, events } = setup();
    const { runtime: game } = engine.createGame({ name: 'Host picks' });
    const scales = game.addChallenge('sliding-scales', { statements: [{ text: 'Shower minutes', min: 0, max: 60 }, { text: 'Pets', min: 0, max: 5 }] });
    const yesNo = game.addChallenge('binaries', { statements: [{ text: 'Cats beat dogs' }] });
    game.performHostAction({ action: 'open-lobby' });
    game.connect({ role: 'main' });
    game.connect({ role: 'host' });
    game.performHostAction({ action: 'start-game' });
    const shown = () => lastSnapshot(events, 'main').spotlight;
    expect(lastSnapshot(events, 'host').spotlightChoices).toEqual([
      { instanceId: scales.id, title: 'Sliding Scales', itemId: 's0', label: 'Shower minutes', activity: 0 },
      { instanceId: scales.id, title: 'Sliding Scales', itemId: 's1', label: 'Pets', activity: 0 },
      { instanceId: yesNo.id, title: 'Binaries', itemId: 's0', label: 'Cats beat dogs', activity: 0 },
    ]);
    expect(lastSnapshot(events, 'main').spotlightChoices).toEqual([]);

    // Show now: a fresh minute, then the rotation carries on.
    time.advance(30_000);
    game.performHostAction({ action: 'show-spotlight', instanceId: yesNo.id, itemId: 's0' });
    expect(shown()).toMatchObject({ instanceId: yesNo.id, itemId: 's0', held: false });
    expect(shown()!.endsAt - shown()!.startedAt).toBe(60_000);
    time.advance(60_000);
    expect(shown()).toMatchObject({ instanceId: scales.id, itemId: 's1' });

    // Hold: it stays however long, until released; then the next one comes up at once.
    game.performHostAction({ action: 'show-spotlight', instanceId: scales.id, itemId: 's0', hold: true });
    expect(shown()).toMatchObject({ itemId: 's0', held: true });
    time.advance(10 * 60_000);
    expect(shown()).toMatchObject({ instanceId: scales.id, itemId: 's0', held: true });
    game.performHostAction({ action: 'release-spotlight' });
    expect(shown()).toMatchObject({ held: false });
    expect(shown()!.itemId === 's0' && shown()!.instanceId === scales.id).toBe(false);

    expect(() => game.performHostAction({ action: 'show-spotlight', instanceId: scales.id, itemId: 's9' })).toThrow(/not available/);
    // A held item whose challenge closes makes way at once.
    game.performHostAction({ action: 'show-spotlight', instanceId: yesNo.id, itemId: 's0', hold: true });
    game.performHostAction({ action: 'close-challenge', instanceId: yesNo.id });
    expect(shown()).toMatchObject({ instanceId: scales.id, held: false });
  });

  it('waits for something to show, and holds while the game is paused', () => {
    const { engine, time, events } = setup();
    const { runtime: game } = engine.createGame({ name: 'Later' });
    game.addChallenge('closest-number', { question: 'Jar?', correctAnswer: 7, timeLimit: 30 });
    game.performHostAction({ action: 'open-lobby' });
    game.connect({ role: 'main' });
    game.performHostAction({ action: 'start-game' });
    expect(lastSnapshot(events, 'main').spotlight).toBeNull();
    // A Hot Take added mid-game shows within a few seconds.
    const added = game.addChallenge('binaries', { statements: [{ text: 'Cats beat dogs' }] });
    time.advance(5_000);
    expect(lastSnapshot(events, 'main').spotlight).toMatchObject({ instanceId: added.id, itemId: 's0' });
    // Pausing holds the rotation; resuming carries on.
    game.performHostAction({ action: 'pause' });
    time.advance(120_000);
    expect(game.doc.spotlight.current?.instanceId).toBe(added.id);
    game.performHostAction({ action: 'resume' });
    expect(lastSnapshot(events, 'main').spotlight).toMatchObject({ instanceId: added.id });
  });
});
