/**
 * Image Memory (contract v2).
 *
 * Each player starts whenever they like: the image is shown on their own device for
 * `viewSeconds` (per-player `hide` timer), then hidden and replaced by a multiple-choice
 * question with its own `answerSeconds` time limit (per-player `lock` timer).
 */
import { defineModule, ui, type ChoiceOption, type Manifest, type PlayerRef, type UINode } from '@challenge/contract';
import manifestJson from '../manifest.json' with { type: 'json' };
import schemaJson from '../config.schema.json' with { type: 'json' };

interface Config {
  image: string;
  viewSeconds: number;
  question: string;
  options: string[];
  correctIndex: number;
  answerSeconds: number;
  points: number;
}

type Stage = 'view' | 'answer';

interface State {
  config: Config;
  /** playerId → view (image shown) | answer (image hidden, question shown). Absent before Start. */
  stage: Record<string, Stage>;
  /** playerId → chosen letter (for the player's own feedback). */
  answers: Record<string, string>;
}

interface Input {
  answer: string;
}

/** One evaluation per submission (results: immediate). */
interface Evaluation {
  playerId: string;
  displayName: string;
  answer: string;
  correct: boolean;
}

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

function letterAt(i: number): string {
  return LETTERS[i] ?? String(i + 1);
}

function correctIndexOf(config: Config): number {
  return Math.min(Math.max(0, Math.floor(config.correctIndex)), config.options.length - 1);
}

function correctLetterOf(config: Config): string {
  return letterAt(correctIndexOf(config));
}

function letteredOptions(config: Config): ChoiceOption[] {
  return config.options.map((label, i) => ({ id: letterAt(i), label: `${letterAt(i)}. ${label}` }));
}

function nameOf(players: PlayerRef[], id: string): string {
  return players.find((p) => p.id === id)?.displayName ?? 'Unknown';
}

function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

function countsOf(config: Config, evaluations: Evaluation[]): Record<string, number> {
  const counts: Record<string, number> = {};
  config.options.forEach((_, i) => {
    counts[letterAt(i)] = 0;
  });
  for (const e of evaluations) counts[e.answer] = (counts[e.answer] ?? 0) + 1;
  return counts;
}

export default defineModule<Config, State, Input, Evaluation>({
  manifest: manifestJson as unknown as Manifest,
  configurationSchema: schemaJson,

  createInstance(config) {
    return { config, stage: {}, answers: {} };
  },

  onAttemptStart(state, player, ctx) {
    // Show the image first; the question (and this player's lock timer) follow once it is hidden.
    ctx.schedule('hide', state.config.viewSeconds, player.id);
    return { ...state, stage: { ...state.stage, [player.id]: 'view' } };
  },

  onTimer(state, tag, ctx, playerId) {
    if (tag === 'hide' && playerId && state.stage[playerId] === 'view') {
      ctx.schedule('lock', state.config.answerSeconds, playerId);
      return { ...state, stage: { ...state.stage, [playerId]: 'answer' } };
    }
    return state;
  },

  validateInput(state, player, input) {
    const stage = state.stage[player.id];
    if (stage === 'view') return { ok: false, reason: 'Keep looking!' };
    if (stage !== 'answer') return { ok: false, reason: 'Answers are closed' };
    if (state.answers[player.id] !== undefined) return { ok: false, reason: 'You already answered' };
    if (!input || typeof input !== 'object') return { ok: false, reason: 'Pick an option' };
    const answer = String((input as Input).answer ?? '').toUpperCase();
    const valid = state.config.options.map((_, i) => letterAt(i));
    if (!valid.includes(answer)) return { ok: false, reason: 'Pick one of the options' };
    return { ok: true };
  },

  handleInput(state, player, input) {
    return { ...state, answers: { ...state.answers, [player.id]: String(input.answer).toUpperCase() } };
  },

  evaluate(state, submissions, ctx) {
    // Immediate results: exactly one submission (the locked attempt's latest).
    const s = submissions[0]!;
    const answer = String(s.payload.answer ?? '').toUpperCase();
    return { playerId: s.playerId, displayName: nameOf(ctx.players(), s.playerId), answer, correct: answer === correctLetterOf(state.config) };
  },

  calculateScores(state, evaluation) {
    return [
      {
        playerId: evaluation.playerId,
        points: evaluation.correct ? state.config.points : 0,
        reason: evaluation.correct ? 'Correct' : `Wrong (${evaluation.answer})`,
      },
    ];
  },

  getStatistics(state, evaluations) {
    const c = state.config;
    const counts = countsOf(c, evaluations);
    const correctCount = evaluations.filter((e) => e.correct).length;
    return {
      question: c.question,
      correctAnswer: `${correctLetterOf(c)}. ${c.options[correctIndexOf(c)] ?? ''}`,
      answers: evaluations.length,
      correctCount,
      correctPercent: pct(correctCount, evaluations.length),
      perOption: c.options.map((label, i) => ({
        letter: letterAt(i),
        label,
        count: counts[letterAt(i)] ?? 0,
        percent: pct(counts[letterAt(i)] ?? 0, evaluations.length),
      })),
    };
  },

  introView(state) {
    const c = state.config;
    return ui.stack(
      [
        ui.text(`Memorise the image! You get ${c.viewSeconds} seconds to look, then it disappears and a question about it follows.`),
        ui.caption(`${c.answerSeconds} seconds to answer. A correct answer scores ${c.points} points.`),
      ],
      { gap: 'sm' },
    );
  },

  guestView(state, player, ctx) {
    const c = state.config;
    const stage = state.stage[player.id];
    const mine = state.answers[player.id];
    if (stage === 'view') {
      return {
        ui: ui.stack([ui.image(ctx.mediaUrl(c.image), { maxHeight: '45vh', alt: 'Memorise this image' }), ui.timer('hide', { label: 'Memorise' })], {
          gap: 'md',
          align: 'center',
        }),
        canSubmit: false,
        status: 'Keep looking!',
      };
    }
    const options = letteredOptions(c);
    if (mine !== undefined) {
      const picked = options.find((o) => o.id === mine);
      return {
        ui: ui.stack([ui.subtitle(c.question), ui.badge(`Your answer: ${picked?.label ?? mine}`, 'primary')], { gap: 'md' }),
        canSubmit: false,
        status: 'Answer locked in',
      };
    }
    return {
      ui: ui.stack(
        [
          ui.image(ctx.mediaUrl(c.image), { maxHeight: '20vh', hidden: true, alt: 'Hidden image' }),
          ui.subtitle(c.question),
          ui.timer('lock'),
          ui.choices('answer', options, { submitOnSelect: true, columns: 1 }),
        ],
        { gap: 'md' },
      ),
      canSubmit: true,
      status: 'Tap an option to answer',
    };
  },

  mainView(state) {
    // Public card: never the image or the question, so nobody can prepare before Start.
    const c = state.config;
    return ui.caption(`Memorise an image for ${c.viewSeconds} seconds, then answer a question about it.`);
  },

  resultsView(state, evaluations, ctx) {
    const c = state.config;
    const options = letteredOptions(c);
    const correctLetter = correctLetterOf(c);
    const counts = countsOf(c, evaluations);
    const bars = options.map((o) => ({
      label: o.label,
      value: counts[o.id] ?? 0,
      highlight: o.id === correctLetter,
      tone: o.id === correctLetter ? ('success' as const) : undefined,
    }));
    const winners = evaluations.filter((e) => e.correct);
    const correctText = `${correctLetter}. ${c.options[correctIndexOf(c)] ?? ''}`;
    const shared = ui.stack(
      [
        ui.image(ctx.mediaUrl(c.image), { maxHeight: '35vh', alt: 'The image' }),
        ui.caption(c.question, { align: 'center' }),
        ui.display(correctText, { tone: 'success' }),
        ui.barChart(bars, { percent: true }),
        winners.length
          ? ui.text(`Got it right: ${winners.map((w) => w.displayName).join(', ')}`, { align: 'center' })
          : ui.text(evaluations.length ? 'Nobody got it right so far!' : 'No answers yet', { tone: 'muted', align: 'center' }),
        ui.badge(`${winners.length} of ${evaluations.length} correct`, winners.length > 0 ? 'success' : 'muted'),
      ],
      { gap: 'md', align: 'center' },
    );
    return {
      ui: shared,
      guestUi: (player) => {
        const me = evaluations.find((e) => e.playerId === player.id);
        const mineLabel = me ? (options.find((o) => o.id === me.answer)?.label ?? me.answer) : null;
        const mine: UINode = !me
          ? ui.badge('You did not answer', 'muted')
          : ui.card(
              [
                ui.title(me.correct ? 'Correct!' : 'Wrong', { tone: me.correct ? 'success' : 'danger' }),
                ui.text(`You picked ${mineLabel}`),
                ui.text(`${me.correct ? c.points : 0} points`, { tone: 'muted' }),
              ],
              me.correct ? 'success' : 'danger',
            );
        return ui.stack(
          [
            ui.image(ctx.mediaUrl(c.image), { maxHeight: '25vh', alt: 'The image' }),
            ui.caption(c.question),
            ui.display(correctText, { tone: 'success' }),
            mine,
            ui.barChart(bars, { percent: true }),
          ],
          { gap: 'md' },
        );
      },
    };
  },
});
