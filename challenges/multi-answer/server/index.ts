/**
 * Multiple Answers (contract v2).
 *
 * One question, several answer boxes. Points are split into an equal whole-number share
 * per answer, floor(points / answers); the remainder is a bonus only for a fully correct
 * set, so a full set always scores exactly `points` (10 points, 3 answers: 3 + 3 + 3,
 * and 10 when all three are right).
 *
 * Answers are compared leniently: case, accents, punctuation and extra spaces are ignored,
 * numbers compare by value, and hosts can list alternative spellings. With `anyOrder` the
 * boxes are interchangeable (e.g. "name the three primary colours").
 */
import { defineModule, ui, type Manifest, type PlayerRef, type UINode } from '@challenge/contract';
import manifestJson from '../manifest.json' with { type: 'json' };
import schemaJson from '../config.schema.json' with { type: 'json' };

interface AnswerSpec {
  label?: string;
  answer: string;
  alternatives?: string;
}

interface Config {
  question: string;
  answers: AnswerSpec[];
  anyOrder: boolean;
  timeLimit: number;
  points: number;
}

interface State {
  config: Config;
}

/** Field `a<i>` holds the player's answer for box i. */
type Input = Record<string, string>;

/** One evaluation per submission (results: immediate). */
interface Evaluation {
  playerId: string;
  displayName: string;
  given: string[];
  /** Per answer box: was it right? */
  correct: boolean[];
  correctCount: number;
  allCorrect: boolean;
  points: number;
}

const MAX_ANSWER_LENGTH = 100;
const field = (i: number) => `a${i}`;

/** Case, accents, punctuation and spacing do not matter. */
export function normalise(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.,-]+/gu, ' ')
    // Keep "3.5", "1,5" and "-2"; drop the dots in "St. Louis" / "D.C." and the hyphen in "Jean-Paul".
    .replace(/(?<!\d)[.,]|[.,](?!\d)/g, '')
    .replace(/(?<=\S)-|-(?!\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NUMBER = /^-?\d+([.,]\d+)?$/;

function accepted(spec: AnswerSpec): string[] {
  return [spec.answer, ...(spec.alternatives ?? '').split(',')].map(normalise).filter(Boolean);
}

/** Does `given` match this answer (or one of its alternatives)? Numbers compare by value. */
export function matches(spec: AnswerSpec, given: string): boolean {
  const g = normalise(given);
  if (!g) return false;
  return accepted(spec).some((a) => {
    if (a === g) return true;
    if (NUMBER.test(a) && NUMBER.test(g)) return Number(a.replace(',', '.')) === Number(g.replace(',', '.'));
    return false;
  });
}

/** Per-box correctness. With `anyOrder` each correct answer can only be used once. */
export function check(config: Config, given: string[]): boolean[] {
  if (!config.anyOrder) return config.answers.map((spec, i) => matches(spec, given[i] ?? ''));
  const used = new Set<number>();
  return config.answers.map((_, i) => {
    const idx = config.answers.findIndex((spec, j) => !used.has(j) && matches(spec, given[i] ?? ''));
    if (idx < 0) return false;
    used.add(idx);
    return true;
  });
}

/** floor(points / answers) per correct answer, plus the remainder for a complete set. */
export function scoreFor(points: number, answers: number, correctCount: number): number {
  const share = Math.floor(points / answers);
  return correctCount === answers ? points : correctCount * share;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function nameOf(players: PlayerRef[], id: string): string {
  return players.find((p) => p.id === id)?.displayName ?? 'Unknown';
}

function labelOf(config: Config, i: number): string {
  return (!config.anyOrder && config.answers[i]?.label) || `Answer ${i + 1}`;
}

export default defineModule<Config, State, Input, Evaluation>({
  manifest: manifestJson as unknown as Manifest,
  configurationSchema: schemaJson,

  createInstance(config) {
    return { config };
  },

  onAttemptStart(state, player, ctx) {
    ctx.schedule('lock', state.config.timeLimit, player.id);
    return state;
  },

  validateInput(state, _player, input) {
    if (!input || typeof input !== 'object') return { ok: false, reason: 'Fill in your answers' };
    const values = state.config.answers.map((_, i) => (input as Record<string, unknown>)[field(i)]);
    if (values.some((v) => v !== undefined && v !== null && typeof v !== 'string')) return { ok: false, reason: 'Answers must be text' };
    if (values.some((v) => typeof v === 'string' && v.length > MAX_ANSWER_LENGTH)) return { ok: false, reason: 'One of your answers is too long' };
    if (values.every((v) => typeof v !== 'string' || !v.trim())) return { ok: false, reason: 'Fill in at least one answer' };
    return { ok: true };
  },

  handleInput(state) {
    return state;
  },

  evaluate(state, submissions, ctx) {
    // Immediate results: exactly one submission.
    const s = submissions[0]!;
    const c = state.config;
    const given = c.answers.map((_, i) => String(s.payload[field(i)] ?? '').trim());
    const correct = check(c, given);
    const correctCount = correct.filter(Boolean).length;
    return {
      playerId: s.playerId,
      displayName: nameOf(ctx.players(), s.playerId),
      given,
      correct,
      correctCount,
      allCorrect: correctCount === c.answers.length,
      points: scoreFor(c.points, c.answers.length, correctCount),
    };
  },

  calculateScores(state, evaluation) {
    const n = state.config.answers.length;
    return [{ playerId: evaluation.playerId, points: evaluation.points, reason: evaluation.allCorrect ? `All ${n} correct` : `${evaluation.correctCount} of ${n} correct` }];
  },

  getStatistics(state, evaluations) {
    const n = state.config.answers.length;
    const total = evaluations.length;
    return {
      question: state.config.question,
      submissions: total,
      allCorrect: evaluations.filter((e) => e.allCorrect).length,
      averageCorrect: total ? Math.round((evaluations.reduce((a, e) => a + e.correctCount, 0) / total) * 100) / 100 : null,
      perAnswer: state.config.answers.map((spec, i) => ({
        answer: spec.answer,
        // In any order a box index is not an answer, so count players who named this answer.
        correct: evaluations.filter((e) => (state.config.anyOrder ? e.given.some((g) => matches(spec, g)) : e.correct[i])).length,
      })),
      answers: n,
    };
  },

  guestView(state) {
    const c = state.config;
    const share = Math.floor(c.points / c.answers.length);
    const children: UINode[] = [ui.subtitle(c.question), ui.timer('lock')];
    c.answers.forEach((_, i) => children.push(ui.textInput(field(i), { label: labelOf(c, i), maxLength: MAX_ANSWER_LENGTH })));
    children.push(ui.submit('Lock in my answers', { size: 'lg' }));
    return {
      ui: ui.stack(children, { gap: 'md' }),
      canSubmit: true,
      status: `${share > 0 ? `${share} per correct answer · ` : ''}${c.points} for all ${c.answers.length}${c.anyOrder ? ' · any order' : ''}`,
    };
  },

  resultsView(state, evaluations) {
    const c = state.config;
    const total = evaluations.length;
    const perfect = evaluations.filter((e) => e.allCorrect).length;
    const answerList = ui.list(
      c.answers.map((spec, i) => {
        const right = evaluations.filter((e) => (c.anyOrder ? e.given.some((g) => matches(spec, g)) : e.correct[i])).length;
        return { label: c.anyOrder ? spec.answer : `${labelOf(c, i)}: ${spec.answer}`, value: `${right}/${total}`, tone: 'success' as const };
      }),
    );
    const summary = ui.badge(total ? `${plural(perfect, 'player')} got all ${c.answers.length}` : 'No answers yet', perfect > 0 ? 'success' : 'muted');
    const shared = ui.stack([ui.caption(c.question, { align: 'center' }), answerList, ui.row([summary], { justify: 'center' })], { gap: 'md', align: 'stretch' });
    return {
      ui: shared,
      guestUi: (player) => {
        const me = evaluations.find((e) => e.playerId === player.id);
        if (!me) return ui.stack([ui.caption(c.question), ui.badge('You did not answer', 'muted'), answerList], { gap: 'md' });
        const rows = ui.list(
          c.answers.map((spec, i) => ({
            label: `${labelOf(c, i)}: ${me.given[i] || '—'}`,
            value: me.correct[i] ? '✓' : c.anyOrder ? '✕' : `✕ ${spec.answer}`,
            tone: me.correct[i] ? ('success' as const) : ('danger' as const),
          })),
        );
        const head = ui.title(me.allCorrect ? 'All correct!' : `${me.correctCount} of ${c.answers.length} correct`, { tone: me.allCorrect ? 'success' : me.correctCount ? 'neutral' : 'danger' });
        return ui.stack(
          [ui.caption(c.question), ui.card([head, ui.text(plural(me.points, 'point'), { tone: 'muted' })], me.allCorrect ? 'success' : 'neutral'), rows, ...(c.anyOrder ? [ui.caption('Answers'), answerList] : [])],
          { gap: 'md' },
        );
      },
    };
  },
});
