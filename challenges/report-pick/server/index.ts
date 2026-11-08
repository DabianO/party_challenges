/**
 * Report Your Pick (contract v2).
 *
 * Like Report Your Score, the outcome is decided outside the app, but players tap one of the
 * options the host defined instead of filling in a number: the colour of the ball they drew
 * from a bag, the card they turned over. Each option is worth its own points (negative too),
 * and may have a colour (`#rrggbb`) for its button and its bar on the big screen.
 *
 * Every pick is its own attempt (`attempts: "repeat"`), up to `picks` per player; their
 * points add up. A pick is copied into the state with its label, points and colour at the
 * time, so editing the options later does not change what earlier picks were worth.
 *
 * Once closed, the host can show how often each option was picked (`presentation`): no
 * names and no points, so no ranking.
 */
import { defineModule, ui, type Manifest, type PlayerRef, type PresentationSlide, type UINode } from '@challenge/contract';
import manifestJson from '../manifest.json' with { type: 'json' };
import schemaJson from '../config.schema.json' with { type: 'json' };

interface Option {
  label: string;
  points: number;
  /** `#rrggbb`: the button's colour. */
  color?: string;
}

interface Config {
  prompt: string;
  options: Option[];
  /** How many times each player reports; their points add up. */
  picks: number;
  /** Show what each option is worth on its button. */
  showPoints: boolean;
}

interface Pick {
  /** Index into `config.options` when picked. */
  index: number;
  label: string;
  points: number;
  color?: string;
  at: number;
}

interface State {
  config: Config;
  /** playerId → their picks, oldest first. */
  picks: Record<string, Pick[]>;
}

interface Input {
  /** The option's index, as a string (a `choices` input). */
  option: string;
}

/** One evaluation per pick (results: immediate). */
interface Evaluation {
  playerId: string;
  displayName: string;
  index: number;
  label: string;
  color?: string;
  points: number;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** "+5", "−3", "0". */
export function signed(points: number): string {
  return points > 0 ? `+${points}` : points < 0 ? `−${-points}` : '0';
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function pointsText(points: number): string {
  return `${signed(points)} ${Math.abs(points) === 1 ? 'point' : 'points'}`;
}

function nameOf(players: PlayerRef[], id: string): string {
  return players.find((p) => p.id === id)?.displayName ?? 'Unknown';
}

function picksOf(state: State, playerId: string): Pick[] {
  return state.picks[playerId] ?? [];
}

function maxPicks(config: Config): number {
  return Math.max(1, config.picks ?? 1);
}

function totalOf(picks: { points: number }[]): number {
  return picks.reduce((a, p) => a + p.points, 0);
}

function colorOf(option: { color?: string }): string | undefined {
  return option.color && HEX.test(option.color) ? option.color : undefined;
}

/** What the player has: "Red (+5)" or "Red, Blue · +7 points". */
function summary(picks: Pick[]): string {
  if (picks.length === 1) return `${picks[0]!.label} (${signed(picks[0]!.points)})`;
  return `${picks.map((p) => p.label).join(', ')} · ${pointsText(totalOf(picks))}`;
}

/** Bars of how often each option was picked, in the host's order, coloured like the buttons. */
function tally(config: Config, picks: { index: number; label: string }[]): UINode {
  const counts = config.options.map(() => 0);
  for (const p of picks) {
    const i = config.options[p.index]?.label === p.label ? p.index : config.options.findIndex((o) => o.label === p.label);
    if (i >= 0) counts[i]! += 1;
  }
  return ui.barChart(config.options.map((o, i) => ({ label: o.label, value: counts[i]!, color: colorOf(o) })));
}

export default defineModule<Config, State, Input, Evaluation>({
  manifest: manifestJson as unknown as Manifest,
  configurationSchema: schemaJson,

  createInstance(config) {
    return { config, picks: {} };
  },

  canStart(state, player) {
    const mine = picksOf(state, player.id);
    const max = maxPicks(state.config);
    if (mine.length >= max) return { ok: false, reason: `${mine.length === 1 ? 'Your pick' : 'Your picks'}: ${summary(mine)}`, finished: true };
    if (max === 1) return { ok: true, hint: 'Report your pick' };
    return { ok: true, hint: mine.length ? `Pick ${mine.length + 1} of ${max} · ${pointsText(totalOf(mine))} so far` : `${max} picks to report` };
  },

  validateInput(state, _player, input) {
    const raw = input && typeof input === 'object' ? (input as { option?: unknown }).option : undefined;
    if (raw === undefined || raw === null || raw === '') return { ok: false, reason: 'Tap what you got first' };
    const index = Number(raw);
    if (!Number.isInteger(index) || index < 0 || index >= state.config.options.length) return { ok: false, reason: 'Pick one of the options' };
    return { ok: true };
  },

  handleInput(state, player, input, ctx) {
    const index = Number(input.option);
    const option = state.config.options[index]!;
    const pick: Pick = { index, label: option.label, points: option.points, at: ctx.now() };
    const color = colorOf(option);
    if (color) pick.color = color;
    return { ...state, picks: { ...state.picks, [player.id]: [...picksOf(state, player.id), pick] } };
  },

  playerNote(state, player) {
    const mine = picksOf(state, player.id);
    const last = mine.at(-1);
    if (!last) return null;
    const total = mine.length > 1 ? ` · ${pointsText(totalOf(mine))} in total` : '';
    const text = `You picked ${last.label}: ${pointsText(last.points)}${total}`;
    if (last.points < 0) return { text, tone: 'warning' };
    if (last.points > 0) return { text, tone: 'success' };
    return text;
  },

  evaluate(state, submissions, ctx) {
    // Immediate results: exactly one submission, the player's latest pick.
    const s = submissions[0]!;
    const index = Number(s.payload.option);
    const last = picksOf(state, s.playerId).at(-1);
    const option = state.config.options[index];
    const pick = last && last.index === index ? last : { index, label: option?.label ?? '?', points: option?.points ?? 0, color: option ? colorOf(option) : undefined };
    const evaluation: Evaluation = { playerId: s.playerId, displayName: nameOf(ctx.players(), s.playerId), index, label: pick.label, points: pick.points };
    if (pick.color) evaluation.color = pick.color;
    return evaluation;
  },

  calculateScores(_state, evaluation) {
    return [{ playerId: evaluation.playerId, points: evaluation.points, reason: `Picked ${evaluation.label}` }];
  },

  getStatistics(state, evaluations) {
    const perOption: Record<string, number> = {};
    for (const o of state.config.options) perOption[o.label] = 0;
    for (const e of evaluations) perOption[e.label] = (perOption[e.label] ?? 0) + 1;
    return {
      picks: evaluations.length,
      players: new Set(evaluations.map((e) => e.playerId)).size,
      perOption,
      totalPoints: totalOf(evaluations),
    };
  },

  introView(state) {
    const c = state.config;
    const max = maxPicks(c);
    const children: UINode[] = [
      ui.text(c.prompt),
      ui.caption(`Tap what you got${max > 1 ? `, ${max} times` : ''}. ${c.showPoints === false ? 'Each option is worth its own points.' : 'What each option is worth:'}`),
    ];
    if (c.showPoints !== false) children.push(ui.list(c.options.map((o) => ({ label: o.label, value: pointsText(o.points) }))));
    return ui.stack(children, { gap: 'sm' });
  },

  guestView(state, player) {
    const c = state.config;
    const mine = picksOf(state, player.id);
    const max = maxPicks(c);
    const children: UINode[] = [ui.subtitle(c.prompt)];
    if (max > 1) {
      const sofar = mine.length ? ` · so far: ${summary(mine)}` : '';
      children.push(ui.caption(`Pick ${mine.length + 1} of ${max}${sofar}`));
    }
    children.push(
      ui.choices(
        'option',
        c.options.map((o, i) => ({ id: String(i), label: c.showPoints === false ? o.label : `${o.label} (${signed(o.points)})`, color: colorOf(o) })),
        { columns: c.options.length > 6 ? 2 : 1 },
      ),
    );
    children.push(ui.submit('Lock in my pick', { size: 'lg' }));
    children.push(ui.caption('Check it before you lock it in: you cannot change it afterwards.'));
    return { ui: ui.stack(children, { gap: 'md' }), canSubmit: true, status: max > 1 ? `Pick ${mine.length + 1} of ${max}` : 'Tap what you got' };
  },

  mainView(state) {
    const all = Object.values(state.picks).flat();
    if (!all.length) return ui.caption(state.config.prompt);
    return ui.stack([ui.caption(state.config.prompt), tally(state.config, all)], { gap: 'sm' });
  },

  presentation(state, evaluations): PresentationSlide[] {
    if (!evaluations.length) return [];
    const players = new Set(evaluations.map((e) => e.playerId)).size;
    const line = evaluations.length === players ? `${plural(players, 'player')} reported` : `${plural(evaluations.length, 'pick')} by ${plural(players, 'player')}`;
    return [
      {
        steps: [ui.stack([ui.title(state.config.prompt, { align: 'center' }), ui.subtitle(line, { align: 'center', tone: 'muted' }), tally(state.config, evaluations)], { gap: 'lg', align: 'stretch' })],
        stepSeconds: 12,
      },
    ];
  },

  resultsView(state, evaluations) {
    const c = state.config;
    const rows = new Map<string, { name: string; picks: Evaluation[] }>();
    for (const e of evaluations) {
      const row = rows.get(e.playerId) ?? { name: e.displayName, picks: [] };
      row.picks.push(e);
      rows.set(e.playerId, row);
    }
    const sorted = [...rows.values()].sort((a, b) => totalOf(b.picks) - totalOf(a.picks) || a.name.localeCompare(b.name));
    let rank = 0;
    let previous: number | null = null;
    const ranking = ui.ranking(
      sorted.map((r, i) => {
        const total = totalOf(r.picks);
        if (total !== previous) rank = i + 1;
        previous = total;
        return { rank, name: r.name, value: r.picks.map((p) => p.label).join(', '), points: total, highlight: rank === 1 };
      }),
    );
    const shared = ui.stack(
      [ui.caption(c.prompt, { align: 'center' }), evaluations.length ? ui.stack([tally(c, evaluations), ranking], { gap: 'md' }) : ui.caption('Nobody has reported a pick yet.', { align: 'center' })],
      { gap: 'md', align: 'stretch' },
    );
    return {
      ui: shared,
      guestUi: (player) => {
        const mine = rows.get(player.id);
        const card: UINode = !mine
          ? ui.badge('You did not report a pick', 'muted')
          : ui.card([ui.display(signed(totalOf(mine.picks))), ui.text(mine.picks.map((p) => `${p.label} (${signed(p.points)})`).join(', '), { tone: 'muted' })], totalOf(mine.picks) < 0 ? 'neutral' : 'success');
        return ui.stack([ui.caption(c.prompt), card, ranking], { gap: 'md' });
      },
    };
  },
});
