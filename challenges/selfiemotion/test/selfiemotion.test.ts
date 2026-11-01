import { describe, expect, it } from 'vitest';
import type { InstanceContext, Judgement, PlayerRef, Submission } from '@challenge/contract';
import mod from '../server/index.ts';

const players: PlayerRef[] = ['Ada', 'Bea', 'Cyd', 'Dee', 'Eve'].map((name, i) => ({ id: `p${i + 1}`, displayName: name, connected: true }));

function fakeCtx(rng = () => 0.5) {
  const scheduled: { tag: string; seconds: number; playerId?: string }[] = [];
  const ctx: InstanceContext = {
    gameId: 'g1',
    instanceId: 'i1',
    rng,
    now: () => 1_700_000_000_000,
    players: () => players,
    schedule: (tag, seconds, playerId) => scheduled.push({ tag, seconds, playerId }),
    cancel: () => {},
    emit: () => {},
    mediaUrl: (ref) => ref.replace('media://', '/media/'),
  };
  return { ctx, scheduled };
}

const config = { emojis: ['😂', '😱', '😍'], timeLimit: 120, points: 5 };

const judgement = (decision: 'approve' | 'reject', by: 'peer' | 'host' = 'peer', points?: number): Judgement => ({
  assignmentId: 'a1',
  by,
  judgePlayerId: by === 'peer' ? 'p2' : null,
  decision,
  points,
  decidedAt: 1,
});

const sub = (playerId: string, judgements: Judgement[] = []): Submission<{ photo: string }> => ({
  id: `s-${playerId}`,
  playerId,
  payload: { photo: `media://${playerId}` },
  startedAt: 0,
  submittedAt: 1,
  judgements,
});

describe('selfiemotion', () => {
  it('has a consistent manifest: creativity, judged by a peer by default, automatic allowed', () => {
    expect(mod.manifest).toMatchObject({ id: 'selfiemotion', version: '1.0.0', apiVersion: '2', category: 'creativity', results: 'immediate' });
    expect(mod.manifest.evaluation).toMatchObject({ mode: 'peer', supportedModes: ['automatic', 'peer', 'host', 'hybrid'], evidence: { kind: 'image', field: 'photo' } });
  });

  it('hands out the emojis evenly, a new one on a replay, and starts the time limit', () => {
    const { ctx, scheduled } = fakeCtx();
    let state = mod.createInstance(config, ctx);
    for (const p of players.slice(0, 3)) state = mod.onAttemptStart!(state, p, ctx);
    expect(new Set(Object.values(state.emoji)).size).toBe(3);
    const before = state.emoji.p1;
    state = mod.onAttemptStart!(state, players[0]!, ctx);
    expect(state.emoji.p1).not.toBe(before);
    expect(scheduled).toContainEqual({ tag: 'lock', seconds: 120, playerId: 'p1' });
    // The selfie camera and the emoji to recreate.
    const json = JSON.stringify(mod.guestView(state, players[0]!, ctx).ui);
    expect(json).toContain(state.emoji.p1!);
    expect(json).toContain('"capture":"user"');
  });

  it('scores approved selfies, rejected ones not, and host points as given; automatic counts every selfie', () => {
    const { ctx } = fakeCtx();
    const state = mod.onAttemptStart!(mod.createInstance(config, ctx), players[0]!, ctx);
    const score = (judgements: Judgement[]) => mod.calculateScores(state, mod.evaluate(state, [sub('p1', judgements)], ctx), ctx)[0]!.points;
    expect(score([judgement('approve')])).toBe(5);
    expect(score([judgement('reject')])).toBe(0);
    expect(score([judgement('approve', 'host', 8)])).toBe(8);
    expect(score([])).toBe(5);
    expect(mod.evaluate(state, [sub('p1')], ctx)).toMatchObject({ emoji: state.emoji.p1, photo: 'media://p1', approved: true });
  });

  it('shows judges the emoji next to the selfie', () => {
    const { ctx } = fakeCtx();
    const state = mod.onAttemptStart!(mod.createInstance(config, ctx), players[0]!, ctx);
    const json = JSON.stringify(mod.presentSubmission!(state, sub('p1'), ctx));
    expect(json).toContain(state.emoji.p1!);
    expect(json).toContain('/media/p1');
    expect(json).not.toContain('Ada');
  });

  it('presents four selfies per slide, emoji and selfie side by side, without rejected ones', () => {
    const { ctx } = fakeCtx();
    let state = mod.createInstance(config, ctx);
    for (const p of players) state = mod.onAttemptStart!(state, p, ctx);
    const evaluations = players.map((p) => mod.evaluate(state, [sub(p.id, p.id === 'p3' ? [judgement('reject')] : [judgement('approve')])], ctx));
    // Five players, one rejected: one slide of four.
    let slides = mod.presentation!(state, evaluations, ctx);
    expect(slides).toHaveLength(1);
    const json = JSON.stringify(slides[0]!.steps[0]);
    expect(json).toContain('"type":"grid","columns":2');
    expect(json).toContain('/media/p1');
    expect(json).not.toContain('/media/p3');
    expect(json).toContain('Dee');
    expect(slides[0]!.caption).toBeUndefined();
    const all = players.map((p) => mod.evaluate(state, [sub(p.id)], ctx));
    slides = mod.presentation!(state, all, ctx);
    expect(slides.map((s) => s.caption)).toEqual(['1–4 of 5', '5–5 of 5']);
    expect(slides[1]!.steps[0]).toMatchObject({ type: 'grid', columns: 1 });
    expect(mod.presentation!(state, [], ctx)).toEqual([]);
  });
});
