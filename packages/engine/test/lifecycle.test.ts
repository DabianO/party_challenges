import { describe, expect, it } from 'vitest';
import type { GameEvent, GameSnapshot } from '@challenge/contract';
import { Engine, MemoryRepository, ModuleRegistry } from '../src/index.ts';
import closestNumber from '../../../challenges/closest-number/server/index.ts';
import captionThis from '../../../challenges/caption-this/server/index.ts';

import { createFakeTime } from './helpers.ts';

function setup(random: () => number = () => 0) {
  const registry = new ModuleRegistry();
  registry.register(closestNumber as never, null);
  registry.register(captionThis as never, null);
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
    expect(game.startAttempt(alice.id, inst.id)).toMatchObject({ ok: false, reason: /already played/ });
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
    expect(JSON.stringify(main)).not.toContain('137');
    game.performHostAction({ action: 'close-challenge', instanceId: inst.id });
    expect(inst.phase).toBe('RESULTS');

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
