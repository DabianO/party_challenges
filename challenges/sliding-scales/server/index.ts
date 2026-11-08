/**
 * Sliding Scales (contract v2), a Hot Takes challenge.
 *
 * Statements answered on a slider between a minimum and a maximum, e.g. "Maximum acceptable
 * shower time (0–60 minutes)". Players see every statement in a list, answer as many as they
 * like and change their minds whenever they want: every change is a live action
 * (`ui.liveAnswer`), so the attempt stays open until the host closes the challenge.
 *
 * The big screen's spotlight shows each statement with a histogram of the answers
 * (`spotlight`); `activity` counts new and changed answers so busy statements come first.
 * Optional participation points are awarded when the challenge closes.
 */
import { defineModule, ui, type Manifest, type PlayerRef, type PresentationSlide, type SpotlightItem, type UINode } from '@challenge/contract';
import manifestJson from '../manifest.json' with { type: 'json' };
import schemaJson from '../config.schema.json' with { type: 'json' };

interface Statement {
  text: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}

interface Config {
  statements: Statement[];
  pointsPerAnswer?: number;
}

interface State {
  config: Config;
  /** statement id → playerId → answer. */
  answers: Record<string, Record<string, number>>;
  /** statement id → number of new or changed answers so far. */
  activity: Record<string, number>;
}

/** Live action payload: `{ answer: { id, value } }`. */
interface Answer {
  id: string;
  value: number;
}

/** Aggregate evaluation (results: onClose): how many statements each player answered. */
interface Evaluation {
  answered: Record<string, number>;
}

const ACTION = 'answer';
/** More distinct values than this are grouped into ranges in the histogram. */
const MAX_COLUMNS = 12;
const RANGES = 10;

interface Scale {
  min: number;
  max: number;
  step: number;
  unit: string;
}

/** The statement's slider, repaired where the configuration does not add up. */
function scaleOf(s: Statement): Scale {
  let min = Number.isFinite(s.min) ? (s.min as number) : 0;
  let max = Number.isFinite(s.max) ? (s.max as number) : 10;
  if (min > max) [min, max] = [max, min];
  if (min === max) max = min + 1;
  const step = Number.isFinite(s.step) && (s.step as number) > 0 ? Math.min(s.step as number, max - min) : 1;
  return { min, max, step, unit: (s.unit ?? '').trim() };
}

const idOf = (index: number) => `s${index}`;

/** Round away floating-point noise (0.1 + 0.2). */
function clean(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}

/** The nearest value on the slider's grid, inside its range. */
function snap(value: number, scale: Scale): number {
  const steps = Math.round((value - scale.min) / scale.step);
  return clean(Math.min(scale.max, Math.max(scale.min, scale.min + steps * scale.step)));
}

function num(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function withUnit(n: number, unit: string): string {
  return unit ? `${num(n)} ${unit}` : num(n);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function statementsOf(state: State): { id: string; text: string; scale: Scale }[] {
  return state.config.statements.map((s, i) => ({ id: idOf(i), text: s.text, scale: scaleOf(s) }));
}

function answeredBy(state: State, playerId: string): number {
  return statementsOf(state).filter((s) => state.answers[s.id]?.[playerId] !== undefined).length;
}

/** Histogram columns: one per value when there are few, otherwise equal ranges. */
function columnsOf(values: number[], scale: Scale, mine?: number): { columns: { label: string; count: number }[]; highlight?: number; ranged: boolean } {
  const distinct = Math.round((scale.max - scale.min) / scale.step) + 1;
  if (distinct <= MAX_COLUMNS) {
    const columns = Array.from({ length: distinct }, (_, i) => ({ label: num(clean(scale.min + i * scale.step)), count: 0 }));
    const indexOf = (v: number) => Math.min(distinct - 1, Math.max(0, Math.round((v - scale.min) / scale.step)));
    for (const v of values) columns[indexOf(v)]!.count++;
    return { columns, highlight: mine === undefined ? undefined : indexOf(mine), ranged: false };
  }
  const width = (scale.max - scale.min) / RANGES;
  const columns = Array.from({ length: RANGES }, (_, i) => ({ label: `${num(scale.min + i * width)}–${num(scale.min + (i + 1) * width)}`, count: 0 }));
  const indexOf = (v: number) => Math.min(RANGES - 1, Math.max(0, Math.floor((v - scale.min) / width)));
  for (const v of values) columns[indexOf(v)]!.count++;
  return { columns, highlight: mine === undefined ? undefined : indexOf(mine), ranged: true };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** One statement and how everyone answered it (big screen, results). */
function statementView(state: State, s: { id: string; text: string; scale: Scale }, mine?: number): UINode {
  const values = Object.values(state.answers[s.id] ?? {});
  const { scale } = s;
  const { columns, highlight, ranged } = columnsOf(values, scale, mine);
  const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const summary = values.length
    ? `${plural(values.length, 'answer')} · average ${withUnit(avg!, scale.unit)} · median ${withUnit(median(values), scale.unit)}`
    : 'No answers yet: be the first!';
  return ui.stack(
    [
      ui.title(s.text, { align: 'center' }),
      ui.distribution(columns, {
        axis: { start: withUnit(scale.min, scale.unit), end: withUnit(scale.max, scale.unit) },
        marker: avg === null ? undefined : { at: (avg - scale.min) / (scale.max - scale.min), label: `avg ${withUnit(avg, scale.unit)}` },
        highlight,
        // Ranges of a long scale: a calm histogram, the axis carries the numbers.
        compact: ranged || undefined,
      }),
      ui.caption(mine === undefined ? summary : `You: ${withUnit(mine, scale.unit)} · ${summary}`, { align: 'center' }),
    ],
    { gap: 'md', align: 'stretch' },
  );
}

/** Columns for `n` statements on one presentation slide, so they all fit. */
function columnsFor(n: number): number {
  return n <= 2 ? n : n <= 4 ? 2 : n <= 9 ? 3 : n <= 16 ? 4 : 5;
}

const INSTRUCTIONS = 'Answer as many as you like and change your mind any time. Go back to the other challenges whenever you want and come back later.';

export default defineModule<Config, State, unknown, Evaluation>({
  manifest: manifestJson as unknown as Manifest,
  configurationSchema: schemaJson,

  createInstance(config) {
    return { config, answers: {}, activity: {} };
  },

  // Answers are live actions; there is nothing to submit.
  // Answers are live actions; submitting only locks them in for good (Back keeps them open).
  validateInput(state, player) {
    return answeredBy(state, player.id) > 0 ? { ok: true } : { ok: false, reason: 'Answer at least one first' };
  },

  handleInput(state) {
    return state;
  },

  validateAction(state, _player, payload) {
    const answer = payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[ACTION] : undefined;
    if (!answer || typeof answer !== 'object') return { ok: false, reason: 'Unknown action' };
    const { id, value } = answer as Partial<Answer>;
    const statement = statementsOf(state).find((s) => s.id === id);
    if (!statement) return { ok: false, reason: 'Unknown statement' };
    if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, reason: 'Pick a value on the slider' };
    if (value < statement.scale.min || value > statement.scale.max) return { ok: false, reason: 'That value is off the scale' };
    return { ok: true };
  },

  onAction(state, player, payload) {
    const { id, value } = (payload as Record<string, Answer>)[ACTION]!;
    const statement = statementsOf(state).find((s) => s.id === id)!;
    const snapped = snap(value, statement.scale);
    if (state.answers[id]?.[player.id] === snapped) return state;
    return {
      ...state,
      answers: { ...state.answers, [id]: { ...state.answers[id], [player.id]: snapped } },
      activity: { ...state.activity, [id]: (state.activity[id] ?? 0) + 1 },
    };
  },

  playerNote(state, player) {
    const answered = answeredBy(state, player.id);
    return answered ? `${answered} of ${state.config.statements.length} answered` : null;
  },

  evaluate(state) {
    // Scored from state: answers are live actions, not submissions.
    const answered: Record<string, number> = {};
    for (const byPlayer of Object.values(state.answers)) for (const playerId of Object.keys(byPlayer)) answered[playerId] = (answered[playerId] ?? 0) + 1;
    return { answered };
  },

  calculateScores(state, evaluation) {
    const each = Math.max(0, state.config.pointsPerAnswer ?? 0);
    return Object.entries(evaluation.answered).map(([playerId, n]) => ({ playerId, points: n * each, reason: `Answered ${plural(n, 'statement')}` }));
  },

  getStatistics(state, evaluations) {
    const answered = evaluations[0]?.answered ?? {};
    return {
      statements: state.config.statements.length,
      answers: Object.values(answered).reduce((a, b) => a + b, 0),
      players: Object.keys(answered).length,
    };
  },

  introView(state) {
    const n = state.config.statements.length;
    return ui.stack([ui.text(`${plural(n, 'statement')} to answer on a slider.`), ui.caption(INSTRUCTIONS)], { gap: 'sm' });
  },

  guestView(state, player) {
    const statements = statementsOf(state);
    const answered = answeredBy(state, player.id);
    return {
      ui: ui.stack(
        [
          ui.caption(INSTRUCTIONS),
          ...statements.map((s) =>
            ui.card([
              ui.text(s.text),
              ui.liveAnswer(ACTION, s.id, state.answers[s.id]?.[player.id] ?? null, {
                min: s.scale.min,
                max: s.scale.max,
                step: s.scale.step,
                unit: s.scale.unit || undefined,
                marks: [
                  { value: s.scale.min, label: withUnit(s.scale.min, s.scale.unit) },
                  { value: s.scale.max, label: withUnit(s.scale.max, s.scale.unit) },
                ],
              }),
            ]),
          ),
          // Optional: going back keeps everything open to change later.
          ui.submit('✓ Done: lock in my answers', { tone: 'neutral', disabled: answered === 0 }),
          ui.caption('Or just go back: your answers are kept, and you can change them until the challenge closes.', { align: 'center' }),
        ],
        { gap: 'md', align: 'stretch' },
      ),
      canSubmit: true,
      status: `${answered} of ${statements.length} answered · change them any time, or lock them in`,
    };
  },

  mainView(state) {
    return ui.caption(`${plural(state.config.statements.length, 'hot take')} on a sliding scale: what does the room think?`);
  },

  spotlight(state): SpotlightItem[] {
    return statementsOf(state).map((s) => ({ id: s.id, label: s.text, activity: state.activity[s.id] ?? 0, ui: statementView(state, s) }));
  },

  presentation(state): PresentationSlide[] {
    // Every one on a single slide (the big screen shrinks it to fit).
    const all = statementsOf(state);
    if (all.length === 0) return [];
    return [{ steps: [ui.grid(columnsFor(all.length), all.map((s) => ui.card([statementView(state, s)])), { gap: 'md' })], stepSeconds: Math.min(60, 10 + 3 * all.length) }];
  },

  resultsView(state) {
    const statements = statementsOf(state);
    return {
      ui: ui.stack(statements.map((s) => statementView(state, s)), { gap: 'lg', align: 'stretch' }),
      guestUi: (player: PlayerRef) => ui.stack(statements.map((s) => statementView(state, s, state.answers[s.id]?.[player.id])), { gap: 'lg', align: 'stretch' }),
    };
  },
});
