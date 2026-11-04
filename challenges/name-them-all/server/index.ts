/**
 * Name Them All (contract v2).
 *
 * The host lists every answer of a category ("Name the Mars rovers"); players type as many as
 * they can before their time runs out. Every entry is a live action (`ui.wordEntry`): the box
 * empties at once for the next one and the list under it shows what came of each entry (or,
 * with `showFound` off, only what was entered). Each answer scores its own points.
 *
 * Entries are compared forgivingly: capitals, accents, spaces, hyphens and punctuation never
 * matter, a leading "the" is ignored, and small spelling mistakes are fine (edit distance,
 * with adjacent letters swapped counting as one mistake): "persaverance" is Perseverance. How
 * many mistakes depends on the answer's length and the host's `spelling` setting. An entry
 * goes to the closest answer, preferring one the player has not named yet.
 *
 * The attempt ends with "I'm done" or when the time runs out: `lockInput` turns the entries
 * into the player's submission, so everything named before the buzzer counts.
 */
import { defineModule, ui, type ListItem, type Manifest, type PlayerRef, type PresentationSlide, type UINode } from '@challenge/contract';
import manifestJson from '../manifest.json' with { type: 'json' };
import schemaJson from '../config.schema.json' with { type: 'json' };

interface AnswerSpec {
  answer: string;
  alternatives?: string;
  points?: number;
}

type Spelling = 'exact' | 'normal' | 'loose';

interface Config {
  prompt: string;
  answers: AnswerSpec[];
  pointsEach: number;
  timeLimit: number;
  spelling?: Spelling;
  showFound?: boolean;
  media?: string;
}

/** One thing a player entered. */
interface Entry {
  text: string;
  /** The answer it named (index into the answers), or null: not on the list. */
  answer: number | null;
  /** Named before (the same answer, or the same text). */
  repeat?: boolean;
}

interface State {
  config: Config;
  /** playerId → their entries in the current attempt, oldest first. */
  entries: Record<string, Entry[]>;
}

/** One evaluation per attempt (results: immediate). */
interface Evaluation {
  playerId: string;
  displayName: string;
  /** Answers named, in the host's order. */
  found: number[];
  entered: number;
  points: number;
}

const ACTION = 'guess';
const MAX_LENGTH = 80;
const MAX_ENTRIES = 300;

/** Capitals, accents, spaces, hyphens, punctuation and a leading "the" never matter. */
export function simplify(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .trim()
    .replace(/^the\s+/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Edits between two strings; swapping two neighbouring letters is one edit (optimal string alignment). */
export function distance(a: string, b: string): number {
  if (a === b) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, d[i - 2]![j - 2]! + 1);
      d[i]![j] = best;
    }
  }
  return d[a.length]![b.length]!;
}

/** Spelling mistakes allowed for an answer of this (simplified) length. Short answers must be exact. */
export function allowance(length: number, spelling: Spelling = 'normal'): number {
  if (spelling === 'exact') return 0;
  if (spelling === 'loose') return length <= 3 ? 0 : length <= 6 ? 1 : length <= 10 ? 2 : 3;
  return length <= 4 ? 0 : length <= 8 ? 1 : 2;
}

function accepted(spec: AnswerSpec): string[] {
  return [spec.answer, ...(spec.alternatives ?? '').split(',')].map(simplify).filter(Boolean);
}

/**
 * The answer an entry names, or null. The closest answer within its allowance wins; on a tie
 * one the player has not named yet (`named`) goes first, then the host's order.
 */
export function matchAnswer(config: Config, text: string, named: ReadonlySet<number> = new Set()): number | null {
  const g = simplify(text);
  if (!g) return null;
  let best: { index: number; d: number; named: boolean } | null = null;
  for (const [index, spec] of config.answers.entries()) {
    for (const a of accepted(spec)) {
      const d = a === g ? 0 : distance(a, g);
      if (d > allowance(a.length, config.spelling)) continue;
      const candidate = { index, d, named: named.has(index) };
      if (!best || d < best.d || (d === best.d && best.named && !candidate.named)) best = candidate;
    }
  }
  return best?.index ?? null;
}

function pointsOf(config: Config, index: number): number {
  const own = config.answers[index]?.points;
  return Math.max(0, typeof own === 'number' && Number.isFinite(own) ? own : (config.pointsEach ?? 0));
}

function foundBy(entries: Entry[] | undefined): number[] {
  const found = new Set<number>();
  for (const e of entries ?? []) if (e.answer !== null) found.add(e.answer);
  return [...found].sort((a, b) => a - b);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function nameOf(players: PlayerRef[], id: string): string {
  return players.find((p) => p.id === id)?.displayName ?? 'Unknown';
}

const showFound = (config: Config) => config.showFound !== false;

/** The entries list under the box, newest first. */
function entryList(config: Config, entries: Entry[]): UINode {
  const shown = showFound(config);
  const items: ListItem[] = [...entries].reverse().map((e) => {
    if (!shown) return { label: e.text, value: e.repeat ? 'already entered' : undefined, tone: 'neutral' as const };
    if (e.answer === null) return { label: e.text, value: e.repeat ? 'already tried' : 'not on the list', tone: 'muted' as const };
    const answer = config.answers[e.answer]!.answer;
    const label = simplify(answer) === simplify(e.text) ? answer : `${answer} (${e.text})`;
    return { label, value: e.repeat ? 'already named' : '✓', tone: e.repeat ? ('muted' as const) : ('success' as const) };
  });
  return ui.list(items);
}

export default defineModule<Config, State, Record<string, unknown>, Evaluation>({
  manifest: manifestJson as unknown as Manifest,
  configurationSchema: schemaJson,

  createInstance(config) {
    return { config, entries: {} };
  },

  timeLimit(state) {
    return state.config.timeLimit > 0 ? state.config.timeLimit : null;
  },

  onAttemptStart(state, player, ctx) {
    if (state.config.timeLimit > 0) ctx.schedule('lock', state.config.timeLimit, player.id); // 0 = no time limit
    return { ...state, entries: { ...state.entries, [player.id]: [] } };
  },

  validateAction(state, player, payload) {
    const text = payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[ACTION] : undefined;
    if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: 'Type an answer' };
    if (text.length > MAX_LENGTH) return { ok: false, reason: 'That is too long' };
    if ((state.entries[player.id]?.length ?? 0) >= MAX_ENTRIES) return { ok: false, reason: 'That is enough answers' };
    return { ok: true };
  },

  onAction(state, player, payload) {
    const text = String((payload as Record<string, unknown>)[ACTION]).trim().replace(/\s+/g, ' ');
    const mine = state.entries[player.id] ?? [];
    const named = new Set(foundBy(mine));
    const answer = matchAnswer(state.config, text, named);
    const sameText = mine.some((e) => simplify(e.text) === simplify(text));
    // With the list hidden, only the same text again is a repeat: anything more would tell.
    const repeat = showFound(state.config) ? (answer !== null ? named.has(answer) : sameText) : sameText;
    const entry: Entry = { text, answer, ...(repeat ? { repeat: true } : {}) };
    return { ...state, entries: { ...state.entries, [player.id]: [...mine, entry] } };
  },

  // "I'm done" submits nothing: the entries are in state.
  validateInput() {
    return { ok: true };
  },

  handleInput(state) {
    return state;
  },

  // Time up (or the host closing it): whatever was entered counts.
  lockInput(state, player) {
    return (state.entries[player.id]?.length ?? 0) > 0 ? {} : null;
  },

  playerNote(state, player) {
    const entries = state.entries[player.id];
    if (!entries?.length) return null;
    return showFound(state.config) ? `${foundBy(entries).length} of ${state.config.answers.length} named` : `${plural(entries.filter((e) => !e.repeat).length, 'answer')} entered`;
  },

  evaluate(state, submissions, ctx) {
    // Immediate results: one submission; the entries are in state.
    const s = submissions[0]!;
    const entries = state.entries[s.playerId] ?? [];
    const found = foundBy(entries);
    return {
      playerId: s.playerId,
      displayName: nameOf(ctx.players(), s.playerId),
      found,
      entered: entries.filter((e) => !e.repeat).length,
      points: found.reduce((a, i) => a + pointsOf(state.config, i), 0),
    };
  },

  calculateScores(state, evaluation) {
    const n = state.config.answers.length;
    return [{ playerId: evaluation.playerId, points: evaluation.points, reason: evaluation.found.length === n ? `All ${n} named` : `Named ${evaluation.found.length} of ${n}` }];
  },

  getStatistics(state, evaluations) {
    const total = evaluations.length;
    return {
      prompt: state.config.prompt,
      answers: state.config.answers.length,
      players: total,
      averageFound: total ? Math.round((evaluations.reduce((a, e) => a + e.found.length, 0) / total) * 100) / 100 : null,
      perAnswer: state.config.answers.map((spec, i) => ({ answer: spec.answer, found: evaluations.filter((e) => e.found.includes(i)).length })),
    };
  },

  introView(state) {
    const c = state.config;
    const time = c.timeLimit > 0 ? `${c.timeLimit} seconds` : 'as long as you like';
    return ui.stack(
      [
        ui.subtitle(c.prompt),
        ui.text(`There are ${c.answers.length} to name. You have ${time}: type one, press Enter, type the next.`),
        ui.caption('Capitals, spaces, hyphens and small spelling mistakes do not matter.'),
      ],
      { gap: 'sm' },
    );
  },

  guestView(state, player, ctx) {
    const c = state.config;
    const entries = state.entries[player.id] ?? [];
    const found = foundBy(entries).length;
    const children: UINode[] = [ui.subtitle(c.prompt)];
    if (c.media) children.push(ui.image(ctx.mediaUrl(c.media), { maxHeight: '24vh' }));
    if (c.timeLimit > 0) children.push(ui.timer('lock'));
    children.push(ui.wordEntry(ACTION, { placeholder: 'Type an answer', maxLength: MAX_LENGTH }));
    if (entries.length) children.push(entryList(c, entries));
    children.push(ui.submit("I'm done", { tone: 'neutral' }));
    const unique = entries.filter((e) => !e.repeat).length;
    return {
      ui: ui.stack(children, { gap: 'md', align: 'stretch' }),
      canSubmit: true,
      status: showFound(c) ? `${found} of ${c.answers.length} named` : `${plural(unique, 'answer')} entered`,
    };
  },

  mainView(state) {
    return ui.caption(`${state.config.prompt}: ${state.config.answers.length} to name`);
  },

  presentation(state, evaluations): PresentationSlide[] {
    // Every answer and how many players named it, most named first.
    const c = state.config;
    if (c.answers.length === 0) return [];
    const total = evaluations.length;
    const counted = c.answers.map((spec, i) => ({ answer: spec.answer, n: evaluations.filter((e) => e.found.includes(i)).length })).sort((a, b) => b.n - a.n);
    const perColumn = Math.ceil(counted.length / (counted.length <= 10 ? 1 : counted.length <= 24 ? 2 : 3));
    const columns: UINode[] = [];
    for (let i = 0; i < counted.length; i += perColumn) {
      columns.push(ui.list(counted.slice(i, i + perColumn).map((a) => ({ label: a.answer, value: `${a.n} of ${total}`, tone: a.n === 0 ? ('muted' as const) : ('success' as const) }))));
    }
    const nobody = counted.filter((a) => a.n === 0).length;
    return [
      {
        caption: c.prompt,
        steps: [
          ui.stack(
            [ui.grid(columns.length, columns, { gap: 'md' }), ui.caption(nobody ? `Nobody named ${nobody === 1 ? 'this one' : `${nobody} of them`}` : 'Every answer was named by someone', { align: 'center' })],
            { gap: 'md', align: 'stretch' },
          ),
        ],
        stepSeconds: Math.min(40, 10 + counted.length),
      },
    ];
  },

  resultsView(state, evaluations) {
    const c = state.config;
    const total = evaluations.length;
    const perAnswer = ui.list(c.answers.map((spec, i) => ({ label: spec.answer, value: `${evaluations.filter((e) => e.found.includes(i)).length}/${total}`, tone: 'success' as const })));
    const best = evaluations.reduce((a, e) => Math.max(a, e.found.length), 0);
    const summary = ui.badge(total ? `Most named: ${best} of ${c.answers.length}` : 'Nobody played yet', best > 0 ? 'success' : 'muted');
    return {
      ui: ui.stack([ui.caption(c.prompt, { align: 'center' }), perAnswer, ui.row([summary], { justify: 'center' })], { gap: 'md', align: 'stretch' }),
      guestUi: (player) => {
        const me = evaluations.find((e) => e.playerId === player.id);
        if (!me) return ui.stack([ui.caption(c.prompt), ui.badge('You did not play', 'muted'), perAnswer], { gap: 'md' });
        const all = me.found.length === c.answers.length;
        const rows = ui.list(
          c.answers.map((spec, i) => {
            const got = me.found.includes(i);
            return { label: spec.answer, value: got ? `✓ ${plural(pointsOf(c, i), 'pt')}` : 'missed', tone: got ? ('success' as const) : ('muted' as const) };
          }),
        );
        const head = ui.title(all ? 'You named them all!' : `You named ${me.found.length} of ${c.answers.length}`, { tone: all ? 'success' : me.found.length ? 'neutral' : 'danger' });
        return ui.stack([ui.caption(c.prompt), ui.card([head, ui.text(plural(me.points, 'point'), { tone: 'muted' })], all ? 'success' : 'neutral'), rows], { gap: 'md' });
      },
    };
  },
});
