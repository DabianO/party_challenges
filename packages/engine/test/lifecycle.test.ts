import { describe, expect, it } from 'vitest';
import type { GameEvent, GameSnapshot } from '@challenge/contract';
import { Engine, MemoryRepository, ModuleRegistry } from '../src/index.ts';
import closestNumber from '../../../challenges/closest-number/server/index.ts';
import captionThis from '../../../challenges/caption-this/server/index.ts';
import groupMessage from '../../../challenges/group-message/server/index.ts';
import blobWar from '../../../challenges/blob-war/server/index.ts';

import { createFakeTime } from './helpers.ts';

function setup(random: () => number = () => 0) {
  const registry = new ModuleRegistry();
  registry.register(closestNumber as never, null);
  registry.register(captionThis as never, null);
  registry.register(groupMessage as never, null);
  registry.register(blobWar as never, null);
  const time = createFakeTime();
  const events: GameEvent[] = [];
  const kicked: string[] = [];
  const engine = new Engine({
    registry,
    repo: new MemoryRepository(),
    sink: { emit: (e) => events.push(e), kickPlayer: (_g, p) => kicked.push(p) },
    joinUrl: (code) => `http://localhost/join/${code}`,
    mediaUrl: (ref) => ref.replace('media://', '/media/'),
    clock: time.clock,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    random,
  });
  return { engine, registry, time, events, kicked };
}

function lastSnapshot(events: GameEvent[], audience: string): GameSnapshot {
  const e = [...events].reverse().find((ev) => ev.type === 'GAME_STATE_SNAPSHOT' && ev.audience === audience);
  if (!e) throw new Error(`no snapshot for ${audience}`);
  return e.payload as GameSnapshot;
}

const CLOSEST = { question: 'Golf balls in the jar?', correctAnswer: 137, timeLimit: 30 };
const CAPTION = { image: 'media://pic1', prompt: 'Caption it', timeLimit: 60, points: 10 };

describe('board lifecycle', () => {
  it('lets players attempt an onClose challenge at their own pace and scores on close', () => {
    const { engine, time, events } = setup();
    const { runtime: game, hostToken } = engine.createGame({ name: 'Board party' });
    expect(engine.authorizeHost(game.id, hostToken)).toBe(game);
    expect(() => game.addChallenge('closest-number', { question: 'x' })).toThrow(/Invalid configuration/);
    const inst = game.addChallenge('closest-number', CLOSEST);
    expect(inst.availability).toBe('open');
    expect(inst.moduleVersion).toBe('2.0.0');

    game.performHostAction({ action: 'open-lobby' });
    const alice = game.join('Alice').player;
    const bob = game.join('Bob').player;
    const carol = game.join('Carol').player;
    game.connect({ role: 'host' });
    game.connect({ role: 'main' });
    for (const p of [alice, bob, carol]) game.connect({ role: 'player', playerId: p.id });

    // Nothing can be started before the board opens.
    expect(game.startAttempt(alice.id, inst.id)).toMatchObject({ ok: false });
    game.performHostAction({ action: 'start-game' });
    expect(inst.phase).toBe('ACTIVE');

    const board = lastSnapshot(events, `player:${alice.id}`).board;
    expect(board).toHaveLength(1);
    expect(board[0]).toMatchObject({ status: 'available', canSubmit: false });
    expect(JSON.stringify(board[0]!.intro)).toContain('30 seconds');

    // Alice starts and gets her own lock timer; Bob is untouched.
    expect(game.startAttempt(alice.id, inst.id)).toEqual({ ok: true });
    expect(game.startAttempt(alice.id, inst.id)).toEqual({ ok: false, reason: 'You are already playing this challenge' });
    const aliceBoard = lastSnapshot(events, `player:${alice.id}`).board[0]!;
    expect(aliceBoard.status).toBe('in_progress');
    expect(aliceBoard.canSubmit).toBe(true);
    expect(aliceBoard.timers.map((t) => [t.tag, t.playerId])).toEqual([['lock', alice.id]]);
    expect(lastSnapshot(events, `player:${bob.id}`).board[0]).toMatchObject({ status: 'available', timers: [] });

    expect(game.submit(bob.id, inst.id, { answer: 1 })).toMatchObject({ ok: false, reason: 'Submissions are closed' });
    expect(game.submit(alice.id, inst.id, { answer: 'abc' })).toEqual({ ok: false, reason: 'Enter a valid number' });
    expect(game.submit(alice.id, inst.id, { answer: 120 })).toEqual({ ok: true });
    expect(game.submit(alice.id, inst.id, { answer: 130 })).toEqual({ ok: true }); // resubmission: replace
    // Guest view shows only Alice's own guess.
    expect(JSON.stringify(lastSnapshot(events, `player:${alice.id}`).board[0]!.view)).toContain('130');

    // Alice's timer expires → her attempt locks; onClose modules do not score yet.
    time.advance(31_000);
    expect(lastSnapshot(events, `player:${alice.id}`).board[0]).toMatchObject({ status: 'submitted', points: null });
    expect(game.submit(alice.id, inst.id, { answer: 137 })).toMatchObject({ ok: false });

    // Bob starts much later and finishes early.
    time.advance(120_000);
    expect(game.startAttempt(bob.id, inst.id)).toEqual({ ok: true });
    expect(game.submit(bob.id, inst.id, { answer: 200 })).toEqual({ ok: true });
    expect(game.finishAttempt(bob.id, inst.id)).toEqual({ ok: true });
    expect(game.finishAttempt(bob.id, inst.id)).toMatchObject({ ok: false });

    // Carol never plays. Host closes the challenge → aggregate scoring.
    const main = lastSnapshot(events, 'main');
    expect(main.challenges[0]!.stats).toMatchObject({ started: 2, submitted: 2, scored: 0 });
    expect(JSON.stringify(main)).not.toMatch(/\b137\b/); // (ids are random hex, so match whole numbers only)
    game.performHostAction({ action: 'close-challenge', instanceId: inst.id });
    expect(inst.phase).toBe('RESULTS');

    // Results stay hidden from players and the main display until the host reveals them.
    const hiddenMain = lastSnapshot(events, 'main');
    expect(hiddenMain.game.resultsRevealed).toBe(false);
    expect(hiddenMain.results).toEqual({});
    expect(hiddenMain.leaderboard.every((l) => l.total === 0 && l.rank === 0)).toBe(true);
    expect(hiddenMain.challenges[0]!.stats).toMatchObject({ scored: 2, bestPoints: null, averagePoints: null });
    expect(hiddenMain.activity.some((a) => a.kind === 'scored' || a.kind === 'results')).toBe(false);
    expect(lastSnapshot(events, `player:${alice.id}`).board[0]).toMatchObject({ status: 'submitted', points: null, result: null });
    game.performHostAction({ action: 'reveal-results' });
    expect(events.some((e) => e.type === 'RESULTS_REVEALED' && e.audience === 'all')).toBe(true);
    expect(lastSnapshot(events, 'main').leaderboard[0]).toMatchObject({ displayName: 'Alice', total: 10, rank: 1 });

    const host = lastSnapshot(events, 'host');
    expect(host.leaderboard.map((l) => [l.displayName, l.total, l.rank])).toEqual([
      ['Alice', 10, 1],
      ['Bob', 5, 2],
      ['Carol', 0, 3],
    ]);
    expect(host.results[inst.id]!.scores).toEqual([
      { playerId: alice.id, points: 10 },
      { playerId: bob.id, points: 5 },
    ]);
    expect(host.results[inst.id]!.generic.participationRate).toBeCloseTo(2 / 3);
    expect(host.challenges[0]!.stats).toMatchObject({ scored: 2, bestPoints: 10 });
    expect(lastSnapshot(events, `player:${alice.id}`).board[0]).toMatchObject({ status: 'scored', points: 10 });
    expect(JSON.stringify(lastSnapshot(events, `player:${alice.id}`).board[0]!.result)).toContain('You guessed 130');
    expect(lastSnapshot(events, `player:${carol.id}`).board[0]).toMatchObject({ status: 'closed' });
    expect(game.startAttempt(carol.id, inst.id)).toMatchObject({ ok: false });
    expect(game.ledger.every((r) => r.source === 'module' && r.challengeInstanceId === inst.id)).toBe(true);

    game.performHostAction({ action: 'end-game' });
    expect(game.status).toBe('GAME_RESULTS');
    game.performHostAction({ action: 'close-game' });
    expect(engine.findByCode(game.code)).toBeUndefined();

    // Start over: a fresh copy of the setup, the closed game stays as it was.
    const { runtime: fresh, hostToken: freshToken, warnings } = engine.duplicateGame(game.id);
    expect(warnings).toEqual([]);
    expect(engine.authorizeHost(fresh.id, freshToken)).toBe(fresh);
    expect(fresh.status).toBe('DRAFT');
    expect(fresh.doc.players).toEqual([]);
    expect(fresh.doc.ledger).toEqual([]);
    expect(fresh.doc.instances.map((i) => [i.moduleId, i.phase, i.configuration])).toEqual([['closest-number', 'PENDING', inst.configuration]]);
    expect(game.status).toBe('FINISHED');

    // Continue the closed game: players and points are kept, results hidden again.
    const oldCode = game.code;
    fresh.doc.code = oldCode; // pretend the code was handed out again meanwhile
    expect(game.performHostAction({ action: 'reopen-game' }).message).toMatch(/join code/);
    expect(game.status).toBe('IN_PROGRESS');
    expect(game.code).not.toBe(oldCode);
    expect(engine.findByCode(game.code)).toBe(game);
    expect(game.doc.resultsRevealed).toBe(false);
    expect(lastSnapshot(events, 'host').leaderboard.map((l) => [l.displayName, l.total])).toEqual([
      ['Alice', 10],
      ['Bob', 5],
      ['Carol', 0],
    ]);
    expect(events.some((e) => e.type === 'GAME_REOPENED')).toBe(true);
    expect(() => game.performHostAction({ action: 'reopen-game' })).toThrow(/Only an ended game/);
    game.performHostAction({ action: 'end-game' });
    game.performHostAction({ action: 'reopen-game' });
    expect(game.status).toBe('IN_PROGRESS');
  });

  it('runs the peer approval pipeline: hidden assignments, deadlines, reassignment, escalation, override', () => {
    const { engine, time, events } = setup(() => 0);
    const { runtime: game } = engine.createGame({ name: 'Peer party', settings: { judgeDeadlineSeconds: 60, maxReassignments: 1 } });
    const inst = game.addChallenge('caption-this', CAPTION);
    game.performHostAction({ action: 'open-lobby' });
    const [ada, bea, cyd] = ['Ada', 'Bea', 'Cyd'].map((n) => game.join(n).player);
    game.connect({ role: 'host' });
    game.connect({ role: 'main' });
    for (const p of [ada!, bea!, cyd!]) game.connect({ role: 'player', playerId: p.id });
    game.performHostAction({ action: 'start-game' });
    game.performHostAction({ action: 'reveal-results' }); // this test follows scores on the players' boards

    // Ada submits: a judge is assigned, hidden from everyone but the judge and host (FR-63).
    game.startAttempt(ada!.id, inst.id);
    expect(game.submit(ada!.id, inst.id, { caption: 'When the DJ plays your song' })).toEqual({ ok: true });
    game.finishAttempt(ada!.id, inst.id);
    const assigned = events.filter((e) => e.type === 'EVALUATION_ASSIGNED');
    expect(assigned.map((e) => e.audience).sort()).toEqual(['host', `player:${bea!.id}`]);
    expect(JSON.stringify(lastSnapshot(events, 'main'))).not.toContain('assignmentId');
    expect(lastSnapshot(events, `player:${ada!.id}`).judging).toEqual([]);
    expect(lastSnapshot(events, `player:${ada!.id}`).board[0]).toMatchObject({ status: 'submitted', statusText: 'Waiting for a judge' });

    const task = lastSnapshot(events, `player:${bea!.id}`).judging[0]!;
    expect(task.criteria).toMatch(/Approve the caption/);
    expect(JSON.stringify(task.presentation)).toContain('When the DJ plays your song');
    expect(JSON.stringify(task.presentation)).not.toContain('Ada'); // anonymous to peers

    // SR-11: only the assigned judge can decide.
    expect(game.judge(cyd!.id, task.assignmentId, 'approve')).toMatchObject({ ok: false });
    expect(game.judge(bea!.id, 'e_bogus', 'approve')).toMatchObject({ ok: false });

    // Deadline passes → reassigned to Cyd (Bea excluded).
    time.advance(61_000);
    expect(game.getAssignment(task.assignmentId)?.status).toBe('expired');
    const task2 = lastSnapshot(events, `player:${cyd!.id}`).judging[0]!;
    expect(task2.assignmentId).not.toBe(task.assignmentId);
    expect(game.judge(bea!.id, task.assignmentId, 'approve')).toMatchObject({ ok: false, reason: /no longer open/ });

    // Second deadline passes → maxReassignments reached → escalated to the host queue.
    time.advance(61_000);
    const host = lastSnapshot(events, 'host');
    expect(host.hostQueue).toHaveLength(1);
    expect(host.hostQueue[0]).toMatchObject({ playerId: ada!.id, displayName: 'Ada', reason: 'escalated-timeout' });
    expect(events.some((e) => e.type === 'EVALUATION_ESCALATED')).toBe(true);

    // Host approves with points → scored.
    game.performHostAction({ action: 'decide', assignmentId: host.hostQueue[0]!.assignmentId, decision: 'approve', points: 7, note: 'Solid' });
    expect(lastSnapshot(events, 'host').hostQueue).toEqual([]);
    expect(lastSnapshot(events, `player:${ada!.id}`).board[0]).toMatchObject({ status: 'scored', points: 7 });
    expect(JSON.stringify(lastSnapshot(events, `player:${ada!.id}`).board[0]!.result)).toContain('7 points');

    // Bea submits; one of the other players is assigned (never Bea herself) and approves in time.
    game.startAttempt(bea!.id, inst.id);
    game.submit(bea!.id, inst.id, { caption: 'Monday.' });
    game.finishAttempt(bea!.id, inst.id);
    expect(lastSnapshot(events, `player:${bea!.id}`).judging).toEqual([]);
    const judge = [ada!, cyd!].find((p) => lastSnapshot(events, `player:${p.id}`).judging.some((t) => JSON.stringify(t.presentation).includes('Monday.')))!;
    expect(judge).toBeDefined();
    const beaTask = lastSnapshot(events, `player:${judge.id}`).judging.find((t) => JSON.stringify(t.presentation).includes('Monday.'))!;
    time.advance(10_000);
    expect(game.judge(judge.id, beaTask.assignmentId, 'approve', 'lol')).toEqual({ ok: true });
    expect(lastSnapshot(events, `player:${bea!.id}`).board[0]).toMatchObject({ status: 'scored', points: 10 });

    // Host overrides Bea's approval (FR-55): ledger reversed, new verdict applied.
    const scored = lastSnapshot(events, 'host').scored.find((s) => s.playerId === bea!.id)!;
    game.performHostAction({ action: 'override', submissionId: scored.submissionId, decision: 'reject', reason: 'Not a caption' });
    expect(lastSnapshot(events, `player:${bea!.id}`).board[0]).toMatchObject({ status: 'scored', points: 0 });
    expect(lastSnapshot(events, 'host').leaderboard.find((l) => l.playerId === bea!.id)?.total).toBe(0);
    expect(game.ledger.filter((r) => r.playerId === bea!.id).map((r) => r.points)).toEqual([10, -10, 0]);
    const record = lastSnapshot(events, 'host').evaluations.find((e) => e.submissionId === scored.submissionId && e.status === 'overridden');
    expect(record).toBeDefined();

    // Closing an immediate challenge with nothing pending goes straight to RESULTS.
    game.performHostAction({ action: 'close-challenge', instanceId: inst.id });
    expect(inst.phase).toBe('RESULTS');
    expect(lastSnapshot(events, 'main').results[inst.id]!.statistics).toMatchObject({ captions: 2, approved: 1 });
  });

  it('applies the game evaluation preference, host mode, hybrid escalation and pause', () => {
    const { engine, time, events } = setup(() => 0.99);
    const { runtime: game } = engine.createGame({ name: 'Modes', settings: { evaluationPreference: 'host' } });
    const hostInst = game.addChallenge('caption-this', CAPTION);
    const hybridInst = game.addChallenge('caption-this', CAPTION, { evaluationMode: 'hybrid' });
    expect(() => game.addChallenge('closest-number', CLOSEST, { evaluationMode: 'peer' })).toThrow(/supports evaluation modes/);
    const autoInst = game.addChallenge('closest-number', CLOSEST, { availability: 'host-unlocked' });
    expect(game.effectiveMode(hostInst)).toBe('host'); // game preference remaps peer → host
    expect(game.effectiveMode(hybridInst)).toBe('hybrid'); // instance override wins
    expect(game.effectiveMode(autoInst)).toBe('automatic'); // module supports automatic only

    game.performHostAction({ action: 'open-lobby' });
    const [ada, bea] = ['Ada', 'Bea'].map((n) => game.join(n).player);
    game.connect({ role: 'host' });
    for (const p of [ada!, bea!]) game.connect({ role: 'player', playerId: p.id });
    game.performHostAction({ action: 'start-game' });
    game.performHostAction({ action: 'reveal-results' });
    expect(autoInst.phase).toBe('PENDING'); // host-gated
    expect(lastSnapshot(events, `player:${ada!.id}`).board.find((b) => b.instanceId === autoInst.id)).toMatchObject({ status: 'locked' });

    // Host mode: straight to the host queue.
    game.startAttempt(ada!.id, hostInst.id);
    game.submit(ada!.id, hostInst.id, { caption: 'Hi' });
    game.finishAttempt(ada!.id, hostInst.id);
    expect(lastSnapshot(events, 'host').hostQueue[0]).toMatchObject({ instanceId: hostInst.id, reason: 'host-mode' });
    expect(lastSnapshot(events, `player:${bea!.id}`).judging).toEqual([]);
    expect(() => game.performHostAction({ action: 'decide', assignmentId: lastSnapshot(events, 'host').hostQueue[0]!.assignmentId, decision: 'approve', points: 99 })).toThrow(/between 0 and 10/);
    game.performHostAction({ action: 'decide', assignmentId: lastSnapshot(events, 'host').hostQueue[0]!.assignmentId, decision: 'reject' });
    expect(lastSnapshot(events, `player:${ada!.id}`).board.find((b) => b.instanceId === hostInst.id)).toMatchObject({ status: 'scored', points: 0 });

    // Hybrid: peer rejection escalates to the host instead of counting.
    game.startAttempt(ada!.id, hybridInst.id);
    game.submit(ada!.id, hybridInst.id, { caption: 'Hybrid caption' });
    game.finishAttempt(ada!.id, hybridInst.id);
    const task = lastSnapshot(events, `player:${bea!.id}`).judging[0]!;
    expect(game.judge(bea!.id, task.assignmentId, 'reject', 'meh')).toEqual({ ok: true });
    expect(lastSnapshot(events, `player:${ada!.id}`).board.find((b) => b.instanceId === hybridInst.id)).toMatchObject({ status: 'submitted' });
    const queued = lastSnapshot(events, 'host').hostQueue[0]!;
    expect(queued).toMatchObject({ reason: 'escalated-rejection' });
    expect(queued.priorJudgements).toHaveLength(1);
    game.performHostAction({ action: 'decide', assignmentId: queued.assignmentId, decision: 'approve' });
    expect(lastSnapshot(events, `player:${ada!.id}`).board.find((b) => b.instanceId === hybridInst.id)).toMatchObject({ status: 'scored', points: 10 });

    // Unlock the gated challenge, pause freezes per-player timers.
    game.performHostAction({ action: 'unlock-challenge', instanceId: autoInst.id });
    expect(autoInst.phase).toBe('ACTIVE');
    game.startAttempt(bea!.id, autoInst.id);
    game.performHostAction({ action: 'pause' });
    expect(game.submit(bea!.id, autoInst.id, { answer: 1 })).toEqual({ ok: false, reason: 'The game is paused' });
    time.advance(120_000);
    expect(game.attemptOf(autoInst.id, bea!.id)?.status).toBe('in_progress');
    game.performHostAction({ action: 'resume' });
    expect(game.submit(bea!.id, autoInst.id, { answer: 137 })).toEqual({ ok: true });
    time.advance(30_000);
    expect(game.attemptOf(autoInst.id, bea!.id)?.status).toBe('locked');

    // Reset reverses points and lets people play again.
    game.performHostAction({ action: 'reset-challenge', instanceId: hybridInst.id });
    expect(lastSnapshot(events, 'host').leaderboard.find((l) => l.playerId === ada!.id)?.total).toBe(0);
    expect(lastSnapshot(events, `player:${ada!.id}`).board.find((b) => b.instanceId === hybridInst.id)).toMatchObject({ status: 'available' });

    // Ending the game closes everything; unanswered peer tasks land with the host.
    game.startAttempt(ada!.id, hybridInst.id);
    game.submit(ada!.id, hybridInst.id, { caption: 'Again' });
    game.finishAttempt(ada!.id, hybridInst.id);
    game.performHostAction({ action: 'end-game' });
    expect(game.status).toBe('GAME_RESULTS');
    expect(autoInst.phase).toBe('RESULTS');
    expect(lastSnapshot(events, 'host').hostQueue.map((q) => q.reason)).toEqual(['escalated-timeout']);
  });

  it('supports titles, one-tap final submissions and replays where only the best attempt counts', () => {
    const { engine, events } = setup();
    const { runtime: game } = engine.createGame({ name: 'Replays' });
    expect(() => game.addChallenge('closest-number', CLOSEST, { allowReplay: true })).toThrow(/cannot be replayed/);
    const inst = game.addChallenge('caption-this', CAPTION, { title: '  Best   caption ', category: 'Creativity', evaluationMode: 'host', allowReplay: true });
    expect(inst.title).toBe('Best caption');
    game.performHostAction({ action: 'open-lobby' });
    const ada = game.join('Ada').player;
    game.connect({ role: 'host' });
    game.connect({ role: 'main' });
    game.connect({ role: 'player', playerId: ada.id });
    game.performHostAction({ action: 'start-game' });
    const tile = () => lastSnapshot(events, `player:${ada.id}`).board[0]!;
    const total = () => lastSnapshot(events, 'host').leaderboard[0]!.total;
    expect(tile()).toMatchObject({ title: 'Best caption', category: 'Creativity', moduleName: 'Caption This', status: 'available', canReplay: false, attempts: 0 });
    expect(lastSnapshot(events, 'main').challenges[0]).toMatchObject({ title: 'Best caption', category: 'Creativity', allowReplay: true });
    expect(lastSnapshot(events, 'main').activity[0]!.text).toBe('Best caption is open');

    const play = (caption: string, points: number) => {
      expect(game.startAttempt(ada.id, inst.id)).toEqual({ ok: true });
      // `final` locks the attempt at once although caption-this accepts replacement answers.
      expect(game.submit(ada.id, inst.id, { caption }, true)).toEqual({ ok: true });
      expect(game.attemptOf(inst.id, ada.id)?.status).toBe('locked');
      const item = lastSnapshot(events, 'host').hostQueue[0]!;
      expect(item.title).toBe('Best caption');
      game.performHostAction({ action: 'decide', assignmentId: item.assignmentId, decision: 'approve', points });
    };

    play('First try', 4);
    expect(total()).toBe(4);
    // Hidden until revealed: the tile only says it is done, and points never reach the player.
    expect(tile()).toMatchObject({ status: 'submitted', points: null, result: null, canReplay: true, attempts: 1 });
    expect(events.filter((e) => e.type === 'PLAYER_SCORED').every((e) => e.audience === 'host')).toBe(true);
    play('Much better', 9);
    expect(total()).toBe(9);
    play('Worse', 2);
    expect(total()).toBe(9); // only the best attempt counts
    expect(lastSnapshot(events, 'host').challenges[0]!.stats).toMatchObject({ started: 1, attempts: 3, submitted: 1, scored: 1, bestPoints: 9 });
    expect(lastSnapshot(events, 'host').scored.map((s) => s.points).sort()).toEqual([2, 4, 9]);

    // Overruling the best attempt lets the next best one count again.
    const best = lastSnapshot(events, 'host').scored.find((s) => s.points === 9)!;
    game.performHostAction({ action: 'override', submissionId: best.submissionId, decision: 'reject', reason: 'Copied' });
    expect(total()).toBe(4);
    // Progress graph: one challenge finished, worth its current (best) points; hidden for the main display.
    expect(lastSnapshot(events, 'host').leaderboard[0]!.series).toEqual([0, 4]);
    expect(lastSnapshot(events, 'main').leaderboard[0]!.series).toEqual([]);
    game.performHostAction({ action: 'adjust-score', playerId: ada.id, points: 2, reason: 'Bonus' });
    expect(lastSnapshot(events, 'host').leaderboard[0]!.series).toEqual([0, 6]); // after her 1st challenge
    expect(total()).toBe(6);

    game.performHostAction({ action: 'reveal-results' });
    expect(tile()).toMatchObject({ status: 'scored', points: 4, canReplay: true, attempts: 3 });
    expect(lastSnapshot(events, 'main').leaderboard[0]).toMatchObject({ total: 6, rank: 1, series: [0, 6] });
    game.performHostAction({ action: 'hide-results' });
    expect(tile().points).toBeNull();

    // No more replays once the host closes the challenge.
    game.performHostAction({ action: 'close-challenge', instanceId: inst.id });
    expect(tile().canReplay).toBe(false);
    expect(game.startAttempt(ada.id, inst.id)).toMatchObject({ ok: false });
  });

  it('runs turn-based repeat challenges: module start gate, waiting tiles, timed-out turns, points add up', () => {
    const { engine, events, time } = setup();
    const { runtime: game } = engine.createGame({ name: 'Message' });
    const inst = game.addChallenge('group-message', { prompt: 'For Sam', turnSeconds: 60, maxTurnsPerPlayer: 2 });
    game.performHostAction({ action: 'open-lobby' });
    const [ada, bea] = ['Ada', 'Bea'].map((n) => game.join(n).player);
    game.connect({ role: 'host' });
    for (const p of [ada!, bea!]) game.connect({ role: 'player', playerId: p.id });
    game.performHostAction({ action: 'start-game' });
    const tile = (p: { id: string }) => lastSnapshot(events, `player:${p.id}`).board[0]!;

    expect(tile(ada!)).toMatchObject({ status: 'available', statusText: 'Your turn! Add up to 3 words', repeat: true });
    expect(tile(bea!)).toMatchObject({ status: 'waiting', statusText: 'Ada is writing — wait for your turn', canReplay: false });
    expect(game.startAttempt(bea!.id, inst.id)).toEqual({ ok: false, reason: 'Ada is writing — wait for your turn' });

    const turn = (p: { id: string }, words: string) => {
      expect(game.startAttempt(p.id, inst.id)).toEqual({ ok: true });
      expect(game.submit(p.id, inst.id, { words })).toEqual({ ok: true });
    };
    turn(ada!, 'Happy birthday');
    expect(tile(ada!)).toMatchObject({ status: 'waiting', points: null }); // nothing revealed
    expect(tile(bea!)).toMatchObject({ status: 'available' });
    // Bea lets her turn run out: it moves back to Ada.
    expect(game.startAttempt(bea!.id, inst.id)).toEqual({ ok: true });
    time.advance(61_000);
    expect(game.attemptOf(inst.id, bea!.id)?.status).toBe('locked');
    expect(tile(ada!).status).toBe('available');
    turn(ada!, 'dear Sam');
    turn(bea!, 'and cheers');
    expect(tile(ada!)).toMatchObject({ status: 'waiting', statusText: 'You added your 2 contributions — thank you!' });

    const host = lastSnapshot(events, 'host');
    expect(host.leaderboard.map((l) => [l.displayName, l.total])).toEqual([
      ['Ada', 2],
      ['Bea', 1],
    ]); // every contribution counts, no best-of
    expect(host.challenges[0]!.stats).toMatchObject({ started: 2, attempts: 4, submitted: 2, scored: 2 });
    game.performHostAction({ action: 'close-challenge', instanceId: inst.id });
    expect(JSON.stringify(lastSnapshot(events, 'host').results[inst.id]!.ui)).toContain('Happy birthday dear Sam and cheers');
  });

  it('publishes frozen standings to the big screen with a feed of overtakes, results hidden or not', () => {
    const { engine, events } = setup();
    const { runtime: game } = engine.createGame({ name: 'Race' });
    const a = game.addChallenge('caption-this', CAPTION, { evaluationMode: 'host' });
    const b = game.addChallenge('caption-this', CAPTION, { evaluationMode: 'host' });
    game.performHostAction({ action: 'open-lobby' });
    const [ada, bea] = ['Ada', 'Bea'].map((n) => game.join(n).player);
    game.connect({ role: 'host' });
    game.connect({ role: 'main' });
    game.connect({ role: 'player', playerId: ada!.id });
    game.performHostAction({ action: 'start-game' });
    const score = (p: { id: string }, inst: { id: string }, points: number) => {
      game.startAttempt(p.id, inst.id);
      game.submit(p.id, inst.id, { caption: 'Hi' }, true);
      const item = lastSnapshot(events, 'host').hostQueue.find((q) => q.playerId === p.id && q.instanceId === inst.id)!;
      game.performHostAction({ action: 'decide', assignmentId: item.assignmentId, decision: 'approve', points });
    };
    expect(lastSnapshot(events, 'main').standings).toBeNull();

    score(ada!, a, 8);
    score(bea!, a, 5);
    expect(game.performHostAction({ action: 'publish-standings' }).message).toMatch(/1 change/);
    const main = lastSnapshot(events, 'main');
    expect(main.game.resultsRevealed).toBe(false); // phones still hide everything…
    expect(main.leaderboard.every((l) => l.total === 0)).toBe(true);
    expect(main.standings!.entries.map((e) => [e.displayName, e.rank, e.total, e.series])).toEqual([
      ['Ada', 1, 8, [0, 8]],
      ['Bea', 2, 5, [0, 5]],
    ]); // …but the big screen shows what the host published
    expect(main.standingsFeed.map((f) => f.text)).toEqual(['Ada leads the race']);
    expect(lastSnapshot(events, `player:${ada!.id}`).standings).toBeNull();

    // New points do not reach the big screen until the next update.
    score(bea!, b, 9);
    expect(lastSnapshot(events, 'main').standings!.entries[0]!.displayName).toBe('Ada');
    game.performHostAction({ action: 'publish-standings' });
    const after = lastSnapshot(events, 'main');
    expect(after.standings!.entries.map((e) => [e.displayName, e.total])).toEqual([
      ['Bea', 14],
      ['Ada', 8],
    ]);
    expect(after.standingsFeed.map((f) => f.text)).toEqual(['Bea takes the lead from Ada', 'Ada leads the race']); // newest first
    expect(game.performHostAction({ action: 'publish-standings' }).message).toMatch(/no changes/);
  });

  it('takes live actions without submissions, throttles their snapshots and shows the panel on the main display only', () => {
    const { engine, events, time } = setup();
    const { runtime: game } = engine.createGame({ name: 'Blobs' });
    const inst = game.addChallenge('blob-war', { tapsToMax: 100 });
    const other = game.addChallenge('caption-this', CAPTION);
    game.performHostAction({ action: 'open-lobby' });
    const [ada, bea] = ['Ada', 'Bea'].map((n) => game.join(n).player);
    game.connect({ role: 'main' });
    game.connect({ role: 'player', playerId: ada!.id });
    game.performHostAction({ action: 'start-game' });
    const panel = () => lastSnapshot(events, 'main').challenges.find((c) => c.id === inst.id)!.displayPanel as { mode: string; blobs: { id: string; share: number }[] };
    expect(panel().mode).toBe('live');
    expect(panel().blobs.map((b) => b.id)).toEqual([ada!.id, bea!.id]); // everyone has a blob from the start
    expect(lastSnapshot(events, 'main').challenges.find((c) => c.id === other.id)!.displayPanel).toBeNull();
    expect(lastSnapshot(events, `player:${ada!.id}`).challenges[0]!.displayPanel).toBeUndefined();

    expect(game.moduleAction(ada!.id, inst.id, { pump: 5 })).toEqual({ ok: false, reason: 'Start the challenge first' });
    expect(game.moduleAction(ada!.id, other.id, { pump: 5 })).toEqual({ ok: false, reason: 'This challenge takes no live actions' });
    game.startAttempt(ada!.id, inst.id);
    expect(game.moduleAction(ada!.id, inst.id, { pump: 999 })).toEqual({ ok: false, reason: 'Invalid pump' });

    const snapshotsBefore = events.filter((e) => e.type === 'GAME_STATE_SNAPSHOT').length;
    const sizeBefore = panel().blobs[0]!.share;
    for (let i = 0; i < 5; i++) expect(game.moduleAction(ada!.id, inst.id, { pump: 10 })).toEqual({ ok: true });
    expect(events.filter((e) => e.type === 'GAME_STATE_SNAPSHOT').length).toBe(snapshotsBefore); // not yet: throttled
    time.advance(250);
    expect(events.filter((e) => e.type === 'GAME_STATE_SNAPSHOT').length).toBe(snapshotsBefore + 2); // one per audience
    expect(panel().blobs[0]!.share).toBeGreaterThan(sizeBefore);
    expect(game.doc.submissions).toEqual([]); // taps are not submissions

    // Rate limit, then the host closes it: the map freezes and territory is scored.
    let limited = false;
    for (let i = 0; i < 70 && !limited; i++) limited = !game.moduleAction(ada!.id, inst.id, { pump: 1 }).ok;
    expect(limited).toBe(true);
    // A newcomer while it is open: the module hears about it and makes room (onPlayerJoin).
    const gus = game.join('Gus').player;
    time.advance(250);
    expect(panel().blobs.map((b) => b.id)).toEqual([ada!.id, bea!.id, gus.id]);
    expect(panel().blobs[2]!.share).toBeGreaterThan(0);
    game.performHostAction({ action: 'close-challenge', instanceId: inst.id });
    expect(panel().mode).toBe('final');
    expect(inst.phase).toBe('RESULTS');
    expect(game.ledger.filter((r) => r.challengeInstanceId === inst.id).map((r) => [r.playerId, r.points])).toEqual([[ada!.id, 10]]);
    expect(game.doc.activity.some((a) => a.text.includes('ran out of time'))).toBe(false);
    expect(game.moduleAction(ada!.id, inst.id, { pump: 1 })).toMatchObject({ ok: false });
  });

  it('lets the host change everything while nobody has played a challenge, also after a reset', () => {
    const { engine, events } = setup();
    const { runtime: game } = engine.createGame({ name: 'Edit' });
    const inst = game.addChallenge('closest-number', CLOSEST);
    const turns = game.addChallenge('group-message', { prompt: 'Hi', wordsPerTurn: 3, turnSeconds: 300, maxTurnsPerPlayer: 2 });
    game.performHostAction({ action: 'open-lobby' });
    const ada = game.join('Ada').player;
    game.connect({ role: 'player', playerId: ada.id });
    game.performHostAction({ action: 'start-game' });
    expect(inst.phase).toBe('ACTIVE');
    const announced = () => game.doc.activity.filter((a) => a.text === 'Closest Number is open').length;
    expect(announced()).toBe(1);

    // Open but unplayed: the new answer applies and the module starts over, still open.
    game.updateChallenge(inst.id, { ...CLOSEST, correctAnswer: 200 });
    expect(inst.configuration.correctAnswer).toBe(200);
    expect(JSON.stringify(inst.moduleState)).toContain('200');
    expect(inst.phase).toBe('ACTIVE');
    expect(announced()).toBe(1);
    // A module with instance timers gets them again from its fresh start, once.
    game.updateChallenge(turns.id, { prompt: 'Hello', wordsPerTurn: 2, turnSeconds: 120, maxTurnsPerPlayer: 2 });
    expect(turns.timers.filter((t) => t.tag === 'turn')).toHaveLength(1);
    expect(lastSnapshot(events, `player:${ada.id}`).board.find((b) => b.instanceId === turns.id)!.statusText).toMatch(/Add up to 2 words/);

    // Once someone has played it, only a reset unlocks the configuration again.
    expect(game.startAttempt(ada.id, inst.id)).toEqual({ ok: true });
    expect(() => game.updateChallenge(inst.id, { ...CLOSEST, correctAnswer: 300 })).toThrow(/reset it first/);
    game.updateChallenge(inst.id, undefined, { title: 'Still renamable' });
    expect(inst.title).toBe('Still renamable');
    game.performHostAction({ action: 'reset-challenge', instanceId: inst.id });
    expect(inst.phase).toBe('ACTIVE');
    game.updateChallenge(inst.id, { ...CLOSEST, correctAnswer: 300 });
    expect(inst.configuration.correctAnswer).toBe(300);
    expect(game.startAttempt(ada.id, inst.id)).toEqual({ ok: true });
    // Closed challenges have to be reset first too.
    game.performHostAction({ action: 'close-challenge', instanceId: inst.id });
    expect(() => game.updateChallenge(inst.id, CLOSEST)).toThrow(/reset it first/);
  });

  it('exports a setup and imports it as a new game, reporting what could not be restored', () => {
    const { engine } = setup();
    const { runtime: game } = engine.createGame({ name: 'Original', settings: { tieBreak: 'wins', judgeDeadlineSeconds: 90 } });
    game.updateGame({ branding: { hostName: 'Sam', accentColor: '#ff0066' } });
    game.addChallenge('caption-this', CAPTION, { title: 'Caption the cat', category: '  Creativity ', allowReplay: true, evaluationMode: 'host' });
    game.addChallenge('closest-number', CLOSEST, { title: 'Jar of balls', availability: 'host-unlocked' });
    const setupFile = JSON.parse(JSON.stringify(game.exportSetup()));
    expect(setupFile).toMatchObject({ format: 'challenge-platform/setup', version: 1, game: { name: 'Original' } });
    expect(setupFile.challenges).toHaveLength(2);

    setupFile.challenges.push({ moduleId: 'not-installed', configuration: {} });
    const { runtime: copy, hostToken, warnings } = engine.importSetup(setupFile);
    expect(engine.authorizeHost(copy.id, hostToken)).toBe(copy);
    expect(copy.id).not.toBe(game.id);
    expect(copy.status).toBe('DRAFT');
    expect(copy.doc.settings).toMatchObject({ tieBreak: 'wins', judgeDeadlineSeconds: 90 });
    expect(copy.doc.branding).toEqual({ hostName: 'Sam', accentColor: '#ff0066' });
    expect(copy.doc.instances.map((i) => [i.moduleId, i.title, i.category, i.allowReplay, i.availability, i.evaluationMode])).toEqual([
      ['caption-this', 'Caption the cat', 'Creativity', true, 'open', 'host'],
      ['closest-number', 'Jar of balls', '', false, 'host-unlocked', null],
    ]);
    expect(() => game.updateChallenge(game.doc.instances[1]!.id, undefined, { category: 'x'.repeat(41) })).toThrow(/at most 40/);
    expect(copy.doc.instances[1]!.configuration).toEqual(game.doc.instances[1]!.configuration);
    expect(warnings).toEqual([expect.stringMatching(/Challenge 3 \(not-installed\) was skipped: Module not-installed is not installed/)]);

    expect(() => engine.importSetup({ format: 'something-else' })).toThrow(/Not a valid setup file/);
    expect(() => engine.importSetup({ ...setupFile, version: 99 })).toThrow(/newer than this server/);
  });

  it('supports assigned challenges, removal, reclaim and restart recovery', async () => {
    const registry = new ModuleRegistry();
    registry.register(closestNumber as never, null);
    registry.register(captionThis as never, null);
    const repo = new MemoryRepository();
    const time = createFakeTime();
    const kicked: string[] = [];
    const mk = () =>
      new Engine({
        registry,
        repo,
        sink: { emit: () => {}, kickPlayer: (_g, p) => kicked.push(p) },
        joinUrl: (c) => c,
        mediaUrl: (r) => r,
        clock: time.clock,
        setTimer: time.setTimer,
        clearTimer: time.clearTimer,
      });
    const engine1 = mk();
    const { runtime: game, hostToken } = engine1.createGame({ name: 'Recovery' });
    const inst = game.addChallenge('closest-number', CLOSEST);
    game.performHostAction({ action: 'open-lobby' });
    const ada = game.join('Ada').player;
    const bea = game.join('Bea').player;
    game.performHostAction({ action: 'start-game' });

    // Assigned challenge visible only to assignees.
    const secret = game.addChallenge('caption-this', CAPTION, { availability: 'assigned', assignedPlayerIds: [ada.id] });
    expect(secret.phase).toBe('ACTIVE');
    expect(game.snapshotFor({ role: 'player', playerId: bea.id }).board.map((b) => b.instanceId)).toEqual([inst.id]);
    expect(game.snapshotFor({ role: 'player', playerId: ada.id }).board.map((b) => b.instanceId)).toEqual([inst.id, secret.id]);
    expect(game.startAttempt(bea.id, secret.id)).toMatchObject({ ok: false, reason: /not available to you/ });
    expect(game.startAttempt(ada.id, secret.id)).toEqual({ ok: true });

    // Removal kicks and drops the player; freed slots can be reclaimed by name (FR-34).
    game.performHostAction({ action: 'remove-player', playerId: bea.id });
    expect(kicked).toContain(bea.id);
    expect(game.snapshotFor({ role: 'main' }).players.map((p) => p.displayName)).toEqual(['Ada']);
    game.performHostAction({ action: 'free-player', playerId: ada.id });
    const again = game.join('ada');
    expect(again.reclaimed).toBe(true);
    expect(again.player.id).toBe(ada.id);

    // Restart: in-flight attempts are discarded, everything else survives.
    game.startAttempt(ada.id, inst.id);
    game.submit(ada.id, inst.id, { answer: 5 });
    game.finishAttempt(ada.id, inst.id);
    await game.flush();
    await engine1.shutdown();

    const engine2 = mk();
    await engine2.init();
    const game2 = engine2.getGame(game.id);
    expect(game2.verifyHostToken(hostToken)).toBe(true);
    expect(game2.attemptOf(inst.id, ada.id)?.status).toBe('locked'); // finished attempt kept
    expect(game2.attemptOf(secret.id, ada.id)).toBeUndefined(); // in-flight attempt dropped
    expect(game2.startAttempt(ada.id, secret.id)).toEqual({ ok: true });
    game2.performHostAction({ action: 'close-challenge', instanceId: inst.id });
    expect(game2.snapshotFor({ role: 'host' }).leaderboard[0]).toMatchObject({ displayName: 'Ada', total: 10 });
  });
});
