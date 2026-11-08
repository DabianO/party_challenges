/**
 * Closest Number — reference module for `results: "onClose"`.
 *
 * Each player starts the challenge whenever they like, gets their own time limit and
 * submits an estimate. When the host closes the challenge, all guesses are ranked by
 * distance and scored together.
 */
import { defineModule, ui, type Manifest, type PlayerRef, type PresentationSlide, type Tone, type UINode } from '@challenge/contract';
import manifestJson from '../manifest.json' with { type: 'json' };
import schemaJson from '../config.schema.json' with { type: 'json' };

interface Config {
  question: string;
  correctAnswer: number;
  unit?: string;
  timeLimit: number;
  maxPoints: number;
  scoring: 'ranked' | 'distance';
  media?: string;
}

interface State {
  config: Config;
  /** playerId → latest guess (for the player's own feedback). */
  guesses: Record<string, number>;
}

interface Input {
  answer: number;
}

interface Evaluation {
  correct: number;
  ranked: { playerId: string; displayName: string; guess: number; distance: number; rank: number }[];
  count: number;
  average: number | null;
  median: number | null;
}

function fmt(n: number, unit?: string): string {
  const s = Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '');
  return unit ? `${s} ${unit}` : s;
}

function nameOf(players: PlayerRef[], id: string): string {
  return players.find((p) => p.id === id)?.displayName ?? 'Unknown';
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
    return { config, guesses: {} };
  },

  timeLimit(state) {
    return state.config.timeLimit > 0 ? state.config.timeLimit : null;
  },

  onAttemptStart(state, player, ctx) {
    // Per-player time limit: the engine locks this player's attempt when it fires.
    if (state.config.timeLimit > 0) ctx.schedule('lock', state.config.timeLimit, player.id); // 0 = no time limit
    return state;
  },

  validateInput(_state, _player, input) {
    if (!input || typeof input !== 'object') return { ok: false, reason: 'Enter a number' };
    const n = Number((input as Input).answer);
    if (!Number.isFinite(n)) return { ok: false, reason: 'Enter a valid number' };
    if (Math.abs(n) > 1e15) return { ok: false, reason: 'That number is too large' };
    return { ok: true };
  },

  handleInput(state, player, input) {
    return { ...state, guesses: { ...state.guesses, [player.id]: Number(input.answer) } };
  },

  evaluate(state, submissions, ctx) {
    const players = ctx.players();
    const correct = state.config.correctAnswer;
    const rows = submissions
      .map((s) => ({
        playerId: s.playerId,
        displayName: nameOf(players, s.playerId),
        guess: Number(s.payload.answer),
        distance: Math.abs(Number(s.payload.answer) - correct),
        submittedAt: s.submittedAt,
        rank: 0,
      }))
      .sort((a, b) => a.distance - b.distance || a.submittedAt - b.submittedAt);
    rows.forEach((r, i) => {
      r.rank = i > 0 && rows[i - 1]!.distance === r.distance ? rows[i - 1]!.rank : i + 1;
    });
    const guesses = rows.map((r) => r.guess).sort((a, b) => a - b);
    const mid = Math.floor(guesses.length / 2);
    return {
      correct,
      ranked: rows.map(({ submittedAt: _omit, ...r }) => r),
      count: rows.length,
      average: guesses.length ? guesses.reduce((a, b) => a + b, 0) / guesses.length : null,
      median: guesses.length ? (guesses.length % 2 ? guesses[mid]! : (guesses[mid - 1]! + guesses[mid]!) / 2) : null,
    };
  },

  calculateScores(state, evaluation) {
    const max = state.config.maxPoints;
    if (state.config.scoring === 'distance') {
      const scale = Math.max(Math.abs(evaluation.correct), 1);
      return evaluation.ranked.map((r) => {
        const rel = Math.min(1, r.distance / scale);
        return { playerId: r.playerId, points: Math.round(max * (1 - rel) * 10) / 10, reason: `${fmt(r.distance)} off` };
      });
    }
    const n = Math.max(evaluation.ranked.length, 1);
    return evaluation.ranked.map((r) => ({
      playerId: r.playerId,
      points: Math.max(1, Math.round(max * (1 - (r.rank - 1) / n))),
      reason: `#${r.rank} closest`,
    }));
  },

  getStatistics(state, evaluations) {
    const evaluation = evaluations[0];
    if (!evaluation) return { answers: 0 };
    const sorted = evaluation.ranked;
    return {
      correctAnswer: evaluation.correct,
      answers: evaluation.count,
      average: evaluation.average === null ? null : Math.round(evaluation.average * 100) / 100,
      median: evaluation.median,
      closest: sorted[0] ? { name: sorted[0].displayName, guess: sorted[0].guess } : null,
      furthest: sorted.length ? { name: sorted[sorted.length - 1]!.displayName, guess: sorted[sorted.length - 1]!.guess } : null,
      unit: state.config.unit ?? '',
    };
  },

  introView(state) {
    const c = state.config;
    return ui.stack(
      [
        ui.text(`${c.timeLimit > 0 ? `You get ${c.timeLimit} seconds to estimate a number.` : 'Estimate a number.'} Scores are awarded when the host closes this challenge.`),
        ui.caption(c.scoring === 'ranked' ? 'The closest guess gets the most points.' : 'Points shrink with the distance to the real value.'),
      ],
      { gap: 'sm' },
    );
  },

  guestView(state, player, ctx) {
    const c = state.config;
    const mine = state.guesses[player.id];
    const children: UINode[] = [ui.subtitle(c.question)];
    if (c.media) children.push(ui.image(ctx.mediaUrl(c.media), { maxHeight: '30vh' }));
    children.push(ui.timer('lock'));
    children.push(ui.numberInput('answer', { label: 'Your estimate', unit: c.unit, value: mine, placeholder: '0' }));
    children.push(ui.submit(mine === undefined ? 'Submit' : 'Update answer', { size: 'lg' }));
    return {
      ui: ui.stack(children, { gap: 'md' }),
      canSubmit: true,
      status: mine === undefined ? undefined : `Submitted ${fmt(mine, c.unit)} — you can still change it until time runs out`,
    };
  },

  mainView(state) {
    return ui.caption(state.config.question);
  },

  presentation(state, evaluations, ctx): PresentationSlide[] {
    // Step 1: the question and the room's spread of guesses; step 2: the same, with the real
    // value in it. No names, points or ranks: only the room as a whole.
    const c = state.config;
    const evaluation = evaluations[0];
    const guesses = (evaluation?.ranked ?? []).map((r) => r.guess).filter(Number.isFinite);
    if (!evaluation || guesses.length === 0) return [];
    const answer = evaluation.correct;
    const sorted = [...guesses].sort((a, b) => a - b);
    const avg = guesses.reduce((a, b) => a + b, 0) / guesses.length;
    // One decimal is plenty for the room's average on the big screen.
    const tenth = (n: number) => Math.round(n * 10) / 10;
    const summary = `${guesses.length} ${guesses.length === 1 ? 'guess' : 'guesses'} · average ${fmt(tenth(avg), c.unit)}`;
    const step = (reveal: boolean): UINode => {
      const spread = spreadOf(guesses, reveal ? [answer] : [], (n) => fmt(n));
      return ui.stack(
        [
          ui.title(c.unit ? `${c.question} (${c.unit})` : c.question, { align: 'center' }),
          ...(c.media ? [ui.image(ctx.mediaUrl(c.media), { maxHeight: '28vh' })] : []),
          ui.distribution(spread.columns, {
            axis: spread.axis,
            compact: spread.axis ? true : undefined,
            marker: reveal ? { at: spread.at(answer), label: `answer ${fmt(answer, c.unit)}` } : undefined,
            highlight: reveal ? spread.indexOf(answer) : undefined,
          }),
          ui.grid(
            4,
            [
              stat('Lowest guess', fmt(sorted[0]!, c.unit)),
              stat('Middle guess', fmt(medianOf(guesses), c.unit)),
              stat('Highest guess', fmt(sorted[sorted.length - 1]!, c.unit)),
              reveal ? stat('The answer', fmt(answer, c.unit), 'success') : stat('The answer', '?', 'muted'),
            ],
            { gap: 'md' },
          ),
          ui.caption(reveal ? `${summary} · the room's average was ${fmt(tenth(Math.abs(avg - answer)), c.unit)} off` : summary, { align: 'center' }),
        ],
        { gap: 'md', align: 'stretch' },
      );
    };
    return [{ steps: [step(false), step(true)], stepSeconds: 10 }];
  },

  resultsView(state, evaluations) {
    const c = state.config;
    const evaluation = evaluations[0];
    if (!evaluation) return { ui: ui.caption('Waiting for the host to close this challenge.') };
    const top = evaluation.ranked.slice(0, 5);
    const shared = ui.stack(
      [
        ui.caption(c.question, { align: 'center' }),
        ui.display(fmt(evaluation.correct, c.unit), { tone: 'success' }),
        ui.ranking(top.map((r) => ({ rank: r.rank, name: r.displayName, value: fmt(r.guess, c.unit), highlight: r.rank === 1 }))),
        ui.row(
          [
            ui.badge(`Average ${evaluation.average === null ? '–' : fmt(evaluation.average, c.unit)}`),
            ui.badge(`Median ${evaluation.median === null ? '–' : fmt(evaluation.median, c.unit)}`),
            ui.badge(`${evaluation.count} answers`),
          ],
          { gap: 'sm', wrap: true, justify: 'center' },
        ),
      ],
      { gap: 'md', align: 'stretch' },
    );
    return {
      ui: shared,
      guestUi: (player) => {
        const me = evaluation.ranked.find((r) => r.playerId === player.id);
        return ui.stack(
          [
            ui.caption(c.question),
            ui.display(fmt(evaluation.correct, c.unit), { tone: 'success' }),
            me
              ? ui.card([ui.text(`You guessed ${fmt(me.guess, c.unit)}`), ui.text(`#${me.rank} closest · ${fmt(me.distance, c.unit)} off`, { tone: 'muted' })], 'primary')
              : ui.badge('You did not answer', 'muted'),
            ui.ranking(top.slice(0, 3).map((r) => ({ rank: r.rank, name: r.displayName, value: fmt(r.guess, c.unit), highlight: r.playerId === player.id }))),
          ],
          { gap: 'md' },
        );
      },
    };
  },
});
