/**
 * Likelihoods (contract v2), a Hot Takes challenge.
 *
 * Statements about how likely something is, answered from 0% (never) to 100% (certain), e.g.
 * "Likelihood that the world will end because of climate change". Players see every statement
 * in a list, answer as many as they like and change their minds whenever they want: every
 * change is a live action (`ui.liveAnswer`), so the attempt stays open until the host closes
 * the challenge.
 *
 * The big screen's spotlight shows each statement with a histogram of the answers in ten
 * ranges (`spotlight`); `activity` counts new and changed answers so busy statements come
 * first. Optional participation points are awarded when the challenge closes.
 */
import { defineModule, ui, type Manifest, type PlayerRef, type SpotlightItem, type UINode } from '@challenge/contract';
import manifestJson from '../manifest.json' with { type: 'json' };
import schemaJson from '../config.schema.json' with { type: 'json' };

interface Statement {
  text: string;
}

interface Config {
  statements: Statement[];
  pointsPerAnswer?: number;
}

interface State {
  config: Config;
  /** statement id → playerId → answer in percent (integer 0..100). */
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
const MIN = 0;
const MAX = 100;
/** Where an unanswered slider starts. */
const START = 50;
/** Histogram columns of 10 percentage points each; 100% counts in the last one. */
const RANGES = 10;
const NEVER = '0% · never';
const EVEN = '50%';
const CERTAIN = '100% · certain';

const idOf = (index: number) => `s${index}`;

function pct(n: number): string {
  return `${Math.round(n)}%`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function statementsOf(state: State): { id: string; text: string }[] {
  return state.config.statements.map((s, i) => ({ id: idOf(i), text: s.text }));
}

function answeredBy(state: State, playerId: string): number {
  return statementsOf(state).filter((s) => state.answers[s.id]?.[playerId] !== undefined).length;
}

/** Which of the ten ranges a percentage falls in: 0–9 → 0, 10–19 → 1, … 90–100 → 9. */
function rangeOf(value: number): number {
  return Math.min(RANGES - 1, Math.max(0, Math.floor(value / RANGES)));
}

/** Histogram columns "0–10%" … "90–100%". */
function columnsOf(values: number[]): { label: string; count: number }[] {
  const width = (MAX - MIN) / RANGES;
  const columns = Array.from({ length: RANGES }, (_, i) => ({ label: `${MIN + i * width}–${MIN + (i + 1) * width}%`, count: 0 }));
  for (const v of values) columns[rangeOf(v)]!.count++;
  return columns;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** One statement and how everyone answered it (big screen, results). */
function statementView(state: State, s: { id: string; text: string }, mine?: number): UINode {
  const values = Object.values(state.answers[s.id] ?? {});
  const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const summary = values.length
    ? `${plural(values.length, 'answer')} · average ${pct(avg!)} · median ${pct(median(values))}`
    : 'No answers yet: be the first!';
  return ui.stack(
    [
      ui.title(s.text, { align: 'center' }),
      ui.distribution(columnsOf(values), {
        axis: { start: NEVER, middle: EVEN, end: CERTAIN },
        marker: avg === null ? undefined : { at: (avg - MIN) / (MAX - MIN), label: `avg ${pct(avg)}` },
        highlight: mine === undefined ? undefined : rangeOf(mine),
        compact: true,
      }),
      ui.caption(mine === undefined ? summary : `You: ${pct(mine)} · ${summary}`, { align: 'center' }),
    ],
    { gap: 'md', align: 'stretch' },
  );
}

const INSTRUCTIONS = 'Answer as many as you like and change your mind any time. Go back to the other challenges whenever you want and come back later.';

export default defineModule<Config, State, unknown, Evaluation>({
  manifest: manifestJson as unknown as Manifest,
  configurationSchema: schemaJson,

  createInstance(config) {
    return { config, answers: {}, activity: {} };
  },

  // Answers are live actions; there is nothing to submit.
  validateInput() {
    return { ok: false, reason: 'Move the sliders to answer' };
  },

  handleInput(state) {
    return state;
  },

  validateAction(state, _player, payload) {
    const answer = payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[ACTION] : undefined;
    if (!answer || typeof answer !== 'object') return { ok: false, reason: 'Unknown action' };
    const { id, value } = answer as Partial<Answer>;
    if (!statementsOf(state).some((s) => s.id === id)) return { ok: false, reason: 'Unknown statement' };
    if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, reason: 'Pick a percentage on the slider' };
    if (value < MIN || value > MAX) return { ok: false, reason: 'A likelihood is between 0% and 100%' };
    return { ok: true };
  },

  onAction(state, player, payload) {
    const { id, value } = (payload as Record<string, Answer>)[ACTION]!;
    const rounded = Math.round(value);
    if (state.answers[id]?.[player.id] === rounded) return state;
    return {
      ...state,
      answers: { ...state.answers, [id]: { ...state.answers[id], [player.id]: rounded } },
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
    return ui.stack([ui.text(`${plural(n, 'statement')}: how likely is it, from 0% to 100%?`), ui.caption(INSTRUCTIONS)], { gap: 'sm' });
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
                min: MIN,
                max: MAX,
                step: 1,
                unit: '%',
                start: START,
                marks: [
                  { value: MIN, label: NEVER },
                  { value: START, label: EVEN },
                  { value: MAX, label: CERTAIN },
                ],
              }),
            ]),
          ),
        ],
        { gap: 'md', align: 'stretch' },
      ),
      canSubmit: false,
      status: `${answered} of ${statements.length} answered · change them any time`,
    };
  },

  mainView(state) {
    return ui.caption(`${plural(state.config.statements.length, 'hot take')} in percentages: how likely does the room think it is?`);
  },

  spotlight(state): SpotlightItem[] {
    return statementsOf(state).map((s) => ({ id: s.id, label: s.text, activity: state.activity[s.id] ?? 0, ui: statementView(state, s) }));
  },

  resultsView(state) {
    const statements = statementsOf(state);
    return {
      ui: ui.stack(statements.map((s) => statementView(state, s)), { gap: 'lg', align: 'stretch' }),
      guestUi: (player: PlayerRef) => ui.stack(statements.map((s) => statementView(state, s, state.answers[s.id]?.[player.id])), { gap: 'lg', align: 'stretch' }),
    };
  },
});
