/**
 * Closest Number — reference module for `results: "onClose"`.
 *
 * Each player starts the challenge whenever they like, gets their own time limit and
 * submits an estimate. When the host closes the challenge, all guesses are ranked by
 * distance and scored together.
 */
import { defineModule, ui, type Manifest, type PlayerRef, type UINode } from '@challenge/contract';
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

export default defineModule<Config, State, Input, Evaluation>({
  manifest: manifestJson as unknown as Manifest,
  configurationSchema: schemaJson,

  createInstance(config) {
    return { config, guesses: {} };
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
