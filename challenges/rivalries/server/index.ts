/**
 * Rivalries (contract v2), a Hot Takes challenge.
 *
 * Two opposite or competing things on each end of a slider, e.g. "Star Wars vs Star Trek".
 * Players pick a side and how strongly (-3..3), or sit exactly in the middle, which can carry
 * its own meaning ("Star Wars and Star Trek are basically the same"). Every statement is in one
 * list; every change is a live action (`ui.liveAnswer`), so players answer as many as they like
 * and change their minds until the host closes the challenge.
 *
 * The big screen's spotlight shows each rivalry with how the room split (`spotlight`);
 * `activity` counts new and changed answers so busy rivalries come first.
 * Optional participation points are awarded when the challenge closes.
 */
import { defineModule, ui, type Manifest, type PlayerRef, type SpotlightItem, type Tone, type UINode } from '@challenge/contract';
import manifestJson from '../manifest.json' with { type: 'json' };
import schemaJson from '../config.schema.json' with { type: 'json' };

interface Statement {
  left: string;
  right: string;
  middle?: string;
}

interface Config {
  statements: Statement[];
  pointsPerAnswer?: number;
}

interface State {
  config: Config;
  /** statement id → playerId → answer (-3 = all the way left, 0 = middle, 3 = all the way right). */
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
/** The slider runs from -SIDE (left) to SIDE (right): seven positions. */
const SIDE = 3;
const NO_MIDDLE = 'Right in the middle';

interface Rivalry {
  id: string;
  left: string;
  right: string;
  /** What the middle means, '' when the host left it out. */
  middle: string;
  /** One label per position, left to right. */
  stepLabels: string[];
}

const idOf = (index: number) => `s${index}`;

function rivalriesOf(state: State): Rivalry[] {
  return state.config.statements.map((s, i) => {
    const left = s.left.trim();
    const right = s.right.trim();
    const middle = (s.middle ?? '').trim();
    return {
      id: idOf(i),
      left,
      right,
      middle,
      stepLabels: [`Definitely ${left}`, left, `Leaning ${left}`, middle || NO_MIDDLE, `Leaning ${right}`, right, `Definitely ${right}`],
    };
  });
}

/** The nearest position on the slider. */
function snap(value: number): number {
  return Math.min(SIDE, Math.max(-SIDE, Math.round(value))) || 0; // `|| 0` turns -0 into 0
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function rivalries(n: number): string {
  return `${n} ${n === 1 ? 'rivalry' : 'rivalries'}`;
}

function percent(part: number, whole: number): number {
  return Math.round((part / whole) * 100);
}

function answeredBy(state: State, playerId: string): number {
  return rivalriesOf(state).filter((r) => state.answers[r.id]?.[playerId] !== undefined).length;
}

/** Left columns in one colour, the middle neutral, right columns in another. */
function toneOf(index: number): Tone {
  return index < SIDE ? 'primary' : index === SIDE ? 'neutral' : 'warning';
}

/** One rivalry and how everyone answered it (big screen, results). */
function rivalryView(state: State, r: Rivalry, mine?: number): UINode {
  const values = Object.values(state.answers[r.id] ?? {});
  const columns = r.stepLabels.map((label, i) => ({ label, count: 0, tone: toneOf(i) }));
  for (const v of values) columns[snap(v) + SIDE]!.count++;
  const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const n = values.length;
  const summary = n
    ? `${plural(n, 'answer')} · ${percent(values.filter((v) => v < 0).length, n)}% ${r.left} · ${percent(values.filter((v) => v === 0).length, n)}% middle · ${percent(values.filter((v) => v > 0).length, n)}% ${r.right}`
    : 'No answers yet: be the first!';
  return ui.stack(
    [
      ui.title(`${r.left} vs ${r.right}`, { align: 'center' }),
      ui.distribution(columns, {
        axis: { start: r.left, middle: r.middle || 'Equal', end: r.right },
        marker: avg === null ? undefined : { at: (avg + SIDE) / (2 * SIDE), label: `avg: ${r.stepLabels[snap(avg) + SIDE]}` },
        highlight: mine === undefined ? undefined : snap(mine) + SIDE,
      }),
      ui.caption(mine === undefined ? summary : `You: ${r.stepLabels[snap(mine) + SIDE]} · ${summary}`, { align: 'center' }),
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
    if (!rivalriesOf(state).some((r) => r.id === id)) return { ok: false, reason: 'Unknown rivalry' };
    if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, reason: 'Pick a side on the slider' };
    if (value < -SIDE || value > SIDE) return { ok: false, reason: 'That value is off the scale' };
    return { ok: true };
  },

  onAction(state, player, payload) {
    const { id, value } = (payload as Record<string, Answer>)[ACTION]!;
    const snapped = snap(value);
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
    return Object.entries(evaluation.answered).map(([playerId, n]) => ({ playerId, points: n * each, reason: `Answered ${rivalries(n)}` }));
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
    return ui.stack([ui.text(`${rivalries(n)} to settle: pick a side, or sit right in the middle.`), ui.caption(INSTRUCTIONS)], { gap: 'sm' });
  },

  guestView(state, player) {
    const all = rivalriesOf(state);
    const answered = answeredBy(state, player.id);
    return {
      ui: ui.stack(
        [
          ui.caption(INSTRUCTIONS),
          ...all.map((r) =>
            ui.card([
              ui.text(`${r.left} vs ${r.right}`),
              ...(r.middle ? [ui.caption(`Middle = ${r.middle}`)] : []),
              ui.liveAnswer(ACTION, r.id, state.answers[r.id]?.[player.id] ?? null, {
                min: -SIDE,
                max: SIDE,
                step: 1,
                start: 0,
                stepLabels: r.stepLabels,
                marks: [
                  { value: -SIDE, label: r.left },
                  { value: 0, label: 'Middle' },
                  { value: SIDE, label: r.right },
                ],
              }),
            ]),
          ),
        ],
        { gap: 'md', align: 'stretch' },
      ),
      canSubmit: false,
      status: `${answered} of ${all.length} answered · change them any time`,
    };
  },

  mainView(state) {
    return ui.caption(`${rivalries(state.config.statements.length)}: which side is the room on?`);
  },

  spotlight(state): SpotlightItem[] {
    return rivalriesOf(state).map((r) => ({ id: r.id, label: `${r.left} vs ${r.right}`, activity: state.activity[r.id] ?? 0, ui: rivalryView(state, r) }));
  },

  resultsView(state) {
    const all = rivalriesOf(state);
    return {
      ui: ui.stack(all.map((r) => rivalryView(state, r)), { gap: 'lg', align: 'stretch' }),
      guestUi: (player: PlayerRef) => ui.stack(all.map((r) => rivalryView(state, r, state.answers[r.id]?.[player.id])), { gap: 'lg', align: 'stretch' }),
    };
  },
});
