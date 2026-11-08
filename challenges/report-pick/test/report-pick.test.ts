import { describe, expect, it } from 'vitest';
import type { InstanceContext, PlayerRef, Submission, UINode } from '@challenge/contract';
import { walkUI } from '@challenge/contract';
import { validateConfiguration } from '../../../packages/engine/src/validation.ts';
import mod, { signed } from '../server/index.ts';

const players: PlayerRef[] = [
  { id: 'p1', displayName: 'Ada', connected: true },
  { id: 'p2', displayName: 'Bea', connected: true },
];

const ctx: InstanceContext = {
  gameId: 'g1',
  instanceId: 'i1',
  rng: () => 0.5,
  now: () => 1_700_000_000_000,
  players: () => players,
  schedule: () => {},
  cancel: () => {},
  emit: () => {},
  mediaUrl: (ref) => ref,
};

const config = {
  prompt: 'Which colour ball did you pick?',
  options: [
    { label: 'Gold', points: 10, color: '#f2c230' },
    { label: 'Red', points: 5, color: '#e53935' },
    { label: 'Black', points: -3, color: '#212121' },
    { label: 'Plain', points: 0 },
  ],
  picks: 1,
  showPoints: true,
};

const sub = (playerId: string, option: string): Submission<{ option: string }> => ({
  id: `s-${playerId}-${option}`,
  playerId,
  payload: { option },
  startedAt: 0,
  submittedAt: 1,
  judgements: [],
});

/** One pick the way the engine runs it: start, validate, handle, evaluate. */
function pick(state: ReturnType<typeof mod.createInstance>, player: PlayerRef, option: string) {
  expect(mod.canStart!(state, player, ctx)).toMatchObject({ ok: true });
  expect(mod.validateInput(state, player, { option }, ctx)).toEqual({ ok: true });
  const next = mod.handleInput(state, player, { option }, ctx);
  const evaluation = mod.evaluate(next, [sub(player.id, option)], ctx);
  return { state: next, evaluation, scores: mod.calculateScores(next, evaluation, ctx) };
}

function find<T extends UINode['type']>(node: UINode | null | undefined, type: T): Extract<UINode, { type: T }>[] {
  const out: Extract<UINode, { type: T }>[] = [];
  if (node) walkUI(node, (n) => n.type === type && out.push(n as Extract<UINode, { type: T }>));
  return out;
}

describe('report-pick', () => {
  it('has a consistent manifest', () => {
    expect(mod.manifest).toMatchObject({ id: 'report-pick', version: '1.0.0', apiVersion: '2', results: 'immediate', attempts: 'repeat', resubmission: 'none' });
    expect(mod.manifest.evaluation).toEqual({ mode: 'automatic' });
  });

  it('validates the configuration, including the colours', () => {
    const ok = validateConfiguration(mod.configurationSchema, { prompt: 'Ball?', options: [{ label: 'Red', points: 5, color: '#e53935' }, { label: 'Plain', points: -2 }] });
    expect(ok.ok).toBe(true);
    expect(ok.value).toMatchObject({ picks: 1, showPoints: true });
    expect(validateConfiguration(mod.configurationSchema, { prompt: 'Ball?', options: [{ label: 'Red', points: 5, color: 'red' }, { label: 'B', points: 1 }] }).ok).toBe(false);
    expect(validateConfiguration(mod.configurationSchema, { prompt: 'Ball?', options: [{ label: 'Red', points: 5 }] }).ok).toBe(false);
  });

  it('shows the options as coloured buttons with their points', () => {
    const view = mod.guestView(mod.createInstance(config, ctx), players[0]!, ctx);
    const [choices] = find(view.ui, 'choices');
    expect(choices!.options).toEqual([
      { id: '0', label: 'Gold (+10)', color: '#f2c230' },
      { id: '1', label: 'Red (+5)', color: '#e53935' },
      { id: '2', label: 'Black (−3)', color: '#212121' },
      { id: '3', label: 'Plain (0)', color: undefined },
    ]);
    const hidden = mod.guestView(mod.createInstance({ ...config, showPoints: false }, ctx), players[0]!, ctx);
    expect(find(hidden.ui, 'choices')[0]!.options.map((o) => o.label)).toEqual(['Gold', 'Red', 'Black', 'Plain']);
  });

  it('scores the picked option, negative too, then the player is done', () => {
    const { state, scores } = pick(mod.createInstance(config, ctx), players[0]!, '1');
    expect(scores).toEqual([{ playerId: 'p1', points: 5, reason: 'Picked Red' }]);
    expect(mod.canStart!(state, players[0]!, ctx)).toEqual({ ok: false, reason: 'Your pick: Red (+5)', finished: true });
    expect(mod.playerNote!(state, players[0]!, ctx)).toEqual({ text: 'You picked Red: +5 points', tone: 'success' });

    const black = pick(mod.createInstance(config, ctx), players[1]!, '2');
    expect(black.scores[0]!.points).toBe(-3);
    expect(mod.playerNote!(black.state, players[1]!, ctx)).toEqual({ text: 'You picked Black: −3 points', tone: 'warning' });
  });

  it('refuses a missing or unknown option', () => {
    const state = mod.createInstance(config, ctx);
    expect(mod.validateInput(state, players[0]!, {} as never, ctx)).toEqual({ ok: false, reason: 'Tap what you got first' });
    expect(mod.validateInput(state, players[0]!, { option: '4' }, ctx)).toEqual({ ok: false, reason: 'Pick one of the options' });
    expect(mod.validateInput(state, players[0]!, { option: 'x' }, ctx)).toEqual({ ok: false, reason: 'Pick one of the options' });
  });

  it('adds up several picks per player', () => {
    let state = mod.createInstance({ ...config, picks: 3 }, ctx);
    const ada = players[0]!;
    expect(mod.canStart!(state, ada, ctx)).toEqual({ ok: true, hint: '3 picks to report' });
    let total = 0;
    for (const option of ['0', '2', '1']) {
      const r = pick(state, ada, option);
      state = r.state;
      total += r.scores[0]!.points;
    }
    expect(total).toBe(12);
    expect(mod.canStart!(state, ada, ctx)).toEqual({ ok: false, reason: 'Your picks: Gold, Black, Red · +12 points', finished: true });
  });

  it('keeps what a pick was worth when the host edits the options later', () => {
    const { state } = pick(mod.createInstance(config, ctx), players[0]!, '0');
    const edited = { ...state, config: { ...state.config, options: [{ label: 'Gold', points: 1 }, ...state.config.options.slice(1)] } };
    expect(mod.canStart!(edited, players[0]!, ctx)).toMatchObject({ reason: 'Your pick: Gold (+10)' });
  });

  it('presents how often each option was picked, in its colour, without names', () => {
    let state = mod.createInstance(config, ctx);
    const evaluations = [];
    for (const [player, option] of [
      [players[0]!, '1'],
      [players[1]!, '1'],
    ] as const) {
      const r = pick(state, player, option);
      state = r.state;
      evaluations.push(r.evaluation);
    }
    const slides = mod.presentation!(state, evaluations, ctx);
    expect(slides).toHaveLength(1);
    const [chart] = find(slides[0]!.steps[0], 'bar-chart');
    expect(chart!.bars).toEqual([
      { label: 'Gold', value: 0, color: '#f2c230' },
      { label: 'Red', value: 2, color: '#e53935' },
      { label: 'Black', value: 0, color: '#212121' },
      { label: 'Plain', value: 0, color: undefined },
    ]);
    expect(JSON.stringify(slides)).not.toContain('Ada');
    expect(mod.presentation!(mod.createInstance(config, ctx), [], ctx)).toEqual([]);
  });

  it('formats signed points', () => {
    expect([signed(4), signed(-2), signed(0)]).toEqual(['+4', '−2', '0']);
  });
});
