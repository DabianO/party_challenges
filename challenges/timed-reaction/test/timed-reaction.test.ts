import { describe, expect, it } from 'vitest';
import type { InstanceContext, PlayerRef, Submission } from '@challenge/contract';
import mod from '../server/index.ts';

const players: PlayerRef[] = [
  { id: 'p1', displayName: 'Alice', connected: true },
  { id: 'p2', displayName: 'Bob', connected: true },
  { id: 'p3', displayName: 'Cara', connected: true },
  { id: 'p4', displayName: 'Dan', connected: false },
];

function fakeCtx(rngSeq: number[] = [0.5]) {
  const clock = { now: 1_700_000_000_000 };
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

const config = { minDelaySeconds: 2, maxDelaySeconds: 6, windowSeconds: 4, maxPoints: 10, falseStartPenalty: 0 };

const sub = (playerId: string, startedAt: number, submittedAt: number): Submission<{ tap: true }> => ({
  id: `s-${playerId}`,
  playerId,
  payload: { tap: true },
  startedAt,
  submittedAt,
  judgements: [],
});

describe('timed-reaction', () => {
  it('has a consistent v2 manifest', () => {
    expect(mod.manifest.id).toBe('timed-reaction');
    expect(mod.manifest.version).toBe('2.0.0');
    expect(mod.manifest.apiVersion).toBe('2');
    expect(mod.manifest.evaluation).toEqual({ mode: 'automatic' });
    expect(mod.manifest.results).toBe('immediate');
    expect(mod.manifest.resubmission).toBe('none');
    expect(mod.manifest.capabilities).toEqual(expect.arrayContaining(['timer', 'real-time-burst', 'statistics']));
  });

  it('schedules a random per-player go timer on start and the lock only when GO fires', () => {
    const { ctx, scheduled, emitted, clock } = fakeCtx([0.25]);
    const alice = players[0]!;
    let state = mod.createInstance(config, ctx);
    expect(scheduled).toHaveLength(0);
    state = mod.onAttemptStart!(state, alice, ctx);
    // 2 + 0.25 * (6 - 2) = 3 seconds, scoped to Alice.
    expect(scheduled).toEqual([{ tag: 'go', seconds: 3, playerId: 'p1' }]);
    expect(state.goAt).toEqual({}); // nothing in state hints at the delay
    expect(JSON.stringify(state)).not.toContain('3');

    clock.now += 3_000;
    state = mod.onTimer!(state, 'go', ctx, 'p1');
    expect(state.goAt.p1).toBe(clock.now);
    expect(scheduled).toEqual([
      { tag: 'go', seconds: 3, playerId: 'p1' },
      { tag: 'lock', seconds: 4, playerId: 'p1' },
    ]);
    expect(emitted).toEqual([{ audience: 'player:p1', payload: { go: true } }]);

    // A second go for the same player is ignored; other players are untouched.
    const again = mod.onTimer!(state, 'go', ctx, 'p1');
    expect(again).toBe(state);
    expect(state.goAt.p2).toBeUndefined();
  });

  it('swaps min/max delay when misconfigured', () => {
    const { ctx, scheduled } = fakeCtx([1]);
    mod.onAttemptStart!(mod.createInstance({ ...config, minDelaySeconds: 6, maxDelaySeconds: 2 }, ctx), players[0]!, ctx);
    expect(scheduled[0]!.seconds).toBe(6);
  });

  it('validates taps and accepts a false start as the single submission', () => {
    const { ctx } = fakeCtx();
    const alice = players[0]!;
    let state = mod.onAttemptStart!(mod.createInstance(config, ctx), alice, ctx);
    expect(mod.validateInput(state, alice, { tap: true }, ctx)).toEqual({ ok: true });
    expect(mod.validateInput(state, alice, { tap: false } as never, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, alice, {} as never, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, alice, null as never, ctx)).toMatchObject({ ok: false });
    state = mod.handleInput(state, alice, { tap: true }, ctx);
    expect(state.taps.p1).toEqual({ tappedAt: ctx.now(), falseStart: true });
    expect(mod.validateInput(state, alice, { tap: true }, ctx)).toMatchObject({ ok: false, reason: /already/ });
    expect(mod.validateInput(state, players[1]!, { tap: true }, ctx)).toEqual({ ok: true });
  });

  it('evaluates reaction times from server timestamps and scores on an absolute scale', () => {
    const { ctx, clock } = fakeCtx();
    const t0 = clock.now;
    let state = mod.createInstance(config, ctx);
    for (const p of players) state = mod.onAttemptStart!(state, p, ctx);
    clock.now = t0 + 3_000;
    state = mod.onTimer!(state, 'go', ctx, 'p1');
    clock.now = t0 + 10_000;
    state = mod.onTimer!(state, 'go', ctx, 'p2');
    state = mod.onTimer!(state, 'go', ctx, 'p3');
    // p4 taps before their GO ever fires.
    const goP1 = t0 + 3_000;
    const goP2 = t0 + 10_000;

    const e1 = mod.evaluate(state, [sub('p1', t0, goP1 + 200)], ctx); // 200 ms → full points
    const e2 = mod.evaluate(state, [sub('p2', t0, goP2 + 750)], ctx); // 750 ms → half way
    const e3 = mod.evaluate(state, [sub('p3', t0, goP2 + 2_000)], ctx); // slow → floor
    const e4 = mod.evaluate(state, [sub('p4', t0, t0 + 500)], ctx); // false start (no GO yet)
    const e5 = mod.evaluate({ ...state, goAt: { ...state.goAt, p4: t0 + 900 } }, [sub('p4', t0, t0 + 500)], ctx); // tapped before GO

    expect(e1).toEqual({ playerId: 'p1', displayName: 'Alice', reactionMs: 200, falseStart: false, points: 10 });
    expect(e2).toEqual({ playerId: 'p2', displayName: 'Bob', reactionMs: 750, falseStart: false, points: 5.5 });
    expect(e3).toEqual({ playerId: 'p3', displayName: 'Cara', reactionMs: 2000, falseStart: false, points: 1 });
    expect(e4).toEqual({ playerId: 'p4', displayName: 'Dan', reactionMs: null, falseStart: true, points: 0 });
    expect(e5).toMatchObject({ reactionMs: null, falseStart: true, points: 0 });

    expect(mod.calculateScores(state, e1, ctx)).toEqual([{ playerId: 'p1', points: 10, reason: 'Reacted in 200 ms' }]);
    expect(mod.calculateScores(state, e3, ctx)).toEqual([{ playerId: 'p3', points: 1, reason: 'Reacted in 2000 ms' }]);
    expect(mod.calculateScores(state, e4, ctx)).toEqual([{ playerId: 'p4', points: 0, reason: 'False start' }]);

    const stats = mod.getStatistics(state, [e1, e2, e3, e4], ctx);
    expect(stats).toEqual({
      taps: 4,
      validTaps: 3,
      falseStarts: 1,
      fastestMs: 200,
      slowestMs: 2000,
      averageMs: 983,
      medianMs: 750,
      stdDevMs: 753,
      fastest: { name: 'Alice', ms: 200 },
    });
    expect(mod.getStatistics(state, [], ctx)).toMatchObject({ taps: 0, validTaps: 0, fastestMs: null, medianMs: null, fastest: null });
    expect(JSON.parse(JSON.stringify(e1))).toEqual(e1);
  });

  it('applies the false start penalty as a negative award', () => {
    const { ctx, clock } = fakeCtx();
    const state = mod.onAttemptStart!(mod.createInstance({ ...config, falseStartPenalty: 3 }, ctx), players[0]!, ctx);
    const evaluation = mod.evaluate(state, [sub('p1', clock.now, clock.now + 100)], ctx);
    expect(evaluation.points).toBe(-3);
    expect(mod.calculateScores(state, evaluation, ctx)).toEqual([{ playerId: 'p1', points: -3, reason: 'False start (-3 penalty)' }]);
  });

  it('guestView shows Wait, then TAP NOW, then the personal time, and never another player', () => {
    const { ctx, clock } = fakeCtx();
    const alice = players[0]!;
    const bob = players[1]!;
    let state = mod.createInstance(config, ctx);
    state = mod.onAttemptStart!(state, alice, ctx);
    state = mod.onAttemptStart!(state, bob, ctx);

    const waiting = mod.guestView(state, alice, ctx);
    expect(waiting.canSubmit).toBe(true);
    let json = JSON.stringify(waiting.ui);
    expect(json).toContain('Wait…');
    expect(json).toContain('"danger"');
    expect(json).toContain('"size":"huge"');
    expect(json).toContain('"payload":{"tap":true}');
    expect(json).not.toContain('"timer"');

    clock.now += 2_500;
    state = mod.onTimer!(state, 'go', ctx, 'p1');
    const go = mod.guestView(state, alice, ctx);
    json = JSON.stringify(go.ui);
    expect(json).toContain('TAP NOW!');
    expect(json).toContain('"success"');
    expect(json).toContain('"timer"');
    // Bob has not had his GO yet: still red, and he cannot see Alice's state.
    const bobJson = JSON.stringify(mod.guestView(state, bob, ctx).ui);
    expect(bobJson).toContain('Wait…');
    expect(bobJson).not.toContain('TAP NOW');

    clock.now += 320;
    state = mod.handleInput(state, alice, { tap: true }, ctx);
    const tapped = mod.guestView(state, alice, ctx);
    expect(tapped.canSubmit).toBe(false);
    expect(JSON.stringify(tapped.ui)).toContain('320 ms');
    expect(JSON.stringify(mod.guestView(state, bob, ctx).ui)).not.toContain('320 ms');

    clock.now += 100;
    state = mod.handleInput(state, bob, { tap: true }, ctx);
    const bobTapped = mod.guestView(state, bob, ctx);
    expect(bobTapped.canSubmit).toBe(false);
    expect(JSON.stringify(bobTapped.ui)).toContain('False start!');
  });

  it('mainView and introView leak nothing about timing', () => {
    const { ctx, clock } = fakeCtx([0.5]);
    let state = mod.onAttemptStart!(mod.createInstance(config, ctx), players[0]!, ctx);
    clock.now += 4_000;
    state = mod.onTimer!(state, 'go', ctx, 'p1');
    const main = JSON.stringify(mod.mainView!(state, ctx));
    expect(main).not.toContain('"timer"');
    expect(main).not.toContain(String(clock.now));
    expect(main).not.toContain('goAt');
    expect(JSON.stringify(mod.introView!(state, players[0]!, ctx))).toContain('10 points');
  });

  it('resultsView ranks reaction times so far and personalises guests', () => {
    const { ctx, clock } = fakeCtx();
    const t0 = clock.now;
    let state = mod.createInstance(config, ctx);
    state = { ...state, goAt: { p1: t0, p2: t0, p3: t0 } };
    const evaluations = [
      mod.evaluate(state, [sub('p2', t0 - 3000, t0 + 640)], ctx),
      mod.evaluate(state, [sub('p1', t0 - 3000, t0 + 310)], ctx),
      mod.evaluate(state, [sub('p3', t0 - 3000, t0 - 10)], ctx),
    ];
    const results = mod.resultsView(state, evaluations, ctx);
    const rows = (results.ui as { children: { type: string; rows?: { name: string; value: string }[] }[] }).children.find((n) => n.type === 'ranking')!.rows!;
    expect(rows.map((r) => r.name)).toEqual(['Alice', 'Bob', 'Cara']);
    expect(rows[2]!.value).toBe('False start');
    const json = JSON.stringify(results.ui);
    expect(json).toContain('Fastest 310 ms');
    expect(json).toContain('1 false start');

    const alice = JSON.stringify(results.guestUi!(players[0]!));
    expect(alice).toContain('310 ms');
    expect(alice).toContain('#1 of 2');
    expect(alice).toContain('of 10 points');
    const cara = JSON.stringify(results.guestUi!(players[2]!));
    expect(cara).toContain('False start!');
    expect(cara).toContain('0 points');
    expect(JSON.stringify(results.guestUi!(players[3]!))).toContain('did not tap');
    expect(JSON.stringify(mod.resultsView(state, [], ctx).ui)).toContain('No valid taps yet');
  });
});
