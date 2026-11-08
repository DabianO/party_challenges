/**
 * Agree to Disagree (contract v2), a Hot Takes challenge.
 *
 * Statements the players agree or disagree with on a seven-step slider, from "Fully agree" to
 * "Fully disagree", e.g. "Pineapple belongs on pizza". Players see every statement in a list,
 * answer as many as they like and change their minds whenever they want: every change is a
 * live action (`ui.liveAnswer`), so the attempt stays open until the host closes the challenge.
 *
 * The big screen's spotlight shows each statement with a column per level (`spotlight`);
 * `activity` counts new and changed answers so busy statements come first. Optional
 * participation points are awarded when the challenge closes.
 */
import { defineModule, ui, type Manifest, type PlayerRef, type PresentationSlide, type SpotlightItem, type Tone, type UINode } from '@challenge/contract';
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
  /** statement id → playerId → level (0 = Fully agree … 6 = Fully disagree). */
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
/** The slider's steps, left to right; an answer is an index into this list. */
const LEVELS = ['Fully agree', 'Mostly agree', 'Somewhat agree', 'Neutral', 'Somewhat disagree', 'Mostly disagree', 'Fully disagree'];
const MAX = LEVELS.length - 1;
const NEUTRAL = 3;
/** Column colours: the agree side, the middle, the disagree side. */
const TONES: Tone[] = LEVELS.map((_, i) => (i < NEUTRAL ? 'success' : i === NEUTRAL ? 'neutral' : 'danger'));

const idOf = (index: number) => `s${index}`;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function percent(part: number, total: number): string {
  return `${Math.round((part / total) * 100)}%`;
}

function statementsOf(state: State): { id: string; text: string }[] {
  return state.config.statements.map((s, i) => ({ id: idOf(i), text: s.text }));
}

function answeredBy(state: State, playerId: string): number {
  return statementsOf(state).filter((s) => state.answers[s.id]?.[playerId] !== undefined).length;
}

/** One statement and how everyone answered it (big screen, results). */
function statementView(state: State, s: { id: string; text: string }, mine?: number): UINode {
  const values = Object.values(state.answers[s.id] ?? {});
  const columns = LEVELS.map((label, i) => ({ label, count: 0, tone: TONES[i] }));
  for (const v of values) columns[v]!.count++;
  const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const agree = values.filter((v) => v < NEUTRAL).length;
  const neutral = values.filter((v) => v === NEUTRAL).length;
  const disagree = values.length - agree - neutral;
  const summary = values.length
    ? `${plural(values.length, 'answer')} · ${percent(agree, values.length)} agree · ${percent(neutral, values.length)} neutral · ${percent(disagree, values.length)} disagree`
    : 'No answers yet: be the first!';
  return ui.stack(
    [
      ui.title(s.text, { align: 'center' }),
      ui.distribution(columns, {
        axis: { start: 'Agree', middle: 'Neutral', end: 'Disagree' },
        marker: avg === null ? undefined : { at: avg / MAX, label: `avg: ${LEVELS[Math.round(avg)]}` },
        highlight: mine,
      }),
      ui.caption(mine === undefined ? summary : `You: ${LEVELS[mine]} · ${summary}`, { align: 'center' }),
    ],
    { gap: 'md', align: 'stretch' },
  );
}

/**
 * Columns for `n` statements on one presentation slide, so they all fit. Each statement is a
 * wide seven-column chart, so fewer columns than usual: two up to eight statements (five
 * statements make three rows, not two cramped rows of three).
 */
export function columnsFor(n: number): number {
  return n <= 1 ? 1 : n <= 8 ? 2 : n <= 15 ? 3 : 4;
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
    if (!statementsOf(state).some((s) => s.id === id)) return { ok: false, reason: 'Unknown statement' };
    if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, reason: 'Pick a level on the slider' };
    if (value < 0 || value > MAX) return { ok: false, reason: 'That level is off the scale' };
    return { ok: true };
  },

  onAction(state, player, payload) {
    const { id, value } = (payload as Record<string, Answer>)[ACTION]!;
    const level = Math.round(value);
    if (state.answers[id]?.[player.id] === level) return state;
    return {
      ...state,
      answers: { ...state.answers, [id]: { ...state.answers[id], [player.id]: level } },
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
    return ui.stack([ui.text(`${plural(n, 'statement')} to agree or disagree with.`), ui.caption(INSTRUCTIONS)], { gap: 'sm' });
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
              ui.subtitle(s.text, { align: 'center' }),
              ui.liveAnswer(ACTION, s.id, state.answers[s.id]?.[player.id] ?? null, {
                min: 0,
                max: MAX,
                step: 1,
                stepLabels: LEVELS,
                start: NEUTRAL,
                marks: [
                  { value: 0, label: LEVELS[0]! },
                  { value: NEUTRAL, label: LEVELS[NEUTRAL]! },
                  { value: MAX, label: LEVELS[MAX]! },
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
    return ui.caption(`${plural(state.config.statements.length, 'hot take')} to agree or disagree with: where does the room stand?`);
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
