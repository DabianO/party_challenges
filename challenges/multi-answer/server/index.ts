/**
 * Answer (contract v2; module id `multi-answer`, once "Multiple Answers").
 *
 * One question with one answer box, or several. Points are split into an equal whole-number
 * share per answer, floor(points / answers); the remainder is a bonus only for a fully
 * correct set, so a full set always scores exactly `points` (10 points, 3 answers: 3 + 3 + 3,
 * and 10 when all three are right). A single answer simply scores `points`.
 *
 * Answers are compared leniently: case, accents, punctuation and extra spaces are ignored,
 * and hosts can list alternative spellings. Numbers compare by value, within the answer's
 * tolerance, and get a number box with the answer's unit (this covers Numeric Answer). With
 * `anyOrder` the boxes are interchangeable (e.g. "name the three primary colours").
 */
import { defineModule, ui, type Manifest, type PlayerRef, type UINode } from '@challenge/contract';
import manifestJson from '../manifest.json' with { type: 'json' };
import schemaJson from '../config.schema.json' with { type: 'json' };

interface AnswerSpec {
  label?: string;
  answer: string;
  alternatives?: string;
  /** Numbers within plus/minus this much count as right. */
  tolerance?: number;
  unit?: string;
}

interface Config {
  question: string;
  answers: AnswerSpec[];
  anyOrder: boolean;
  timeLimit: number;
  points: number;
  media?: string;
}

interface State {
  config: Config;
}

/** Field `a<i>` holds the player's answer for box i (text, or a number from a number box). */
type Input = Record<string, string | number>;

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
const toNumber = (s: string) => Number(s.replace(',', '.'));

function isNumber(s: string): boolean {
  return NUMBER.test(normalise(s));
}

function accepted(spec: AnswerSpec): string[] {
  return [spec.answer, ...(spec.alternatives ?? '').split(',')].map(normalise).filter(Boolean);
}

/** Does `given` match this answer (or one of its alternatives)? Numbers compare by value, within the tolerance. */
export function matches(spec: AnswerSpec, given: string): boolean {
  const g = normalise(given);
  if (!g) return false;
  const tolerance = Math.max(0, spec.tolerance ?? 0);
  return accepted(spec).some((a) => {
    if (a === g) return true;
    // A small epsilon guards against floating point noise on the tolerance boundary.
    if (NUMBER.test(a) && NUMBER.test(g)) return Math.abs(toNumber(a) - toNumber(g)) <= tolerance + 1e-9;
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

/** Box i takes a number when its answer is one (in any order: when every answer is one). */
export function numericBox(config: Config, i: number): boolean {
  return config.anyOrder ? config.answers.every((a) => isNumber(a.answer)) : isNumber(config.answers[i]?.answer ?? '');
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function nameOf(players: PlayerRef[], id: string): string {
  return players.find((p) => p.id === id)?.displayName ?? 'Unknown';
}

const single = (config: Config) => config.answers.length === 1;

function labelOf(config: Config, i: number): string {
  return (!config.anyOrder && config.answers[i]?.label) || (single(config) ? 'Your answer' : `Answer ${i + 1}`);
}

function withUnit(text: string, unit?: string): string {
  return unit ? `${text} ${unit}` : text;
}

/** The right answer as players see it in the results, e.g. "88 keys (± 2)". */
export function answerText(spec: AnswerSpec): string {
  const tolerance = spec.tolerance ?? 0;
  return `${withUnit(spec.answer, spec.unit)}${tolerance > 0 && isNumber(spec.answer) ? ` (± ${withUnit(String(tolerance), spec.unit)})` : ''}`;
}

export default defineModule<Config, State, Input, Evaluation>({
  manifest: manifestJson as unknown as Manifest,
  configurationSchema: schemaJson,

  createInstance(config) {
    return { config };
  },

  onAttemptStart(state, player, ctx) {
    if (state.config.timeLimit > 0) ctx.schedule('lock', state.config.timeLimit, player.id); // 0 = no time limit
    return state;
  },

  validateInput(state, _player, input) {
    const several = !single(state.config);
    if (!input || typeof input !== 'object') return { ok: false, reason: several ? 'Fill in your answers' : 'Fill in your answer' };
    const values = state.config.answers.map((_, i) => (input as Record<string, unknown>)[field(i)]);
    if (values.some((v) => v !== undefined && v !== null && typeof v !== 'string' && !(typeof v === 'number' && Number.isFinite(v)))) {
      return { ok: false, reason: 'Answers must be text or numbers' };
    }
    if (values.some((v) => typeof v === 'string' && v.length > MAX_ANSWER_LENGTH)) return { ok: false, reason: several ? 'One of your answers is too long' : 'Your answer is too long' };
    if (values.every((v) => typeof v !== 'number' && (typeof v !== 'string' || !v.trim()))) {
      return { ok: false, reason: several ? 'Fill in at least one answer' : 'Fill in your answer' };
    }
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
    const reason = n === 1 ? (evaluation.allCorrect ? 'Correct' : 'Wrong') : evaluation.allCorrect ? `All ${n} correct` : `${evaluation.correctCount} of ${n} correct`;
    return [{ playerId: evaluation.playerId, points: evaluation.points, reason }];
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

  guestView(state, _player, ctx) {
    const c = state.config;
    const share = Math.floor(c.points / c.answers.length);
    const children: UINode[] = [ui.subtitle(c.question)];
    if (c.media) children.push(ui.image(ctx.mediaUrl(c.media), { maxHeight: '30vh' }));
    children.push(ui.timer('lock'));
    c.answers.forEach((spec, i) => {
      // In any order the boxes are interchangeable, so only a unit every answer shares is shown.
      const unit = c.anyOrder ? (c.answers.every((a) => a.unit === c.answers[0]?.unit) ? c.answers[0]?.unit : undefined) : spec.unit;
      children.push(
        numericBox(c, i)
          ? ui.numberInput(field(i), { label: labelOf(c, i), unit: unit || undefined, placeholder: '0' })
          : ui.textInput(field(i), { label: unit ? `${labelOf(c, i)} (${unit})` : labelOf(c, i), maxLength: MAX_ANSWER_LENGTH }),
      );
    });
    children.push(ui.submit(single(c) ? 'Lock in my answer' : 'Lock in my answers', { size: 'lg' }));
    return {
      ui: ui.stack(children, { gap: 'md' }),
      canSubmit: true,
      status: single(c) ? plural(c.points, 'point') : `${share > 0 ? `${share} per correct answer · ` : ''}${c.points} for all ${c.answers.length}${c.anyOrder ? ' · any order' : ''}`,
    };
  },

  resultsView(state, evaluations) {
    const c = state.config;
    const total = evaluations.length;
    const perfect = evaluations.filter((e) => e.allCorrect).length;

    if (single(c)) {
      const spec = c.answers[0]!;
      const right = ui.display(answerText(spec), { tone: 'success' });
      const summary = ui.badge(total ? `${perfect} of ${total} right` : 'No answers yet', perfect > 0 ? 'success' : 'muted');
      return {
        ui: ui.stack([ui.caption(c.question, { align: 'center' }), right, ui.row([summary], { justify: 'center' })], { gap: 'md', align: 'stretch' }),
        guestUi: (player) => {
          const me = evaluations.find((e) => e.playerId === player.id);
          const mine: UINode = !me
            ? ui.badge('You did not answer', 'muted')
            : ui.card(
                [
                  ui.title(me.allCorrect ? 'Correct!' : 'Not quite', { tone: me.allCorrect ? 'success' : 'danger' }),
                  ui.text(`You answered ${me.given[0] ? withUnit(me.given[0], spec.unit) : '—'}`),
                  ui.text(plural(me.points, 'point'), { tone: 'muted' }),
                ],
                me.allCorrect ? 'success' : 'danger',
              );
          return ui.stack([ui.caption(c.question), right, mine], { gap: 'md' });
        },
      };
    }

    const answerList = ui.list(
      c.answers.map((spec, i) => {
        const right = evaluations.filter((e) => (c.anyOrder ? e.given.some((g) => matches(spec, g)) : e.correct[i])).length;
        return { label: c.anyOrder ? answerText(spec) : `${labelOf(c, i)}: ${answerText(spec)}`, value: `${right}/${total}`, tone: 'success' as const };
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
            value: me.correct[i] ? '✓' : c.anyOrder ? '✕' : `✕ ${answerText(spec)}`,
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
