import { describe, expect, it } from 'vitest';
import type { InstanceContext, PlayerRef, Submission } from '@challenge/contract';
import mod from '../server/index.ts';

function fakeContext(players: PlayerRef[]) {
  let now = 1_000_000;
  const scheduled: { tag: string; seconds: number; playerId?: string }[] = [];
  const emitted: unknown[] = [];
  let seed = 0.1;
  const ctx: InstanceContext = {
    gameId: 'g1',
    instanceId: 'c1',
    rng: () => (seed = (seed * 9301 + 0.49297) % 1),
    now: () => now,
    players: () => players,
    schedule: (tag, seconds, playerId) => scheduled.push({ tag, seconds, playerId }),
    cancel: () => {},
    emit: (_a, payload) => emitted.push(payload),
    mediaUrl: (ref) => ref.replace('media://', '/media/'),
  };
  return { ctx, scheduled, emitted, tick: (ms: number) => (now += ms) };
}

const players: PlayerRef[] = [
  { id: 'p1', displayName: 'Ada', connected: true },
  { id: 'p2', displayName: 'Grace', connected: true },
];
const config = { image: 'media://pic', prompt: 'Caption it', timeLimit: 90, maxLength: 120, points: 10 };

function submission(playerId: string, caption: string, judgements: Submission['judgements'] = []): Submission<{ caption: string }> {
  return { id: `s-${playerId}`, playerId, payload: { caption }, startedAt: 1, submittedAt: 2, judgements };
}

describe('caption-this module', () => {
  it('schedules a per-player time limit and validates captions', () => {
    const { ctx, scheduled } = fakeContext(players);
    let state = mod.createInstance(config, ctx);
    state = mod.onAttemptStart!(state, players[0]!, ctx);
    expect(scheduled).toEqual([{ tag: 'lock', seconds: 90, playerId: 'p1' }]);
    expect(mod.validateInput(state, players[0]!, { caption: '   ' }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, players[0]!, { caption: 'x'.repeat(121) }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, players[0]!, { caption: 'Nice' }, ctx)).toEqual({ ok: true });
    state = mod.handleInput(state, players[0]!, { caption: 'Nice' }, ctx);
    expect(JSON.stringify(mod.guestView(state, players[0]!, ctx).ui)).toContain('Nice');
    expect(JSON.stringify(mod.guestView(state, players[1]!, ctx).ui)).not.toContain('Nice');
  });

  it('maps peer and host judgements to points', () => {
    const { ctx } = fakeContext(players);
    const state = mod.createInstance(config, ctx);
    const approved = mod.evaluate(state, [submission('p1', 'Yes', [{ assignmentId: 'e1', by: 'peer', judgePlayerId: 'p2', decision: 'approve', decidedAt: 3 }])], ctx);
    expect(mod.calculateScores(state, approved, ctx)).toEqual([{ playerId: 'p1', points: 10, reason: 'Caption approved' }]);
    const rejected = mod.evaluate(state, [submission('p2', 'No', [{ assignmentId: 'e2', by: 'peer', judgePlayerId: 'p1', decision: 'reject', note: 'meh', decidedAt: 3 }])], ctx);
    expect(mod.calculateScores(state, rejected, ctx)).toEqual([{ playerId: 'p2', points: 0, reason: 'Caption rejected' }]);
    const hostScored = mod.evaluate(
      state,
      [submission('p1', 'Host', [{ assignmentId: 'e3', by: 'host', judgePlayerId: null, decision: 'approve', points: 7, decidedAt: 4 }])],
      ctx,
    );
    expect(mod.calculateScores(state, hostScored, ctx)).toEqual([{ playerId: 'p1', points: 7, reason: 'Scored by the host' }]);

    expect(mod.getStatistics(state, [approved, rejected], ctx)).toMatchObject({ captions: 2, approved: 1, approvalRate: 0.5 });
    const results = mod.resultsView(state, [approved, rejected], ctx);
    expect(JSON.stringify(results.ui)).toContain('Yes');
    expect(JSON.stringify(results.guestUi!(players[1]!))).toContain('rejected');
    expect(JSON.stringify(results.guestUi!(players[1]!))).toContain('meh');
    expect(JSON.stringify(mod.presentSubmission!(state, submission('p1', 'Shown to judge'), ctx))).toContain('Shown to judge');
    expect(JSON.stringify(mod.presentSubmission!(state, submission('p1', 'Shown to judge'), ctx))).not.toContain('Ada');
  });
});
