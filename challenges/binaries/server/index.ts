/**
 * Binaries (contract v2), a Hot Takes challenge.
 *
 * Yes/no statements, e.g. "Taylor Swift is overrated". Players see every statement in a list,
 * tap Yes or No on as many as they like and change their minds whenever they want: every
 * change is a live action (`ui.liveAnswer` with two option buttons), so the attempt stays open
 * until the host closes the challenge.
 *
 * The big screen's spotlight shows each statement with a Yes/No bar chart (`spotlight`);
 * `activity` counts new and changed answers so busy statements come first.
 * Optional participation points are awarded when the challenge closes.
 */
import { defineModule, ui, type Manifest, type PlayerRef, type PresentationSlide, type SpotlightItem, type UINode } from '@challenge/contract';
import manifestJson from '../manifest.json' with { type: 'json' };
import schemaJson from '../config.schema.json' with { type: 'json' };

interface Statement {
  text: string;
}

interface Config {
  statements: Statement[];
  pointsPerAnswer?: number;
}

/** 1 = yes, 0 = no. */
type Vote = 0 | 1;

interface State {
  config: Config;
  /** statement id → playerId → answer. */
  answers: Record<string, Record<string, Vote>>;
  /** statement id → number of new or changed answers so far. */
  activity: Record<string, number>;
}

/** Live action payload: `{ answer: { id, value } }`. */
interface Answer {
  id: string;
  value: Vote;
}

/** Aggregate evaluation (results: onClose): how many statements each player answered. */
interface Evaluation {
  answered: Record<string, number>;
}

const ACTION = 'answer';
const YES = 1;
const NO = 0;
const OPTIONS = [
  { value: YES, label: 'Yes', tone: 'success' as const },
  { value: NO, label: 'No', tone: 'danger' as const },
];

const idOf = (index: number) => `s${index}`;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function statementsOf(state: State): { id: string; text: string }[] {
  return state.config.statements.map((s, i) => ({ id: idOf(i), text: s.text }));
}

function answeredBy(state: State, playerId: string): number {
  return statementsOf(state).filter((s) => state.answers[s.id]?.[playerId] !== undefined).length;
}

/** One statement and how everyone answered it (big screen, results). */
function statementView(state: State, s: { id: string; text: string }, mine?: Vote): UINode {
  const values = Object.values(state.answers[s.id] ?? {});
  const yes = values.filter((v) => v === YES).length;
  const no = values.length - yes;
  const summary = values.length ? `${plural(values.length, 'answer')} · ${Math.round((yes / values.length) * 100)}% yes` : 'No answers yet: be the first!';
  return ui.stack(
    [
      ui.title(s.text, { align: 'center' }),
      ui.barChart(
        [
          { label: `Yes · ${yes}`, value: yes, tone: 'success' },
          { label: `No · ${no}`, value: no, tone: 'danger' },
        ],
        { percent: true },
      ),
      ui.caption(mine === undefined ? summary : `You: ${mine === YES ? 'Yes' : 'No'} · ${summary}`, { align: 'center' }),
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
  validateInput() {
    return { ok: false, reason: 'Tap Yes or No to answer' };
  },

  handleInput(state) {
    return state;
  },

  validateAction(state, _player, payload) {
    const answer = payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[ACTION] : undefined;
    if (!answer || typeof answer !== 'object') return { ok: false, reason: 'Unknown action' };
    const { id, value } = answer as Partial<Answer>;
    if (!statementsOf(state).some((s) => s.id === id)) return { ok: false, reason: 'Unknown statement' };
    if (value !== YES && value !== NO) return { ok: false, reason: 'Answer Yes or No' };
    return { ok: true };
  },

  onAction(state, player, payload) {
    const { id, value } = (payload as Record<string, Answer>)[ACTION]!;
    if (state.answers[id]?.[player.id] === value) return state;
    return {
      ...state,
      answers: { ...state.answers, [id]: { ...state.answers[id], [player.id]: value } },
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
    return ui.stack([ui.text(`${plural(n, 'statement')} to answer with Yes or No.`), ui.caption(INSTRUCTIONS)], { gap: 'sm' });
  },

  guestView(state, player) {
    const statements = statementsOf(state);
    const answered = answeredBy(state, player.id);
    return {
      ui: ui.stack(
        [
          ui.caption(INSTRUCTIONS),
          ...statements.map((s) =>
            ui.card([ui.text(s.text), ui.liveAnswer(ACTION, s.id, state.answers[s.id]?.[player.id] ?? null, { min: NO, max: YES, options: OPTIONS })]),
          ),
        ],
        { gap: 'md', align: 'stretch' },
      ),
      canSubmit: false,
      status: `${answered} of ${statements.length} answered · change them any time`,
    };
  },

  mainView(state) {
    return ui.caption(`${plural(state.config.statements.length, 'hot take')}, yes or no: what does the room think?`);
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
