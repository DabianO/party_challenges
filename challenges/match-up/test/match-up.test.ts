import { describe, expect, it } from 'vitest';
import type { InstanceContext, PairMatchNode, PlayerRef, UINode } from '@challenge/contract';
import { walkUI } from '@challenge/contract';
import mod, { dealSheet } from '../server/index.ts';

/** A small deterministic random sequence, so every player gets another shuffle. */
function sequence(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

function fakeCtx(players: PlayerRef[], seed = 7) {
  const ctx: InstanceContext = {
    gameId: 'g1',
    instanceId: 'i1',
    rng: sequence(seed),
    now: () => 1_700_000_000_000,
    players: () => players,
    schedule: () => {},
    cancel: () => {},
    emit: () => {},
    mediaUrl: (ref) => ref,
  };
  return { ctx };
}

const ada: PlayerRef = { id: 'p1', displayName: 'Ada', connected: true };
const bea: PlayerRef = { id: 'p2', displayName: 'Bea', connected: true };

const capitals = {
  instructions: 'Match each capital to its country',
  leftTitle: 'Capital',
  rightTitle: 'Country',
  pairs: [
    { left: 'Paris', right: 'France' },
    { left: 'Rome', right: 'Italy' },
    { left: 'Madrid', right: 'Spain' },
    { left: 'Lisbon', right: 'Portugal' },
  ],
  pointsPerMatch: 2,
  bonus: 5,
};

type State = ReturnType<typeof mod.createInstance>;

function pairMatchOf(node: UINode): PairMatchNode {
  let found: PairMatchNode | undefined;
  walkUI(node, (n) => {
    if (n.type === 'pair-match') found = n;
  });
  return found!;
}

function link(state: State, ctx: InstanceContext, who: PlayerRef, left: string, right: string | null): State {
  const payload = { link: { left, right } };
  expect(mod.validateAction!(state, who, payload, ctx)).toEqual({ ok: true });
  return mod.onAction!(state, who, payload, ctx);
}

/** The ids on the player's own sheet of a left and a right item. */
function idsOf(state: State, who: PlayerRef, ctx: InstanceContext, leftLabel: string, rightLabel: string): [string, string] {
  const node = pairMatchOf(mod.guestView(state, who, ctx).ui);
  return [node.left.find((i) => i.label === leftLabel)!.id, node.right.find((i) => i.label === rightLabel)!.id];
}

function linkLabels(state: State, ctx: InstanceContext, who: PlayerRef, pairs: [string, string][]): State {
  for (const [l, r] of pairs) state = link(state, ctx, who, ...idsOf(state, who, ctx, l, r));
  return state;
}

describe('match-up', () => {
  it('has a consistent manifest: scored when the challenge closes', () => {
    expect(mod.manifest).toMatchObject({ id: 'match-up', version: '1.0.0', apiVersion: '2', results: 'onClose', category: 'knowledge' });
    expect(mod.manifest.evaluation).toEqual({ mode: 'automatic' });
  });

  it('deals both columns in a random order, keeping matches apart where it can', () => {
    const rng = sequence(3);
    for (let i = 0; i < 20; i++) {
      const sheet = dealSheet(capitals.pairs, rng);
      expect([...sheet.left].sort()).toEqual([0, 1, 2, 3]);
      expect([...sheet.right].sort()).toEqual([0, 1, 2, 3]);
      expect(sheet.left.some((l, row) => l === sheet.right[row])).toBe(false);
    }
    const two = dealSheet(capitals.pairs.slice(0, 2), sequence(1));
    expect(two.left[0]).not.toBe(two.right[0]);
  });

  it('gives every player their own order, with ids that do not tell what belongs together', () => {
    const { ctx } = fakeCtx([ada, bea]);
    let state = mod.createInstance(capitals, ctx);
    state = mod.onAttemptStart!(state, ada, ctx);
    state = mod.onAttemptStart!(state, bea, ctx);
    const a = pairMatchOf(mod.guestView(state, ada, ctx).ui);
    const b = pairMatchOf(mod.guestView(state, bea, ctx).ui);
    expect(a.left.map((i) => i.id)).toEqual(['a0', 'a1', 'a2', 'a3']);
    expect(a.right.map((i) => i.id)).toEqual(['b0', 'b1', 'b2', 'b3']);
    expect(a.left.map((i) => i.label).sort()).toEqual(['Lisbon', 'Madrid', 'Paris', 'Rome']);
    expect(a.right.map((i) => i.label).sort()).toEqual(['France', 'Italy', 'Portugal', 'Spain']);
    expect([a.left.map((i) => i.label), a.right.map((i) => i.label)]).not.toEqual([b.left.map((i) => i.label), b.right.map((i) => i.label)]);
    expect(a).toMatchObject({ leftTitle: 'Capital', rightTitle: 'Country', links: {} });
  });

  it('links, replaces and undoes; nothing tells whether a link is right', () => {
    const { ctx } = fakeCtx([ada]);
    let state = mod.onAttemptStart!(mod.createInstance(capitals, ctx), ada, ctx);
    const [paris, france] = idsOf(state, ada, ctx, 'Paris', 'France');
    const [rome, italy] = idsOf(state, ada, ctx, 'Rome', 'Italy');
    state = link(state, ctx, ada, paris, italy);
    state = link(state, ctx, ada, rome, italy); // Italy moves to Rome
    expect(pairMatchOf(mod.guestView(state, ada, ctx).ui).links).toEqual({ [rome]: italy });
    state = link(state, ctx, ada, paris, france);
    state = link(state, ctx, ada, rome, null);
    expect(pairMatchOf(mod.guestView(state, ada, ctx).ui).links).toEqual({ [paris]: france });
    const vm = mod.guestView(state, ada, ctx);
    expect(JSON.stringify(vm.ui)).not.toMatch(/✓|✕|correct/i);
    expect(vm).toMatchObject({ canSubmit: false, lockOnLeave: false, status: '1 of 4 linked · come back to it any time' });
    expect(mod.playerNote!(state, ada, ctx)).toBe('1 of 4 linked');
  });

  it('refuses unknown items and actions', () => {
    const { ctx } = fakeCtx([ada]);
    const state = mod.onAttemptStart!(mod.createInstance(capitals, ctx), ada, ctx);
    for (const payload of [{ link: { left: 'a9', right: 'b0' } }, { link: { left: 'b0', right: 'a0' } }, { link: { left: 'a0', right: 'b01' } }, { link: { left: 'a0' } }, { other: 1 }, null]) {
      expect(mod.validateAction!(state, ada, payload, ctx), JSON.stringify(payload)).toMatchObject({ ok: false });
    }
    expect(mod.validateAction!(state, bea, { link: { left: 'a0', right: 'b0' } }, ctx)).toMatchObject({ ok: false }); // not started
  });

  it('locks in once everything is linked: the button, or leaving the screen', () => {
    const { ctx } = fakeCtx([ada]);
    let state = mod.onAttemptStart!(mod.createInstance(capitals, ctx), ada, ctx);
    state = linkLabels(state, ctx, ada, [
      ['Paris', 'France'],
      ['Rome', 'Spain'],
      ['Madrid', 'Italy'],
    ]);
    expect(mod.validateInput(state, ada, {}, ctx)).toMatchObject({ ok: false, reason: 'Link every item first' });
    state = linkLabels(state, ctx, ada, [['Lisbon', 'Portugal']]);
    expect(mod.validateInput(state, ada, {}, ctx)).toEqual({ ok: true });
    const vm = mod.guestView(state, ada, ctx);
    expect(vm).toMatchObject({ canSubmit: true, lockOnLeave: true });
    expect(JSON.stringify(vm.ui)).toContain('Lock in my matches');
  });

  it('scores right links from state when it closes, also unfinished sheets, with a bonus for all', () => {
    const { ctx } = fakeCtx([ada, bea]);
    let state = mod.createInstance(capitals, ctx);
    state = mod.onAttemptStart!(state, ada, ctx);
    state = mod.onAttemptStart!(state, bea, ctx);
    state = linkLabels(state, ctx, ada, [
      ['Paris', 'France'],
      ['Rome', 'Italy'],
      ['Madrid', 'Spain'],
      ['Lisbon', 'Portugal'],
    ]);
    state = linkLabels(state, ctx, bea, [
      ['Paris', 'France'],
      ['Rome', 'Spain'],
    ]);
    const evaluation = mod.evaluate(state, [], ctx);
    expect(mod.calculateScores(state, evaluation, ctx)).toEqual([
      { playerId: 'p1', points: 13, reason: 'All 4 right' },
      { playerId: 'p2', points: 2, reason: '1 of 4 right' },
    ]);
    const stats = mod.getStatistics(state, [evaluation], ctx);
    expect(stats).toMatchObject({ pairs: 4, players: 2, perfect: 1, averageCorrect: 2.5 });

    const results = mod.resultsView(state, [evaluation], ctx);
    const beas = JSON.stringify(results.guestUi!(bea));
    expect(beas).toContain('1 of 4 right');
    expect(beas).toContain('Rome → Spain');
    expect(beas).toContain('✕ Italy');
    expect(beas).toContain('Madrid → —');
  });

  it('counts pairs that share a label either way round', () => {
    const { ctx } = fakeCtx([ada]);
    const config = {
      ...capitals,
      pairs: [
        { left: 'Apple', right: 'Fruit' },
        { left: 'Banana', right: 'Fruit' },
        { left: 'Carrot', right: 'Vegetable' },
      ],
    };
    let state = mod.onAttemptStart!(mod.createInstance(config, ctx), ada, ctx);
    const node = pairMatchOf(mod.guestView(state, ada, ctx).ui);
    const fruits = node.right.filter((i) => i.label === 'Fruit').map((i) => i.id);
    const id = (label: string) => node.left.find((i) => i.label === label)!.id;
    state = link(state, ctx, ada, id('Apple'), fruits[1]!);
    state = link(state, ctx, ada, id('Banana'), fruits[0]!);
    state = link(state, ctx, ada, id('Carrot'), node.right.find((i) => i.label === 'Vegetable')!.id);
    expect(mod.evaluate(state, [], ctx).players[0]).toMatchObject({ correct: 3, points: 11 });
  });

  it('presents the right matches one by one, without points', () => {
    const { ctx } = fakeCtx([ada]);
    let state = mod.onAttemptStart!(mod.createInstance(capitals, ctx), ada, ctx);
    state = linkLabels(state, ctx, ada, [['Paris', 'France']]);
    const slides = mod.presentation!(state, [mod.evaluate(state, [], ctx)], ctx);
    expect(slides).toHaveLength(1);
    expect(slides[0]!.steps).toHaveLength(4);
    const first = JSON.stringify(slides[0]!.steps[0]);
    expect(first).toContain('Paris  →  France');
    expect(first).toContain('1 of 1 right');
    expect(first).toContain('Rome  →  ?');
    expect(first).not.toContain('Italy');
    expect(JSON.stringify(slides[0]!.steps[3])).toContain('Lisbon  →  Portugal');
    expect(JSON.stringify(slides)).not.toMatch(/point|pts/);
  });
});
