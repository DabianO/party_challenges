import { describe, expect, it } from 'vitest';
import type { InstanceContext, Judgement, PlayerRef, Submission } from '@challenge/contract';
import mod from '../server/index.ts';

const players: PlayerRef[] = [
  { id: 'p1', displayName: 'Alice', connected: true },
  { id: 'p2', displayName: 'Bob', connected: true },
  { id: 'p3', displayName: 'Cara', connected: false },
];

const T0 = 1_700_000_000_000;

function fakeCtx(rngSeq: number[] = [0.5]) {
  const clock = { now: T0 };
  let i = 0;
  const scheduled: { tag: string; seconds: number; playerId?: string }[] = [];
  const cancelled: { tag: string; playerId?: string }[] = [];
  const emitted: { audience: string; payload: unknown }[] = [];
  const ctx: InstanceContext = {
    gameId: 'g1',
    instanceId: 'i1',
    rng: () => rngSeq[i++ % rngSeq.length]!,
    now: () => clock.now,
    players: () => players,
    schedule: (tag, seconds, playerId) => scheduled.push({ tag, seconds, playerId }),
    cancel: (tag, playerId) => cancelled.push({ tag, playerId }),
    emit: (audience, payload) => emitted.push({ audience, payload }),
    mediaUrl: (ref) => ref,
  };
  return { ctx, clock, scheduled, cancelled, emitted };
}

const config = {
  prompt: 'Give your best 30-second sales pitch for a paperclip',
  instructions: 'No props allowed.',
  textLabel: 'Pitch title',
  maxLength: 140,
  timeLimit: 90,
  points: 10,
};

const judgement = (decision: 'approve' | 'reject', by: 'peer' | 'host' = 'peer', extra: Partial<Judgement> = {}): Judgement => ({
  assignmentId: 'a1',
  by,
  judgePlayerId: by === 'peer' ? 'p2' : null,
  decision,
  decidedAt: T0 + 5000,
  ...extra,
});

const submission = (playerId: string, text: unknown, judgements: Judgement[] = []): Submission<{ text: string }> => ({
  id: `s-${playerId}`,
  playerId,
  payload: { text } as { text: string },
  startedAt: T0,
  submittedAt: T0 + 3000,
  judgements,
});

describe('open-performance', () => {
  it('has a consistent v2 manifest with judging metadata', () => {
    expect(mod.manifest.id).toBe('open-performance');
    expect(mod.manifest.version).toBe('2.1.0');
    expect(mod.manifest.apiVersion).toBe('2');
    expect(mod.manifest.results).toBe('immediate');
    expect(mod.manifest.evaluation.mode).toBe('host');
    expect(mod.manifest.evaluation.supportedModes).toEqual(['host', 'hybrid', 'peer']);
    expect(mod.manifest.evaluation.criteria).toBeTruthy();
    expect(mod.manifest.evaluation.evidence).toEqual({ kind: 'text', field: 'text', label: 'Entry' });
    expect(mod.manifest.evaluation.hostScoring).toEqual({ min: 0, max: 10, step: 1 });
    expect(mod.manifest.capabilities).toEqual(expect.arrayContaining(['text-input', 'timer']));
    // The schema keeps the approval points inside the host scoring range.
    expect((mod.configurationSchema as { properties: { points: { maximum: number } } }).properties.points.maximum).toBe(10);
  });

  it('schedules a per-player lock timer on start', () => {
    const { ctx, scheduled } = fakeCtx();
    const state = mod.createInstance(config, ctx);
    mod.onAttemptStart!(state, players[0]!, ctx);
    expect(scheduled).toEqual([{ tag: 'lock', seconds: 90, playerId: 'p1' }]);
  });

  it('validates the entry text', () => {
    const { ctx } = fakeCtx();
    let state = mod.createInstance(config, ctx);
    const alice = players[0]!;
    expect(mod.validateInput(state, alice, { text: 'The Clip That Grips' }, ctx)).toEqual({ ok: true });
    expect(mod.validateInput(state, alice, { text: '   ' }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, alice, { text: 'x'.repeat(141) }, ctx)).toMatchObject({ ok: false, reason: 'Keep it under 140 characters' });
    expect(mod.validateInput(state, alice, { text: 42 } as never, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, alice, {} as never, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, alice, null as never, ctx)).toMatchObject({ ok: false });
    state = mod.handleInput(state, alice, { text: '  The Clip That Grips  ' }, ctx);
    expect(state.entries).toEqual({ p1: 'The Clip That Grips' });
    const next = mod.handleInput(state, alice, { text: 'Clip v2' }, ctx);
    expect(next.entries.p1).toBe('Clip v2');
    expect(state.entries.p1).toBe('The Clip That Grips');
  });

  it('maps the last judgement to points: approval, rejection and host scoring', () => {
    const { ctx } = fakeCtx();
    const state = mod.createInstance(config, ctx);

    const approved = mod.evaluate(state, [submission('p1', 'The Clip That Grips', [judgement('approve', 'peer', { note: 'Loved it' })])], ctx);
    expect(approved).toEqual({
      playerId: 'p1',
      displayName: 'Alice',
      text: 'The Clip That Grips',
      approved: true,
      hostPoints: null,
      note: 'Loved it',
      decidedBy: 'peer',
    });
    expect(mod.calculateScores(state, approved, ctx)).toEqual([{ playerId: 'p1', points: 10, reason: 'Performance approved' }]);

    // Hybrid: peer approved first, host overruled → the LAST judgement wins.
    const rejected = mod.evaluate(state, [submission('p2', 'Meh', [judgement('approve', 'peer'), judgement('reject', 'host', { note: 'Did not perform' })])], ctx);
    expect(rejected.approved).toBe(false);
    expect(rejected.decidedBy).toBe('host');
    expect(mod.calculateScores(state, rejected, ctx)).toEqual([{ playerId: 'p2', points: 0, reason: 'Performance rejected' }]);

    const scored = mod.evaluate(state, [submission('p3', 'Paperclip Rhapsody', [judgement('approve', 'host', { points: 7 })])], ctx);
    expect(scored.hostPoints).toBe(7);
    expect(mod.calculateScores(state, scored, ctx)).toEqual([{ playerId: 'p3', points: 7, reason: 'Scored by the host' }]);

    // Peer-entered points are ignored (only the host may score).
    const peerPoints = mod.evaluate(state, [submission('p1', 'X', [judgement('approve', 'peer', { points: 3 })])], ctx);
    expect(peerPoints.hostPoints).toBeNull();

    // No judgement at all (e.g. automatic fallback) → not approved.
    const unjudged = mod.evaluate(state, [submission('p1', 'X')], ctx);
    expect(unjudged.approved).toBe(false);
    expect(unjudged.decidedBy).toBeNull();

    // Players no longer on the roster earn nothing.
    expect(mod.calculateScores(state, { ...approved, playerId: 'ghost' }, ctx)).toEqual([]);

    expect(mod.getStatistics(state, [approved, rejected, scored], ctx)).toEqual({
      prompt: config.prompt,
      entries: 3,
      approved: 2,
      approvalRate: 0.67,
      averagePoints: 5.67,
      highest: { name: 'Alice', points: 10 },
      judgedByHost: 2,
    });
    expect(mod.getStatistics(state, [], ctx)).toMatchObject({ entries: 0, approved: 0, approvalRate: null, averagePoints: null, highest: null });
    expect(JSON.parse(JSON.stringify(approved))).toEqual(approved);
  });

  it('presents the prompt and the entry to judges', () => {
    const { ctx } = fakeCtx();
    const state = mod.createInstance(config, ctx);
    const json = JSON.stringify(mod.presentSubmission!(state, submission('p1', 'The Clip That Grips'), ctx));
    expect(json).toContain(config.prompt);
    expect(json).toContain('“The Clip That Grips”');
    expect(json).toContain('"card"');
  });

  it('guestView shows only the current player’s entry; mainView shows no entries', () => {
    const { ctx } = fakeCtx();
    let state = mod.createInstance(config, ctx);
    const fresh = mod.guestView(state, players[0]!, ctx);
    expect(fresh.canSubmit).toBe(true);
    expect(JSON.stringify(fresh.ui)).toContain('"tag":"lock"');
    expect(JSON.stringify(fresh.ui)).toContain('"label":"Pitch title"');
    state = mod.handleInput(state, players[0]!, { text: 'Alice pitch' }, ctx);
    state = mod.handleInput(state, players[1]!, { text: 'Bob pitch' }, ctx);
    const alice = JSON.stringify(mod.guestView(state, players[0]!, ctx).ui);
    expect(alice).toContain('Alice pitch');
    expect(alice).not.toContain('Bob pitch');
    const main = JSON.stringify(mod.mainView!(state, ctx));
    expect(main).toContain('2 entries so far');
    expect(main).not.toContain('Alice pitch');
    expect(main).not.toContain('Bob pitch');
    expect(JSON.stringify(mod.introView!(state, players[0]!, ctx))).toContain('No props allowed.');
  });

  it('resultsView lists approved entries and personalises verdicts', () => {
    const { ctx } = fakeCtx();
    const state = mod.createInstance(config, ctx);
    const a = mod.evaluate(state, [submission('p1', 'Alice pitch', [judgement('approve', 'host', { points: 8, note: 'Great energy' })])], ctx);
    const b = mod.evaluate(state, [submission('p2', 'Bob pitch', [judgement('reject', 'peer', { note: 'Too short' })])], ctx);
    const results = mod.resultsView(state, [a, b], ctx);
    const shared = JSON.stringify(results.ui);
    expect(shared).toContain('2 entries');
    expect(shared).toContain('1 approved');
    expect(shared).toContain('“Alice pitch”');
    expect(shared).toContain('Alice · +8');
    expect(shared).not.toContain('Bob pitch');
    expect(JSON.stringify(results.guestUi!(players[0]!))).toContain('The host gave you 8 points');
    expect(JSON.stringify(results.guestUi!(players[0]!))).toContain("Judge's note: Great energy");
    const bob = JSON.stringify(results.guestUi!(players[1]!));
    expect(bob).toContain('rejected');
    expect(bob).toContain('Too short');
    expect(results.guestUi!(players[2]!)).toEqual(results.ui);
    expect(JSON.stringify(mod.resultsView(state, [], ctx).ui)).toContain('No approved performances yet.');
  });
});
