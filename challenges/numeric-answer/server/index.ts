/**
 * Numeric Answer (contract v2).
 *
 * Each player starts whenever they like, gets their own time limit and types a number.
 * They may change it until their timer fires or they press Finish (`resubmission:
 * replace`); the latest submission is evaluated on its own when the attempt locks. An
 * answer is correct when within an absolute tolerance of the configured value.
 */
import { defineModule, ui, type Manifest, type PlayerRef, type PresentationSlide, type Tone, type UINode } from '@challenge/contract';
import manifestJson from '../manifest.json' with { type: 'json' };
import schemaJson from '../config.schema.json' with { type: 'json' };

interface Config {
  question: string;
  correctAnswer: number;
  tolerance: number;
  unit?: string;
  timeLimit: number;
  points: number;
  media?: string;
}

interface State {
  config: Config;
  /** playerId → latest answer (for the player's own feedback). */
  answers: Record<string, number>;
}

interface Input {
  answer: number;
}

/** One evaluation per submission (results: immediate). */
interface Evaluation {
  playerId: string;
  displayName: string;
  answer: number;
  correct: boolean;
  /** Absolute distance from the correct answer. */
  diff: number;
}

function fmt(n: number, unit?: string): string {
  const s = Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '');
  return unit ? `${s} ${unit}` : s;
}

function nameOf(players: PlayerRef[], id: string): string {
  return players.find((p) => p.id === id)?.displayName ?? 'Unknown';
}

function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

function mostCommonWrong(evaluations: Evaluation[]): { value: number; count: number } | null {
  const counts = new Map<number, number>();
  for (const e of evaluations) if (!e.correct) counts.set(e.answer, (counts.get(e.answer) ?? 0) + 1);
  let best: { value: number; count: number } | null = null;
  for (const [value, count] of counts) if (!best || count > best.count) best = { value, count };
  return best;
}

function average(evaluations: Evaluation[]): number | null {
  return evaluations.length ? evaluations.reduce((a, e) => a + e.answer, 0) / evaluations.length : null;
}

/** Presentation histogram: one column per whole number when there are few, otherwise equal ranges. */
const MAX_COLUMNS = 12;
const RANGES = 10;

interface Spread {
  columns: { label: string; count: number }[];
  /** Column a value falls in. */
  indexOf: (v: number) => number;
  /** Where a value lies along the axis, 0..1 (for the distribution's marker). */
  at: (v: number) => number;
  /** Ranges: the axis carries the numbers (compact histogram). */
  axis?: { start: string; end: string };
}

/** 1, 2, 2.5 or 5 times a power of ten, at least `raw`. */
function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

/**
 * How `values` spread, on an axis that also spans `extra` (e.g. the answer, once revealed).
 * Far-off values (beyond 1.5 × the interquartile range) land in the end columns, marked ≤ / ≥,
 * so one wild guess does not squash everyone else into a single column.
 */
function spreadOf(values: number[], extra: number[], label: (n: number) => string): Spread {
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0]!;
  const max = sorted[sorted.length - 1]!;
  let lo = min;
  let hi = max;
  if (sorted.length >= 4) {
    const q1 = sorted[Math.floor((sorted.length - 1) * 0.25)]!;
    const q3 = sorted[Math.ceil((sorted.length - 1) * 0.75)]!;
    const fence = 1.5 * (q3 - q1);
    if (q3 > q1) {
      lo = sorted.find((v) => v >= q1 - fence)!;
      hi = [...sorted].reverse().find((v) => v <= q3 + fence)!;
    }
  }
  lo = Math.min(lo, ...extra);
  hi = Math.max(hi, ...extra);
  const cutLow = min < lo;
  const cutHigh = max > hi;
  if (!(hi > lo)) return { columns: [{ label: label(lo), count: values.length }], indexOf: () => 0, at: () => 0.5 };
  if ([...sorted, ...extra].every(Number.isInteger) && hi - lo < MAX_COLUMNS) {
    const n = hi - lo + 1;
    const indexOf = (v: number) => Math.min(n - 1, Math.max(0, Math.round(v - lo)));
    const columns = Array.from({ length: n }, (_, i) => ({ label: label(lo + i), count: 0 }));
    if (cutLow) columns[0]!.label = `≤ ${label(lo)}`;
    if (cutHigh) columns[n - 1]!.label = `≥ ${label(hi)}`;
    for (const v of values) columns[indexOf(v)]!.count++;
    return { columns, indexOf, at: (v) => (v - lo + 0.5) / n };
  }
  const width = niceStep((hi - lo) / RANGES);
  const start = Math.floor(lo / width) * width;
  const n = Math.max(1, Math.ceil((hi - start) / width - 1e-9));
  const end = start + n * width;
  const indexOf = (v: number) => Math.min(n - 1, Math.max(0, Math.floor((v - start) / width + 1e-9)));
  const columns = Array.from({ length: n }, (_, i) => ({ label: `${label(start + i * width)}–${label(start + (i + 1) * width)}`, count: 0 }));
  if (cutLow) columns[0]!.label = `≤ ${label(start + width)}`;
  if (cutHigh) columns[n - 1]!.label = `≥ ${label(end - width)}`;
  for (const v of values) columns[indexOf(v)]!.count++;
  return { columns, indexOf, at: (v) => (v - start) / (n * width), axis: { start: `${cutLow ? '≤ ' : ''}${label(start)}`, end: `${cutHigh ? '≥ ' : ''}${label(end)}` } };
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A small labelled number on a presentation slide. */
function stat(label: string, value: string, tone: Tone = 'neutral'): UINode {
  return ui.card([ui.caption(label, { align: 'center' }), ui.title(value, { align: 'center', tone: tone === 'neutral' ? undefined : tone })], tone);
}

export default defineModule<Config, State, Input, Evaluation>({
  manifest: manifestJson as unknown as Manifest,
  configurationSchema: schemaJson,

  createInstance(config) {
    return { config, answers: {} };
  },

  timeLimit(state) {
    return state.config.timeLimit > 0 ? state.config.timeLimit : null;
  },

  onAttemptStart(state, player, ctx) {
    // Per-player time limit: the engine locks this player's attempt when it fires.
    if (state.config.timeLimit > 0) ctx.schedule('lock', state.config.timeLimit, player.id); // 0 = no time limit
    // A replay starts with an empty answer.
    const { [player.id]: _previous, ...answers } = state.answers;
    return { ...state, answers };
  },

  validateInput(_state, _player, input) {
    if (!input || typeof input !== 'object') return { ok: false, reason: 'Enter a number' };
    const raw = (input as { answer?: unknown }).answer;
    if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
      return { ok: false, reason: 'Enter a number' };
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false, reason: 'Enter a valid number' };
    if (Math.abs(n) > 1e15) return { ok: false, reason: 'That number is too large' };
    return { ok: true };
  },

  handleInput(state, player, input) {
    return { ...state, answers: { ...state.answers, [player.id]: Number(input.answer) } };
  },

  evaluate(state, submissions, ctx) {
    // Immediate results: exactly one submission (the locked attempt's latest).
    const s = submissions[0]!;
    const correct = state.config.correctAnswer;
    const tolerance = Math.max(0, state.config.tolerance ?? 0);
    const answer = Number(s.payload.answer);
    const diff = Math.abs(answer - correct);
    // Small epsilon guards against floating point noise on the tolerance boundary.
    return { playerId: s.playerId, displayName: nameOf(ctx.players(), s.playerId), answer, correct: diff <= tolerance + 1e-9, diff };
  },

  calculateScores(state, evaluation) {
    return [
      {
        playerId: evaluation.playerId,
        points: evaluation.correct ? state.config.points : 0,
        reason: evaluation.correct ? 'Correct' : `${fmt(evaluation.diff, state.config.unit)} off`,
      },
    ];
  },

  getStatistics(state, evaluations) {
    const correctCount = evaluations.filter((e) => e.correct).length;
    const avg = average(evaluations);
    return {
      question: state.config.question,
      correctAnswer: state.config.correctAnswer,
      tolerance: Math.max(0, state.config.tolerance ?? 0),
      unit: state.config.unit ?? '',
      answers: evaluations.length,
      correctCount,
      correctPercent: pct(correctCount, evaluations.length),
      wrongCount: evaluations.length - correctCount,
      mostCommonWrong: mostCommonWrong(evaluations),
      average: avg === null ? null : Math.round(avg * 100) / 100,
    };
  },

  introView(state) {
    const c = state.config;
    const tol = Math.max(0, c.tolerance ?? 0);
    return ui.stack(
      [
        ui.text(`${c.timeLimit > 0 ? `You get ${c.timeLimit} seconds to answer` : 'Answer'} with a number${c.unit ? ` (in ${c.unit})` : ''}.${c.timeLimit > 0 ? ' You can change your answer until time runs out or you press Finish.' : ''}`),
        ui.caption(tol > 0 ? `Within ± ${fmt(tol, c.unit)} of the right value scores ${c.points} points.` : `The exact value scores ${c.points} points.`),
      ],
      { gap: 'sm' },
    );
  },

  guestView(state, player, ctx) {
    const c = state.config;
    const mine = state.answers[player.id];
    const children: UINode[] = [ui.subtitle(c.question)];
    if (c.media) children.push(ui.image(ctx.mediaUrl(c.media), { maxHeight: '30vh' }));
    children.push(ui.timer('lock'));
    children.push(ui.numberInput('answer', { label: 'Your answer', unit: c.unit, value: mine, placeholder: '0' }));
    children.push(ui.submit(mine === undefined ? 'Submit' : 'Update answer', { size: 'lg' }));
    return {
      ui: ui.stack(children, { gap: 'md' }),
      canSubmit: true,
      status: mine === undefined ? undefined : `Submitted ${fmt(mine, c.unit)} — you can still change it until time runs out`,
    };
  },

  mainView(state) {
    // Public card: the question only, never the answer.
    const c = state.config;
    return ui.caption(c.unit ? `${c.question} (${c.unit})` : c.question);
  },

  presentation(state, evaluations, ctx): PresentationSlide[] {
    // Step 1: the question and how the room answered; step 2: the same, with the answer in it.
    // No names, points or "who got it": only the room as a whole.
    const c = state.config;
    const guesses = evaluations.map((e) => e.answer).filter(Number.isFinite);
    if (guesses.length === 0) return [];
    const tolerance = Math.max(0, c.tolerance ?? 0);
    const sorted = [...guesses].sort((a, b) => a - b);
    const avg = average(evaluations)!;
    const right = evaluations.filter((e) => e.correct).length;
    const answerText = tolerance > 0 ? `${fmt(c.correctAnswer, c.unit)} ± ${fmt(tolerance)}` : fmt(c.correctAnswer, c.unit);
    const summary = `${guesses.length} ${guesses.length === 1 ? 'answer' : 'answers'} · average ${fmt(avg, c.unit)}`;
    const step = (reveal: boolean): UINode => {
      const spread = spreadOf(guesses, reveal ? [c.correctAnswer] : [], (n) => fmt(n));
      return ui.stack(
        [
          ui.title(c.unit ? `${c.question} (${c.unit})` : c.question, { align: 'center' }),
          ...(c.media ? [ui.image(ctx.mediaUrl(c.media), { maxHeight: '28vh' })] : []),
          ui.distribution(spread.columns, {
            axis: spread.axis,
            compact: spread.axis ? true : undefined,
            marker: reveal ? { at: spread.at(c.correctAnswer), label: `answer ${fmt(c.correctAnswer, c.unit)}` } : undefined,
            highlight: reveal ? spread.indexOf(c.correctAnswer) : undefined,
          }),
          ui.grid(
            4,
            [
              stat('Lowest answer', fmt(sorted[0]!, c.unit)),
              stat('Middle answer', fmt(medianOf(guesses), c.unit)),
              stat('Highest answer', fmt(sorted[sorted.length - 1]!, c.unit)),
              reveal ? stat('The answer', answerText, 'success') : stat('The answer', '?', 'muted'),
            ],
            { gap: 'md' },
          ),
          ui.caption(reveal ? `${summary} · ${right} of ${guesses.length} right` : summary, { align: 'center' }),
        ],
        { gap: 'md', align: 'stretch' },
      );
    };
    return [{ steps: [step(false), step(true)], stepSeconds: 10 }];
  },

  resultsView(state, evaluations) {
    const c = state.config;
    const tolerance = Math.max(0, c.tolerance ?? 0);
    const correctText = tolerance > 0 ? `${fmt(c.correctAnswer, c.unit)} (± ${fmt(tolerance, c.unit)})` : fmt(c.correctAnswer, c.unit);
    const winners = evaluations.filter((e) => e.correct);
    const wrong = evaluations.length - winners.length;
    const avg = average(evaluations);
    const chart = ui.barChart(
      [
        { label: 'Correct', value: winners.length, highlight: true, tone: 'success' },
        { label: 'Wrong', value: wrong, tone: 'danger' },
      ],
      { percent: true },
    );
    const shared = ui.stack(
      [
        ui.caption(c.question, { align: 'center' }),
        ui.display(correctText, { tone: 'success' }),
        winners.length
          ? ui.list(winners.slice(0, 8).map((e) => ({ label: e.displayName, value: fmt(e.answer, c.unit), tone: 'success', highlight: true })))
          : ui.badge(evaluations.length ? 'Nobody got it right' : 'No answers yet', 'muted'),
        chart,
        ui.row(
          [
            ui.badge(`${winners.length} of ${evaluations.length} correct`, winners.length > 0 ? 'success' : 'muted'),
            ui.badge(`Average ${avg === null ? '–' : fmt(avg, c.unit)}`),
          ],
          { gap: 'sm', wrap: true, justify: 'center' },
        ),
      ],
      { gap: 'md', align: 'stretch' },
    );
    return {
      ui: shared,
      guestUi: (player) => {
        const me = evaluations.find((e) => e.playerId === player.id);
        const mine: UINode = !me
          ? ui.badge('You did not answer', 'muted')
          : ui.card(
              [
                ui.title(me.correct ? 'Correct!' : 'Not quite', { tone: me.correct ? 'success' : 'danger' }),
                ui.text(`You answered ${fmt(me.answer, c.unit)}`),
                ui.text(me.correct ? `${c.points} points` : `${fmt(me.diff, c.unit)} off · 0 points`, { tone: 'muted' }),
              ],
              me.correct ? 'success' : 'danger',
            );
        return ui.stack([ui.caption(c.question), ui.display(correctText, { tone: 'success' }), mine, chart], { gap: 'md' });
      },
    };
  },
});
