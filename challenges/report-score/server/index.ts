/**
 * Report Your Score (contract v2).
 *
 * The points are decided outside the app (a darts round, a pub quiz): each player fills in
 * a number and that number is their score, up to `maxPoints`. A number above the maximum
 * costs `penalty` points and closes the challenge for that player. Players are not warned
 * about the penalty beforehand; they find out when it happens.
 *
 * Every entry is its own attempt (`attempts: "repeat"`), so an entry above the maximum is
 * scored on its own (minus `penalty`) the moment it comes in. The host can open the
 * challenge again for that player (`closedFor` / `reopenFor`); the deduction stays. Once a
 * valid number is in, the player is done (`canStart` → finished).
 */
import { defineModule, ui, type Manifest, type PlayerRef, type UINode } from '@challenge/contract';
import manifestJson from '../manifest.json' with { type: 'json' };
import schemaJson from '../config.schema.json' with { type: 'json' };

interface Config {
  prompt: string;
  maxPoints: number;
  penalty: number;
}

interface Entry {
  value: number;
  /** Above the maximum: cost `penalty` points and did not count. */
  over: boolean;
  at: number;
}

interface State {
  config: Config;
  /** playerId → their entries, oldest first. */
  entries: Record<string, Entry[]>;
  /** playerId → how many of their entries above the maximum the host has let go (reopened). */
  reopened?: Record<string, number>;
}

interface Input {
  value: number;
}

/** One evaluation per entry (results: immediate). */
interface Evaluation {
  playerId: string;
  displayName: string;
  value: number;
  over: boolean;
  points: number;
}

const MAX_VALUE = 1e9;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function nameOf(players: PlayerRef[], id: string): string {
  return players.find((p) => p.id === id)?.displayName ?? 'Unknown';
}

function entriesOf(state: State, playerId: string): Entry[] {
  return state.entries[playerId] ?? [];
}

/** The player's valid number, once they filled one in. */
function acceptedOf(state: State, playerId: string): Entry | undefined {
  return entriesOf(state, playerId).find((e) => !e.over);
}

function oversOf(state: State, playerId: string): number {
  return entriesOf(state, playerId).filter((e) => e.over).length;
}

function deductedOf(state: State, playerId: string): number {
  return oversOf(state, playerId) * state.config.penalty;
}

/** Closed for this player: they went over the maximum and the host has not reopened it. */
function isClosed(state: State, playerId: string): boolean {
  return !acceptedOf(state, playerId) && oversOf(state, playerId) > (state.reopened?.[playerId] ?? 0);
}

/** The message after an entry above the maximum. */
export function overMessage(config: Config, value: number): string {
  const cost = config.penalty > 0 ? ` ${plural(config.penalty, 'point')} ${config.penalty === 1 ? 'has' : 'have'} been deducted from your total, and this` : ' This';
  return `${value} is more than the maximum of ${config.maxPoints}.${cost} challenge is now closed for you.`;
}

export default defineModule<Config, State, Input, Evaluation>({
  manifest: manifestJson as unknown as Manifest,
  configurationSchema: schemaJson,

  createInstance(config) {
    return { config, entries: {} };
  },

  canStart(state, player) {
    const accepted = acceptedOf(state, player.id);
    if (accepted) return { ok: false, reason: `Your score: ${accepted.value}`, finished: true };
    if (isClosed(state, player.id)) return { ok: false, reason: 'Closed for you', finished: true };
    return { ok: true, hint: 'Fill in your score' };
  },

  closedFor(state) {
    return Object.keys(state.entries).filter((id) => isClosed(state, id));
  },

  reopenFor(state, player) {
    // The deduction stays; the player may fill in a number again.
    return { ...state, reopened: { ...state.reopened, [player.id]: oversOf(state, player.id) } };
  },

  validateInput(_state, _player, input) {
    const raw = input && typeof input === 'object' ? (input as { value?: unknown }).value : undefined;
    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return { ok: false, reason: 'Fill in your score' };
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false, reason: 'Fill in a number' };
    // Mistypes are not penalised; only a number above the maximum is.
    if (!Number.isInteger(n) || n < 0) return { ok: false, reason: 'Fill in a whole number of 0 or more' };
    if (n > MAX_VALUE) return { ok: false, reason: 'That number is too large' };
    return { ok: true };
  },

  handleInput(state, player, input, ctx) {
    const value = Number(input.value);
    const entry: Entry = { value, over: value > state.config.maxPoints, at: ctx.now() };
    return { ...state, entries: { ...state.entries, [player.id]: [...entriesOf(state, player.id), entry] } };
  },

  playerNote(state, player) {
    const entries = entriesOf(state, player.id);
    const last = entries.at(-1);
    if (!last) return null;
    if (last.over) return isClosed(state, player.id) ? { text: overMessage(state.config, last.value), tone: 'danger' } : 'Open again: fill in your score';
    const deducted = deductedOf(state, player.id);
    return { text: `Your score: ${last.value}${deducted > 0 ? ` (−${deducted} for going over the maximum)` : ''}`, tone: 'success' };
  },

  evaluate(state, submissions, ctx) {
    // Immediate results: exactly one submission, one entry.
    const s = submissions[0]!;
    const value = Number(s.payload.value);
    const over = value > state.config.maxPoints;
    return { playerId: s.playerId, displayName: nameOf(ctx.players(), s.playerId), value, over, points: over ? 0 - state.config.penalty : value };
  },

  calculateScores(state, evaluation) {
    const reason = evaluation.over ? `${evaluation.value} is above the maximum of ${state.config.maxPoints}` : 'Reported score';
    return [{ playerId: evaluation.playerId, points: evaluation.points, reason }];
  },

  getStatistics(_state, evaluations) {
    const valid = evaluations.filter((e) => !e.over);
    const over = evaluations.filter((e) => e.over);
    return {
      reported: valid.length,
      average: valid.length ? Math.round((valid.reduce((a, e) => a + e.value, 0) / valid.length) * 100) / 100 : null,
      highest: valid.length ? Math.max(...valid.map((e) => e.value)) : null,
      overMaximum: over.length,
      deducted: -over.reduce((a, e) => a + e.points, 0),
    };
  },

  introView(state) {
    const c = state.config;
    return ui.stack(
      [
        ui.text(c.prompt),
        ui.caption(`The number you fill in is added to your total as points, up to ${c.maxPoints}.`),
      ],
      { gap: 'sm' },
    );
  },

  guestView(state, player) {
    const c = state.config;
    const children: UINode[] = [ui.subtitle(c.prompt)];
    children.push(ui.numberInput('value', { label: 'Your points', min: 0, step: 1, placeholder: '0' }));
    children.push(ui.caption(`Maximum ${c.maxPoints}.`));
    children.push(ui.submit('Lock in my score', { size: 'lg' }));
    // No word about the penalty: players find out when they go over.
    return { ui: ui.stack(children, { gap: 'md' }), canSubmit: true, status: `Up to ${c.maxPoints} points` };
  },

  mainView(state) {
    return ui.caption(state.config.prompt);
  },

  resultsView(state, evaluations) {
    const c = state.config;
    const rows = new Map<string, { name: string; value: number | null; deducted: number }>();
    for (const e of evaluations) {
      const row = rows.get(e.playerId) ?? { name: e.displayName, value: null, deducted: 0 };
      if (e.over) row.deducted -= e.points;
      else row.value = e.value;
      rows.set(e.playerId, row);
    }
    const total = (r: { value: number | null; deducted: number }) => (r.value ?? 0) - r.deducted;
    const sorted = [...rows.values()].sort((a, b) => total(b) - total(a) || a.name.localeCompare(b.name));
    let rank = 0;
    let previous: number | null = null;
    const ranking = ui.ranking(
      sorted.map((r, i) => {
        if (total(r) !== previous) rank = i + 1;
        previous = total(r);
        const value = `${r.value === null ? 'no score' : r.value}${r.deducted > 0 ? ` · −${r.deducted}` : ''}`;
        return { rank, name: r.name, value, points: total(r), highlight: rank === 1 && r.value !== null };
      }),
    );
    const overCount = evaluations.filter((e) => e.over).length;
    const badges = ui.row(
      [ui.badge(`${evaluations.filter((e) => !e.over).length} reported`), ui.badge(`Maximum ${c.maxPoints}`), ...(overCount ? [ui.badge(`${overCount} over the maximum`, 'danger')] : [])],
      { gap: 'sm', wrap: true, justify: 'center' },
    );
    const shared = ui.stack(
      [ui.caption(c.prompt, { align: 'center' }), evaluations.length ? ranking : ui.caption('Nobody has reported a score yet.', { align: 'center' }), badges],
      { gap: 'md', align: 'stretch' },
    );
    return {
      ui: shared,
      guestUi: (player) => {
        const mine = rows.get(player.id);
        const card: UINode = !mine
          ? ui.badge('You did not report a score', 'muted')
          : ui.card(
              [
                ui.display(mine.value === null ? '—' : String(mine.value)),
                ui.text(mine.deducted > 0 ? `−${mine.deducted} for going over the maximum` : 'points reported', { tone: 'muted' }),
              ],
              mine.deducted > 0 ? 'neutral' : 'success',
            );
        return ui.stack([ui.caption(c.prompt), card, ranking], { gap: 'md' });
      },
    };
  },
});
