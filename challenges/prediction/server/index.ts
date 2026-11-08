/**
 * Prediction (contract v2, `results: "onClose"` + host resolution).
 *
 * Players predict an outcome that is decided later ("Who will win the next
 * challenge?"). Everyone predicts at their own pace; when the host closes the challenge
 * the predictions are tallied and the instance waits in EVALUATING until the host picks
 * what actually happened. The host can leave the form until the event has happened.
 */
import { defineModule, ui, type ChoiceOption, type Manifest, type PlayerRef, type PresentationSlide, type UINode } from '@challenge/contract';
import manifestJson from '../manifest.json' with { type: 'json' };
import schemaJson from '../config.schema.json' with { type: 'json' };

interface Config {
  question: string;
  optionsSource: 'custom' | 'players';
  options: string[];
  timeLimit: number;
  points: number;
  allowMultipleOutcomes: boolean;
}

interface State {
  config: Config;
  /** Frozen at creation so roster changes never shift ids. */
  options: ChoiceOption[];
  /** playerId → option id (for guest feedback). */
  predictions: Record<string, string>;
}

interface Input {
  answer: string;
}

interface Evaluation {
  /** option id → number of predictions. */
  distribution: Record<string, number>;
  rows: { playerId: string; displayName: string; answer: string }[];
  /** Resolved option id(s); null until the host resolves. */
  outcome: string[] | null;
}

function buildOptions(config: Config, players: PlayerRef[]): ChoiceOption[] {
  const custom = (config.options ?? []).map((s) => String(s).trim()).filter(Boolean);
  if (config.optionsSource !== 'players' && custom.length >= 2) {
    return custom.map((label, i) => ({ id: `o${i}`, label }));
  }
  return players.map((p) => ({ id: p.id, label: p.displayName }));
}

function labelOf(state: State, id: string): string {
  return state.options.find((o) => o.id === id)?.label ?? id;
}

function nameOf(players: PlayerRef[], id: string): string {
  return players.find((p) => p.id === id)?.displayName ?? 'Unknown';
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export default defineModule<Config, State, Input, Evaluation>({
  manifest: manifestJson as unknown as Manifest,
  configurationSchema: schemaJson,

  createInstance(config, ctx) {
    return { config, options: buildOptions(config, ctx.players()), predictions: {} };
  },

  timeLimit(state) {
    return state.config.timeLimit > 0 ? state.config.timeLimit : null;
  },

  onAttemptStart(state, player, ctx) {
    if (state.config.timeLimit > 0) ctx.schedule('lock', state.config.timeLimit, player.id); // 0 = no time limit
    return state;
  },

  validateInput(state, _player, input) {
    if (state.options.length === 0) return { ok: false, reason: 'There is nothing to predict yet' };
    if (!input || typeof input !== 'object') return { ok: false, reason: 'Pick an option' };
    const answer = (input as { answer?: unknown }).answer;
    if (typeof answer !== 'string' || !state.options.some((o) => o.id === answer)) return { ok: false, reason: 'Pick one of the options' };
    return { ok: true };
  },

  handleInput(state, player, input) {
    return { ...state, predictions: { ...state.predictions, [player.id]: input.answer } };
  },

  evaluate(state, submissions, ctx) {
    // onClose: all latest submissions; the outcome is filled in by the host afterwards.
    const players = ctx.players();
    const distribution: Record<string, number> = {};
    for (const o of state.options) distribution[o.id] = 0;
    const rows = submissions
      .filter((s) => state.options.some((o) => o.id === s.payload?.answer))
      .map((s) => {
        const answer = String(s.payload.answer);
        distribution[answer] = (distribution[answer] ?? 0) + 1;
        return { playerId: s.playerId, displayName: nameOf(players, s.playerId), answer };
      });
    return { distribution, rows, outcome: null };
  },

  hostResolutionView(state, evaluation) {
    const multiple = state.config.allowMultipleOutcomes;
    const current = evaluation.outcome ?? [];
    return {
      ui: ui.stack(
        [
          ui.title(state.config.question),
          ui.caption(`${plural(evaluation.rows.length, 'prediction')} ${evaluation.rows.length === 1 ? 'was' : 'were'} made.`),
          ui.choices(
            'outcome',
            state.options,
            multiple ? { multiple: true, value: current, columns: 1 } : { multiple: false, value: current[0], columns: 1 },
          ),
          ui.caption(
            multiple
              ? 'Pick everything that actually happened. You can leave this until the event has happened and resolve it later.'
              : 'Pick what actually happened. You can leave this until the event has happened and resolve it later.',
          ),
        ],
        { gap: 'md', align: 'stretch' },
      ),
      submitLabel: 'Resolve',
    };
  },

  applyHostResolution(state, evaluation, payload) {
    const raw = payload?.outcome;
    const picked = Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === '' ? [] : [raw];
    const valid = new Set(state.options.map((o) => o.id));
    const outcome = [...new Set(picked.map((v) => String(v)).filter((id) => valid.has(id)))];
    if (outcome.length === 0) {
      return { evaluation: { ...evaluation, outcome: null }, complete: false, message: 'Pick at least one outcome' };
    }
    const chosen = state.config.allowMultipleOutcomes ? outcome : outcome.slice(0, 1);
    return { evaluation: { ...evaluation, outcome: chosen }, complete: true };
  },

  calculateScores(state, evaluation, ctx) {
    const roster = new Set(ctx.players().map((p) => p.id));
    const outcome = new Set(evaluation.outcome ?? []);
    return evaluation.rows
      .filter((r) => outcome.has(r.answer) && roster.has(r.playerId))
      .map((r) => ({ playerId: r.playerId, points: state.config.points, reason: `Predicted ${labelOf(state, r.answer)}` }));
  },

  getStatistics(state, evaluations) {
    const evaluation = evaluations[0];
    if (!evaluation) return { question: state.config.question, predictions: Object.keys(state.predictions).length, resolved: false };
    const total = evaluation.rows.length;
    const outcome = new Set(evaluation.outcome ?? []);
    const correct = evaluation.rows.filter((r) => outcome.has(r.answer)).length;
    return {
      question: state.config.question,
      predictions: total,
      resolved: outcome.size > 0,
      distribution: state.options.map((o) => ({
        id: o.id,
        label: o.label,
        count: evaluation.distribution[o.id] ?? 0,
        percent: total ? Math.round(((evaluation.distribution[o.id] ?? 0) / total) * 100) : 0,
      })),
      outcome: [...outcome].map((id) => labelOf(state, id)),
      correct,
      accuracyPercent: total ? Math.round((correct / total) * 100) : 0,
    };
  },

  introView(state) {
    const c = state.config;
    return ui.stack(
      [
        ui.text(`${c.question}`),
        ui.caption(
          `${c.timeLimit > 0 ? `You have ${c.timeLimit} seconds to lock` : 'Lock'} in a prediction. Predictions stay secret; the host resolves the outcome later and correct predictions earn ${c.points} points.`,
        ),
      ],
      { gap: 'sm' },
    );
  },

  guestView(state, player) {
    const mine = state.predictions[player.id];
    const children: UINode[] = [ui.subtitle(state.config.question)];
    if (state.options.length === 0) {
      children.push(ui.caption('Nothing to predict yet.'));
      return { ui: ui.stack(children, { gap: 'md' }), canSubmit: false };
    }
    children.push(ui.timer('lock'));
    children.push(ui.choices('answer', state.options, { value: mine, columns: 1 }));
    children.push(ui.submit(mine === undefined ? 'Lock in prediction' : 'Change prediction', { size: 'lg' }));
    return {
      ui: ui.stack(children, { gap: 'md' }),
      canSubmit: true,
      status: mine === undefined ? undefined : `Predicted ${labelOf(state, mine)} — you can still change it`,
    };
  },

  mainView(state) {
    const count = Object.keys(state.predictions).length;
    return ui.stack(
      [
        ui.title(state.config.question, { align: 'center' }),
        ui.badge(`${plural(count, 'prediction')} locked in`, count > 0 ? 'primary' : 'muted'),
        ui.caption('Predictions stay secret until the outcome is known.', { align: 'center' }),
      ],
      { gap: 'lg', align: 'center' },
    );
  },

  presentation(state, evaluations): PresentationSlide[] {
    // Step 1: the question and what the room predicted; step 2: the same, with what actually happened.
    // Aggregates only: no names of who called it, no points.
    const evaluation = evaluations[0];
    const total = evaluation?.rows.length ?? 0;
    if (!evaluation || total === 0) return [];
    const outcome = new Set(evaluation.outcome ?? []);
    // Many options (e.g. every player): leave out those nobody predicted, unless they happened.
    const options = state.options.length > 8 ? state.options.filter((o) => (evaluation.distribution[o.id] ?? 0) > 0 || outcome.has(o.id)) : state.options;
    const correct = evaluation.rows.filter((r) => outcome.has(r.answer)).length;
    const step = (reveal: boolean): UINode => {
      const chart = ui.barChart(
        options.map((o) => {
          const lit = reveal && outcome.has(o.id);
          return { label: o.label, value: evaluation.distribution[o.id] ?? 0, highlight: lit, tone: lit ? ('success' as const) : ('neutral' as const) };
        }),
        { percent: true },
      );
      return ui.stack(
        [
          ui.title(state.config.question, { align: 'center' }),
          chart,
          reveal ? ui.display(state.options.filter((o) => outcome.has(o.id)).map((o) => o.label).join(' & '), { tone: 'success' }) : ui.display('?', { tone: 'muted' }),
          ui.caption(reveal ? (correct ? `${correct} of ${total} called it` : 'Nobody saw that coming!') : `${plural(total, 'prediction')}`, { align: 'center' }),
        ],
        { gap: 'md', align: 'stretch' },
      );
    };
    return [{ steps: outcome.size ? [step(false), step(true)] : [step(false)], stepSeconds: 10 }];
  },

  resultsView(state, evaluations) {
    const evaluation = evaluations[0];
    if (!evaluation || !evaluation.outcome?.length) return { ui: ui.caption('Waiting for the outcome.') };
    const outcome = new Set(evaluation.outcome);
    const outcomeLabels = [...outcome].map((id) => labelOf(state, id));
    const bars = state.options.map((o) => ({
      label: o.label,
      value: evaluation.distribution[o.id] ?? 0,
      highlight: outcome.has(o.id),
      tone: outcome.has(o.id) ? ('success' as const) : undefined,
    }));
    const winners = evaluation.rows.filter((r) => outcome.has(r.answer));
    const shared = ui.stack(
      [
        ui.caption(state.config.question, { align: 'center' }),
        ui.display(outcomeLabels.join(' & '), { tone: 'success' }),
        ui.barChart(bars, { percent: true }),
        winners.length
          ? ui.text(`Called it: ${winners.map((w) => w.displayName).join(', ')}`, { align: 'center' })
          : ui.text('Nobody saw that coming!', { tone: 'muted', align: 'center' }),
        ui.badge(`${winners.length} of ${evaluation.rows.length} correct`),
      ],
      { gap: 'md', align: 'center' },
    );
    return {
      ui: shared,
      guestUi: (player) => {
        const me = evaluation.rows.find((r) => r.playerId === player.id);
        const correct = me ? outcome.has(me.answer) : false;
        return ui.stack(
          [
            ui.caption(state.config.question),
            ui.display(outcomeLabels.join(' & '), { tone: 'success' }),
            me
              ? ui.card(
                  [ui.text(correct ? `You called it! +${state.config.points} points` : `You predicted ${labelOf(state, me.answer)}`)],
                  correct ? 'success' : 'danger',
                )
              : ui.badge('You did not predict', 'muted'),
            ui.barChart(bars, { percent: true }),
          ],
          { gap: 'md' },
        );
      },
    };
  },
});
