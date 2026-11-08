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

const config = { task: 'Take a selfie with someone wearing red', timeLimit: 180, points: 10 };

const judgement = (decision: 'approve' | 'reject', by: 'peer' | 'host' = 'peer', extra: Partial<Judgement> = {}): Judgement => ({
  assignmentId: 'a1',
  by,
  judgePlayerId: by === 'peer' ? 'p2' : null,
  decision,
  decidedAt: T0 + 5000,
  ...extra,
});

const submission = (playerId: string, photo: unknown, judgements: Judgement[] = []): Submission<{ photo: string }> => ({
  id: `s-${playerId}`,
  playerId,
  payload: { photo } as { photo: string },
  startedAt: T0,
  submittedAt: T0 + 30_000,
  judgements,
});

describe('photo-hunt', () => {
  it('has a consistent v2 manifest with image evidence', () => {
    expect(mod.manifest.id).toBe('photo-hunt');
    expect(mod.manifest.version).toBe('1.3.0');
    expect(mod.manifest.apiVersion).toBe('2');
    expect(mod.manifest.category).toBe('chaos');
    expect(mod.manifest.results).toBe('immediate');
    expect(mod.manifest.resubmission).toBe('none');
    expect(mod.manifest.evaluation.mode).toBe('peer');
    expect(mod.manifest.evaluation.supportedModes).toEqual(['peer', 'host', 'hybrid']);
    expect(mod.manifest.evaluation.criteria).toContain('taken just now');
    expect(mod.manifest.evaluation.evidence).toEqual({ kind: 'image', field: 'photo', label: 'Photo' });
    expect(mod.manifest.evaluation.hostScoring).toEqual({ min: 0, max: 10, step: 1 });
    expect(mod.manifest.capabilities).toEqual(expect.arrayContaining(['camera', 'evidence-upload', 'image', 'timer']));
  });

  it('schedules a per-player lock timer on start', () => {
    const { ctx, scheduled } = fakeCtx();
    const state = mod.createInstance(config, ctx);
    mod.onAttemptStart!(state, players[0]!, ctx);
    mod.onAttemptStart!(state, players[1]!, ctx);
    expect(scheduled).toEqual([
      { tag: 'lock', seconds: 180, playerId: 'p1' },
      { tag: 'lock', seconds: 180, playerId: 'p2' },
    ]);
  });

  it('accepts only media references as the photo', () => {
    const { ctx } = fakeCtx();
    const state = mod.createInstance(config, ctx);
    const alice = players[0]!;
    expect(mod.validateInput(state, alice, { photo: 'media://abc_DEF-123' }, ctx)).toEqual({ ok: true });
    expect(mod.validateInput(state, alice, { photo: 'https://evil.example/x.jpg' }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, alice, { photo: 'media://' }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, alice, { photo: 'media://has space' }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, alice, { photo: '' }, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, alice, { photo: 5 } as never, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, alice, {} as never, ctx)).toMatchObject({ ok: false });
    expect(mod.validateInput(state, alice, null as never, ctx)).toMatchObject({ ok: false });
    const next = mod.handleInput(state, alice, { photo: 'media://abc' }, ctx);
    expect(next.photos).toEqual({ p1: 'media://abc' });
    expect(state.photos).toEqual({});
  });

  it('maps judgements to points and produces statistics', () => {
    const { ctx } = fakeCtx();
    const state = mod.createInstance(config, ctx);
    const approved = mod.evaluate(state, [submission('p1', 'media://a1', [judgement('approve', 'peer', { note: 'Very red' })])], ctx);
    expect(approved).toEqual({ playerId: 'p1', displayName: 'Alice', photo: 'media://a1', approved: true, hostPoints: null, note: 'Very red', decidedBy: 'peer' });
    expect(mod.calculateScores(state, approved, ctx)).toEqual([{ playerId: 'p1', points: 10, reason: 'Photo approved' }]);

    const rejected = mod.evaluate(state, [submission('p2', 'media://b1', [judgement('reject', 'peer')])], ctx);
    expect(mod.calculateScores(state, rejected, ctx)).toEqual([{ playerId: 'p2', points: 0, reason: 'Photo rejected' }]);

    // Hybrid escalation: peer rejected, host overruled with points → last judgement wins.
    const hostScored = mod.evaluate(state, [submission('p3', 'media://c1', [judgement('reject', 'peer'), judgement('approve', 'host', { points: 6 })])], ctx);
    expect(hostScored.approved).toBe(true);
    expect(hostScored.hostPoints).toBe(6);
    expect(mod.calculateScores(state, hostScored, ctx)).toEqual([{ playerId: 'p3', points: 6, reason: 'Scored by the host' }]);

    expect(mod.evaluate(state, [submission('p1', 'media://a1')], ctx).approved).toBe(false);
    expect(mod.calculateScores(state, { ...approved, playerId: 'ghost' }, ctx)).toEqual([]);

    expect(mod.getStatistics(state, [approved, rejected, hostScored], ctx)).toEqual({
      task: config.task,
      photos: 3,
      approved: 2,
      approvalRate: 0.67,
      judgedByHost: 1,
    });
    expect(mod.getStatistics(state, [], ctx)).toEqual({ task: config.task, photos: 0, approved: 0, approvalRate: null, judgedByHost: 0 });
    expect(JSON.parse(JSON.stringify(approved))).toEqual(approved);
  });

  it('shows judges the task and the photo through mediaUrl', () => {
    const { ctx } = fakeCtx();
    ctx.mediaUrl = (ref) => `https://cdn.test/${ref.replace('media://', '')}`;
    const state = mod.createInstance(config, ctx);
    const json = JSON.stringify(mod.presentSubmission!(state, submission('p1', 'media://a1'), ctx));
    expect(json).toContain(config.task);
    expect(json).toContain('"type":"image"');
    expect(json).toContain('https://cdn.test/a1');
  });

  it('guestView offers the camera file input, then locks after the single submission', () => {
    const { ctx } = fakeCtx();
    let state = mod.createInstance(config, ctx);
    const open = mod.guestView(state, players[0]!, ctx);
    expect(open.canSubmit).toBe(true);
    const json = JSON.stringify(open.ui);
    expect(json).toContain(config.task);
    expect(json).toContain('"tag":"lock"');
    expect(json).toContain('"type":"file-input"');
    expect(json).toContain('"name":"photo"');
    expect(json).toContain('"accept":"image/*"');
    expect(json).toContain('"capture":"environment"');
    expect(json).toContain('"action":"submit"');

    state = mod.handleInput(state, players[0]!, { photo: 'media://alice' }, ctx);
    state = mod.handleInput(state, players[1]!, { photo: 'media://bob' }, ctx);
    const alice = mod.guestView(state, players[0]!, ctx);
    expect(alice.canSubmit).toBe(false);
    expect(JSON.stringify(alice.ui)).toContain('media://alice');
    expect(JSON.stringify(alice.ui)).not.toContain('media://bob');
    const cara = JSON.stringify(mod.guestView(state, players[2]!, ctx).ui);
    expect(cara).not.toContain('media://alice');
    expect(cara).toContain('"type":"file-input"');

    const main = JSON.stringify(mod.mainView!(state, ctx));
    expect(main).toContain('2 photos so far');
    expect(main).not.toContain('media://');
    expect(main).not.toContain('Alice');
    expect(JSON.stringify(mod.introView!(state, players[0]!, ctx))).toContain('180 seconds');
  });

  it('resultsView shows a grid of approved photos and personal verdicts', () => {
    const { ctx } = fakeCtx();
    const state = mod.createInstance(config, ctx);
    const a = mod.evaluate(state, [submission('p1', 'media://a1', [judgement('approve')])], ctx);
    const b = mod.evaluate(state, [submission('p2', 'media://b1', [judgement('reject', 'host', { note: 'That is orange' })])], ctx);
    const c = mod.evaluate(state, [submission('p3', 'media://c1', [judgement('approve', 'host', { points: 9 })])], ctx);
    const results = mod.resultsView(state, [a, b, c], ctx);
    const shared = JSON.stringify(results.ui);
    expect(shared).toContain('3 photos');
    expect(shared).toContain('2 approved');
    expect(shared).toContain('"type":"grid","columns":2');
    expect(shared).toContain('media://a1');
    expect(shared).toContain('media://c1');
    expect(shared).not.toContain('media://b1');
    expect(JSON.stringify(results.guestUi!(players[0]!))).toContain('Approved! +10 points');
    const bob = JSON.stringify(results.guestUi!(players[1]!));
    expect(bob).toContain('media://b1');
    expect(bob).toContain('rejected');
    expect(bob).toContain('That is orange');
    expect(JSON.stringify(results.guestUi!(players[2]!))).toContain('The host gave you 9 points');
    expect(JSON.stringify(mod.resultsView(state, [], ctx).ui)).toContain('No approved photos yet.');
  });
});

describe('photo-hunt presentation', () => {
  it('shows the task with every approved photo and who took it, without points or verdicts', () => {
    const { ctx } = fakeCtx();
    const state = mod.createInstance(config, ctx);
    const evaluations = [
      mod.evaluate(state, [submission('p1', 'media://a1', [judgement('approve')])], ctx),
      mod.evaluate(state, [submission('p2', 'media://b1', [judgement('reject', 'peer', { note: 'That is orange' })])], ctx),
      mod.evaluate(state, [submission('p3', 'media://c1', [judgement('approve', 'host', { points: 9 })])], ctx),
    ];
    const slides = mod.presentation!(state, evaluations, ctx);
    expect(slides).toHaveLength(1);
    const shown = JSON.stringify(slides);
    expect(shown).toContain(config.task);
    expect(shown).toContain('"type":"grid","columns":2');
    expect(shown).toContain('media://a1');
    expect(shown).toContain('media://c1');
    expect(shown).toContain('Alice');
    expect(shown).toContain('Cara');
    expect(shown).not.toContain('media://b1');
    expect(shown).not.toContain('Bob');
    expect(shown).not.toMatch(/orange|reject|approved|points/i);
  });

  it('puts six photos on a slide in three columns', () => {
    const { ctx } = fakeCtx();
    const state = mod.createInstance(config, ctx);
    const evaluations = Array.from({ length: 7 }, (_, i) => mod.evaluate(state, [submission(`p${(i % 3) + 1}`, `media://x${i}`, [judgement('approve')])], ctx));
    const slides = mod.presentation!(state, evaluations, ctx);
    expect(slides.map((s) => s.caption)).toEqual(['Photos 1–6 of 7', 'Photos 7–7 of 7']);
    expect(JSON.stringify(slides[0])).toContain('"type":"grid","columns":3');
    expect(JSON.stringify(slides[1])).toContain('"type":"grid","columns":1');
    expect(mod.presentation!(state, [], ctx)).toEqual([]);
  });
});
