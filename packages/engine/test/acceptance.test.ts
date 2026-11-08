/**
 * Architecture acceptance test (spec §21.3):
 * "The MVP passes if all modules are implemented without a single change to the core
 * engine." Every module discovered in /challenges is driven through a complete board game
 * by the generic engine, using only the public contract — including the peer/host
 * evaluation pipeline and instance-level host resolution.
 */
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import type { BoardEntry, GameEvent, GameSnapshot, UINode } from '@challenge/contract';
import { walkUI } from '@challenge/contract';
import { Engine, MemoryRepository, ModuleRegistry, discoverModules, type GameRuntime } from '../src/index.ts';
import { createFakeTime } from './helpers.ts';

const CHALLENGES_DIR = resolve(import.meta.dirname, '../../../challenges');

const EXPECTED_MODULES = [
  'agree-to-disagree',
  'balloon-pop',
  'binaries',
  'blob-war',
  'caption-this',
  'closest-number',
  'color-match',
  'fill-in-the-blanks',
  'group-message',
  'image-memory',
  'likelihoods',
  'majority-vote',
  'match-up',
  'multi-answer',
  'multiple-choice',
  'name-them-all',
  'numeric-answer',
  'open-performance',
  'photo-hunt',
  'prediction',
  'report-pick',
  'report-score',
  'rivalries',
  'secret-word',
  'selfiemotion',
  'sliding-scales',
  'stop-the-clock',
  'time-estimation',
  'timed-reaction',
];

interface Scenario {
  configuration: Record<string, unknown>;
  /** Payload each player submits (index = player index); `entry` is their live board tile. */
  inputs: (playerIndex: number, entry: BoardEntry) => unknown;
  /** Live-action modules: players send this action (repeatedly) instead of submitting. */
  action?: (playerIndex: number) => unknown;
  /** Milliseconds to advance after Start before submitting (e.g. to pass a reveal phase). */
  advanceBeforeSubmit?: number;
  /** Instance-level host resolution payload (onClose modules with hostResolutionView). */
  resolution?: Record<string, unknown>;
  /** The module ends a player's part after one entry (`canStart` → finished): no replay. */
  noReplay?: boolean;
  /** A live action sent right after Start, before submitting (e.g. dealing quick rounds). */
  prepare?: unknown;
}

const SCENARIOS: Record<string, Scenario> = {
  // Live actions: players pump their blobs; scored on territory when the host closes it.
  'blob-war': {
    configuration: { points: 10, tapsToMax: 50 },
    inputs: () => ({}),
    action: (i) => ({ pump: 10 * (i + 1) }),
  },
  'multiple-choice': {
    configuration: { question: 'Capital of France?', options: ['Paris', 'Rome', 'Oslo'], correctIndex: 0, timeLimit: 20 },
    inputs: (i) => ({ answer: i === 0 ? 'A' : 'B' }),
  },
  'numeric-answer': {
    configuration: { question: 'Legs on a spider?', correctAnswer: 8, timeLimit: 20 },
    inputs: (i) => ({ answer: i === 0 ? 8 : 6 }),
  },
  'closest-number': {
    configuration: { question: 'Golf balls?', correctAnswer: 137, timeLimit: 30 },
    inputs: (i) => ({ answer: 100 + i * 20 }),
  },
  'timed-reaction': {
    configuration: { minDelaySeconds: 1, maxDelaySeconds: 1, windowSeconds: 4, maxPoints: 10 },
    advanceBeforeSubmit: 1_500, // past GO
    inputs: () => ({ tap: true }),
  },
  'image-memory': {
    configuration: { image: 'media://test-image', viewSeconds: 3, question: 'How many cups?', options: ['3', '4', '5'], correctIndex: 1, answerSeconds: 20 },
    advanceBeforeSubmit: 3_500, // past the hide timer
    inputs: (i) => ({ answer: i === 0 ? 'B' : 'A' }),
  },
  'majority-vote': {
    configuration: { question: 'Pineapple on pizza?', options: ['Yes', 'No'], timeLimit: 20 },
    inputs: (i) => ({ answer: i < 2 ? 'A' : 'B' }),
  },
  'caption-this': {
    configuration: { image: 'media://pic', prompt: 'Caption it', timeLimit: 60 },
    inputs: (i) => ({ caption: `Caption ${i}` }),
  },
  'photo-hunt': {
    configuration: { task: 'Photograph something red', timeLimit: 120 },
    inputs: (i) => ({ photo: `media://photo${i}` }),
  },
  'open-performance': {
    configuration: { prompt: 'Best pitch for a paperclip', timeLimit: 60 },
    inputs: (i) => ({ text: `Pitch ${i}` }),
  },
  'multi-answer': {
    configuration: { question: 'Capitals?', answers: [{ label: 'France', answer: 'Paris' }, { label: 'Italy', answer: 'Rome' }], points: 10 },
    inputs: (i) => ({ a0: 'paris', a1: i === 0 ? 'rome' : 'Milan' }),
  },
  // Turn-taking: the loop below plays players in join order, which is the turn order.
  'group-message': {
    configuration: { prompt: 'Birthday message', wordsPerTurn: 3, turnSeconds: 300, maxTurnsPerPlayer: 10 },
    inputs: (i) => ({ words: ['Happy birthday', 'to you', 'dear friend'][i] }),
  },
  // Self-judged, one word per attempt: answer about the word the player's screen shows.
  // The number is the score (decided outside the app), up to the maximum; then the player is done.
  // An option tapped from the host's list (a ball drawn from a bag); one pick each by default.
  'report-pick': {
    configuration: { prompt: 'Which ball?', options: [{ label: 'Gold', points: 10, color: '#f2c230' }, { label: 'Black', points: -3 }] },
    inputs: (i) => ({ option: String(i % 2) }),
    noReplay: true,
  },
  'report-score': {
    configuration: { prompt: 'Darts score?', maxPoints: 20, penalty: 5 },
    inputs: (i) => ({ value: i === 0 ? 17 : 4 + i }),
    noReplay: true,
  },
  'secret-word': {
    configuration: { maxPoints: 10, pointsPerWord: 2 },
    inputs: (i, entry) => ({ ...submitPayloads(entry.view)[0], succeeded: i !== 1 }),
  },
  // Timed on the phone: the submitted time matches the server's own measurement.
  // Quick rounds: Start deals the words (a live action), then the answers are submitted.
  'color-match': {
    configuration: { rounds: 5 },
    prepare: { colors: 'start', choice: '2' },
    inputs: (_i, entry) => {
      let runId: string | null = null;
      walkUI(entry.view!, (n) => {
        if (n.type === 'quick-rounds') runId = n.runId;
      });
      return { colors: { runId, answers: Array.from({ length: 5 }, () => ({ choice: 'red', ms: 500 })) } };
    },
  },
  'time-estimation': {
    configuration: { targetSeconds: 5, fullPointsMs: 500, zeroPointsMs: 10_000 },
    inputs: (i) => ({ clock: 5000 + 400 * i }),
    advanceBeforeSubmit: 5000,
  },
  selfiemotion: {
    configuration: { timeLimit: 120 },
    inputs: (i) => ({ photo: `media://selfie${i}` }),
  },
  'fill-in-the-blanks': {
    configuration: { sentences: [{ text: 'A party needs ___.' }, { text: '___ and ___ walk into a bar' }] },
    inputs: (i) => ({ s0b0: `snacks ${i}`, s1b0: 'A duck', s1b1: `goose ${i}` }),
  },
  'stop-the-clock': {
    configuration: { targetSeconds: 2, hideAfterSeconds: 1, maxPoints: 10, fullPointsMs: 50, zeroPointsMs: 2000 },
    inputs: (i) => ({ clock: 2000 + 40 * i }),
    advanceBeforeSubmit: 2000,
  },
  // Hot Takes: answers are live actions on statements, changeable until the challenge closes.
  // Live actions: the shared crosshair moves once the first balloon is up (half a minute after the start).
  'balloon-pop': {
    configuration: { intervalMinutes: 0.5, pointsPerPop: 1 },
    advanceBeforeSubmit: 31_000,
    inputs: () => ({}),
    action: (i) => ({ aim: { move: [i + 1, -1] } }),
  },
  // Live actions: links on each player's own sheet (one of two pairs, so Lock in is refused); scored at the close.
  'match-up': {
    configuration: { pairs: [{ left: 'Paris', right: 'France' }, { left: 'Rome', right: 'Italy' }], pointsPerMatch: 2 },
    inputs: () => ({}),
    action: (i) => ({ link: { left: 'a0', right: `b${i % 2}` } }),
  },
  // Entries are live actions; "I'm done" submits nothing (the entries are in state).
  'name-them-all': {
    configuration: { prompt: 'Planets', answers: [{ answer: 'Mercury' }, { answer: 'Venus' }], pointsEach: 1, timeLimit: 60 },
    prepare: { guess: 'venus' },
    inputs: () => ({}),
  },
  'sliding-scales': {
    configuration: { statements: [{ text: 'Shower minutes', min: 0, max: 60, unit: 'min' }], pointsPerAnswer: 1 },
    inputs: () => ({}),
    action: (i) => ({ answer: { id: 's0', value: 10 * (i + 1) } }),
  },
  rivalries: {
    configuration: { statements: [{ left: 'Star Wars', right: 'Star Trek', middle: 'Basically the same' }], pointsPerAnswer: 1 },
    inputs: () => ({}),
    action: (i) => ({ answer: { id: 's0', value: i - 1 } }),
  },
  binaries: {
    configuration: { statements: [{ text: 'Taylor Swift is overrated' }], pointsPerAnswer: 1 },
    inputs: () => ({}),
    action: (i) => ({ answer: { id: 's0', value: i % 2 } }),
  },
  likelihoods: {
    configuration: { statements: [{ text: 'The world ends because of climate change' }], pointsPerAnswer: 1 },
    inputs: () => ({}),
    action: (i) => ({ answer: { id: 's0', value: 30 * i } }),
  },
  'agree-to-disagree': {
    configuration: { statements: [{ text: 'Pineapple belongs on pizza' }], pointsPerAnswer: 1 },
    inputs: () => ({}),
    action: (i) => ({ answer: { id: 's0', value: 2 * i } }),
  },
  prediction: {
    configuration: { question: 'Who wins the next round?', optionsSource: 'custom', options: ['Team A', 'Team B'], timeLimit: 20 },
    inputs: (i) => ({ answer: i === 0 ? 'o0' : 'o1' }),
    resolution: { outcome: 'o0' },
  },
};

/** Fixed payloads of the submit buttons in a view (e.g. "yes" / "no" answers). */
function submitPayloads(node: UINode | null): Record<string, unknown>[] {
  if (!node || typeof node !== 'object') return [];
  const own = node.type === 'button' && node.payload ? [node.payload] : [];
  const children = 'children' in node && Array.isArray(node.children) ? (node.children as UINode[]) : [];
  return [...own, ...children.flatMap(submitPayloads)];
}

async function loadAll() {
  const registry = new ModuleRegistry();
  const result = await discoverModules(CHALLENGES_DIR, registry);
  return { registry, result };
}

function lastSnapshot(events: GameEvent[], audience: string): GameSnapshot {
  const e = [...events].reverse().find((ev) => ev.type === 'GAME_STATE_SNAPSHOT' && ev.audience === audience);
  if (!e) throw new Error(`no snapshot for ${audience}`);
  return e.payload as GameSnapshot;
}

describe('architecture acceptance: every module runs on the unmodified engine', () => {
  it('discovers all modules without load failures', async () => {
    const { registry, result } = await loadAll();
    expect(result.failed).toEqual([]);
    expect(registry.list().map((m) => m.manifest.id).sort()).toEqual(EXPECTED_MODULES);
    for (const m of registry.list()) {
      expect(m.manifest.apiVersion).toBe('2');
      expect(m.manifest.capabilities.length).toBeGreaterThan(0);
      if (m.manifest.evaluation.mode !== 'automatic') expect(m.manifest.evaluation.criteria).toBeTruthy();
    }
  });

  // One game with every module: it grows with the library, so it gets more time than the default (below).
  it('plays a full board game with every module; peers and host judge where required', async () => {
    const { registry } = await loadAll();
    const time = createFakeTime();
    const events: GameEvent[] = [];
    const engine = new Engine({
      registry,
      repo: new MemoryRepository(),
      sink: { emit: (e) => events.push(e), kickPlayer: () => {} },
      joinUrl: (c) => `http://test/join/${c}`,
      mediaUrl: (ref) => ref.replace('media://', '/media/'),
      clock: time.clock,
      setTimer: time.setTimer,
      clearTimer: time.clearTimer,
      random: () => 0,
    });
    const { runtime: game } = engine.createGame({ name: 'Acceptance', settings: { judgeDeadlineSeconds: 60 } });

    const ids = registry.list().map((m) => m.manifest.id);
    const instances = new Map<string, string>();
    for (const id of ids) {
      const scenario = SCENARIOS[id];
      expect(scenario, `missing scenario for ${id}`).toBeDefined();
      // Every module that scores submissions on their own must support replays.
      const replayable = registry.latest(id)!.manifest.results === 'immediate';
      instances.set(id, game.addChallenge(id, scenario!.configuration, { title: `The ${id} one`, allowReplay: replayable }).id);
    }

    /** The scenario's live action right after Start, and the snapshot it causes. */
    const prepare = (id: string, playerId: string, instId: string) => {
      const action = SCENARIOS[id]!.prepare;
      if (action === undefined) return;
      expect(game.moduleAction(playerId, instId, action), `${id}: prepare`).toEqual({ ok: true });
      time.advance(300); // throttled snapshot
    };

    game.performHostAction({ action: 'open-lobby' });
    const players = ['Ada', 'Grace', 'Linus'].map((n) => game.join(n).player);
    game.connect({ role: 'host' });
    game.connect({ role: 'main' });
    for (const p of players) game.connect({ role: 'player', playerId: p.id });
    game.performHostAction({ action: 'start-game' });

    for (const id of ids) {
      const instId = instances.get(id)!;
      const inst = game.getInstance(instId);
      const manifest = registry.get(inst.moduleId, inst.moduleVersion)!.manifest;
      expect(inst.phase, `${id} should be open`).toBe('ACTIVE');

      // Every player plays at a different moment.
      for (let i = 0; i < players.length; i++) {
        const p = players[i]!;
        expect(game.startAttempt(p.id, instId), `${id}: start for player ${i}`).toEqual({ ok: true });
        expect(inst.error, `${id}: start error ${inst.error}`).toBeNull();
        prepare(id, p.id, instId);
        const entry = lastSnapshot(events, `player:${p.id}`).board.find((b) => b.instanceId === instId)!;
        expect(entry.status).toBe('in_progress');
        expect(entry.view, `${id}: guest view`).not.toBeNull();
        if (SCENARIOS[id]!.advanceBeforeSubmit) time.advance(SCENARIOS[id]!.advanceBeforeSubmit!);
        // Player 0 uses the one-tap final submit; the others submit and then finish.
        const action = SCENARIOS[id]!.action;
        if (action) {
          expect(game.submit(p.id, instId, SCENARIOS[id]!.inputs(i, entry))).toMatchObject({ ok: false });
          for (let k = 0; k < 3; k++) expect(game.moduleAction(p.id, instId, action(i)), `${id}: action by player ${i}`).toEqual({ ok: true });
          time.advance(300); // throttled snapshot
          expect(game.attemptOf(instId, p.id)?.status, `${id}: live attempt stays open`).toBe('in_progress');
        } else {
          const res = game.submit(p.id, instId, SCENARIOS[id]!.inputs(i, entry), i === 0);
          expect(res, `${id}: submission by player ${i}: ${JSON.stringify(res)}`).toEqual({ ok: true });
          if (manifest.resubmission === 'replace' && i > 0) expect(game.finishAttempt(p.id, instId)).toEqual({ ok: true });
          expect(game.attemptOf(instId, p.id)?.status, `${id}: attempt locked after submit`).not.toBe('in_progress');
        }
        expect(inst.error, `${id}: error after submit ${inst.error}`).toBeNull();
        time.advance(5_000);
      }
      // Replays: player 0 plays every immediate-results module a second time.
      const replayable = manifest.results === 'immediate' && !SCENARIOS[id]!.noReplay;
      const ada = players[0]!;
      expect(lastSnapshot(events, `player:${ada.id}`).board.find((b) => b.instanceId === instId)!.canReplay, `${id}: canReplay`).toBe(replayable);
      if (replayable) {
        expect(game.startAttempt(ada.id, instId), `${id}: replay start`).toEqual({ ok: true });
        prepare(id, ada.id, instId);
        if (SCENARIOS[id]!.advanceBeforeSubmit) time.advance(SCENARIOS[id]!.advanceBeforeSubmit!);
        const again = lastSnapshot(events, `player:${ada.id}`).board.find((b) => b.instanceId === instId)!;
        expect(game.submit(ada.id, instId, SCENARIOS[id]!.inputs(0, again), true), `${id}: replay submit`).toEqual({ ok: true });
        expect(inst.error, `${id}: error after replay ${inst.error}`).toBeNull();
        time.advance(5_000);
      } else {
        expect(game.startAttempt(ada.id, instId)).toMatchObject({ ok: false, reason: SCENARIOS[id]!.action ? /already playing/ : /already played/ });
      }
      // Main display never sees module data beyond public stats.
      const main = lastSnapshot(events, 'main');
      const live = SCENARIOS[id]!.action !== undefined;
      expect(main.challenges.find((c) => c.id === instId)!.stats.submitted).toBe(live ? 0 : 3);
      const panel = main.challenges.find((c) => c.id === instId)!.displayPanel;
      if (registry.latest(id)!.module.displayPanel) expect(panel, `${id}: main display panel`).toBeTruthy();
      expect(lastSnapshot(events, `player:${ada.id}`).challenges.find((c) => c.id === instId)!.displayPanel).toBeUndefined();
      expect(JSON.stringify(main)).not.toContain('"judging"' + ':[{');

      // Peer / host modes: work through the judging tasks and host queue.
      const mode = game.effectiveMode(inst);
      if (mode === 'peer' || mode === 'hybrid') {
        for (let round = 0; round < 3; round++) {
          for (const p of players) {
            for (const task of lastSnapshot(events, `player:${p.id}`).judging.filter((t) => t.instanceId === instId)) {
              expect(JSON.stringify(task.presentation)).not.toContain(p.displayName); // never your own
              expect(game.judge(p.id, task.assignmentId, 'approve')).toEqual({ ok: true });
            }
          }
        }
      }
      for (const item of lastSnapshot(events, 'host').hostQueue.filter((q) => q.instanceId === instId)) {
        game.performHostAction({ action: 'decide', assignmentId: item.assignmentId, decision: 'approve', points: manifest.evaluation.hostScoring ? 8 : undefined });
      }

      game.performHostAction({ action: 'close-challenge', instanceId: instId });
      expect(inst.error, `${id}: close error ${inst.error}`).toBeNull();
      if (inst.phase === 'EVALUATING') {
        const form = lastSnapshot(events, 'host').resolutions.find((r) => r.instanceId === instId);
        expect(form?.form?.ui, `${id}: resolution form`).toBeDefined();
        game.performHostAction({ action: 'resolve', instanceId: instId, payload: {} });
        expect(inst.phase).toBe('EVALUATING'); // empty payload must not complete
        game.performHostAction({ action: 'resolve', instanceId: instId, payload: SCENARIOS[id]!.resolution! });
      }
      expect(inst.phase, `${id}: expected RESULTS`).toBe('RESULTS');
      expect(lastSnapshot(events, 'host').hostQueue.filter((q) => q.instanceId === instId)).toEqual([]);

      const host = lastSnapshot(events, 'host');
      const results = host.results[instId]!;
      expect(results, `${id}: results`).toBeDefined();
      expect(results.generic.submissions).toBe(live ? 0 : replayable ? 4 : 3);
      expect(results.statistics).toBeTypeOf('object');
      // Players learn nothing about the outcome until the host reveals results.
      expect(lastSnapshot(events, 'main').results[instId], `${id}: hidden from main`).toBeUndefined();
      for (const p of players) {
        const entry = lastSnapshot(events, `player:${p.id}`).board.find((b) => b.instanceId === instId)!;
        expect(entry.title).toBe(`The ${id} one`);
        expect(entry, `${id}: ${p.displayName} hidden`).toMatchObject({ status: 'submitted', points: null, result: null });
      }
      game.performHostAction({ action: 'reveal-results' });
      for (const p of players) {
        const entry = lastSnapshot(events, `player:${p.id}`).board.find((b) => b.instanceId === instId)!;
        expect(entry.status, `${id}: ${p.displayName} status`).toBe('scored');
        expect(entry.result, `${id}: ${p.displayName} personal result`).not.toBeNull();
      }
      game.performHostAction({ action: 'hide-results' });
      const stats = host.challenges.find((c) => c.id === instId)!.stats;
      expect(stats).toMatchObject({ started: 3, attempts: replayable ? 4 : 3, submitted: live ? 0 : 3, scored: 3, pendingEvaluations: 0 });
    }

    game.performHostAction({ action: 'end-game' });
    const final = game.snapshotFor({ role: 'host' });
    expect(game.status).toBe('GAME_RESULTS');
    expect(final.leaderboard).toHaveLength(3);
    expect(final.leaderboard[0]!.total).toBeGreaterThan(0);
    expect(final.leaderboard[0]!.completed).toBe(ids.length);
    for (const e of final.leaderboard) {
      // Progress graph: a point per finished challenge, ending at the leaderboard total.
      expect(e.series).toHaveLength(e.completed + 1);
      expect(e.series.at(-1)).toBe(e.total);
    }
    expect(final.challenges.every((c) => c.phase === 'RESULTS')).toBe(true);

    // The results presentation: every module with slides, played to the end on the big screen.
    const presentable = final.presentationDeck.map((d) => d.instanceId);
    const withSlides = ids.filter((id) => registry.latest(id)!.module.presentation).map((id) => instances.get(id)!);
    expect(presentable).toEqual(withSlides);
    for (const id of ['blob-war', 'group-message', 'selfiemotion', 'fill-in-the-blanks', 'binaries']) expect(presentable, id).toContain(instances.get(id));
    game.performHostAction({ action: 'close-game' });
    game.performHostAction({ action: 'start-presentation', autoplay: true });
    const seen = new Set<string>();
    for (let k = 0; k < 500 && lastSnapshot(events, 'main').presentation?.autoplay; k++) {
      const view = lastSnapshot(events, 'main').presentation!;
      seen.add(view.instanceId);
      expect(view.ui).toBeTruthy();
      time.advance(view.endsAt! - view.startedAt);
    }
    const end = lastSnapshot(events, 'main').presentation!;
    expect(end).toMatchObject({ autoplay: false, endsAt: null, index: end.total - 1 });
    expect([...new Set([...seen, end.instanceId])].sort()).toEqual([...presentable].sort());
    expect(lastSnapshot(events, `player:${players[0]!.id}`).presentation).toBeNull();
    game.performHostAction({ action: 'stop-presentation' });
    expect(lastSnapshot(events, 'main').presentation).toBeNull();
    expect(events.some((e) => e.type === 'MODULE_ERROR')).toBe(false);
  }, 20_000);
});

export type { GameRuntime };
