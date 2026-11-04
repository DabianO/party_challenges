/**
 * Multiple Choice (contract v2).
 *
 * Each player starts the question whenever they like, gets their own time limit and
 * picks one of up to six lettered options. The submission is evaluated on its own as
 * soon as the attempt locks; the speed bonus uses the server-side attempt timestamps.
 */
import { defineModule, ui, type Manifest, type PlayerRef, type UINode } from '@challenge/contract';
import manifestJson from '../manifest.json' with { type: 'json' };
import schemaJson from '../config.schema.json' with { type: 'json' };

interface Config {
  question: string;
  options: string[];
  correctIndex: number;
  timeLimit: number;
  points: number;
  speedBonus: boolean;
  media?: string;
}

interface State {
  config: Config;
  /** playerId → chosen option id ('A', 'B', …). */
  picks: Record<string, string>;
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
  points: number;
  /** Milliseconds between the attempt start and the (server-timestamped) submission. */
  elapsedMs: number;
}

function letter(index: number): string {
  return String.fromCharCode(65 + index);
}

function optionIds(config: Config): string[] {
  return config.options.map((_, i) => letter(i));
}

function correctIdOf(config: Config): string | null {
  const i = config.correctIndex;
  return Number.isInteger(i) && i >= 0 && i < config.options.length ? letter(i) : null;
}

function nameOf(players: PlayerRef[], id: string): string {
  return players.find((p) => p.id === id)?.displayName ?? 'Unknown';
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

function optionLabel(config: Config, id: string): string {
  const text = config.options[id.charCodeAt(0) - 65] ?? '?';
  return `${id}. ${text}`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export default defineModule<Config, State, Input, Evaluation>({
  manifest: manifestJson as unknown as Manifest,
  configurationSchema: schemaJson,

  createInstance(config) {
    return { config, picks: {} };
  },

  timeLimit(state) {
    return state.config.timeLimit > 0 ? state.config.timeLimit : null;
  },

  onAttemptStart(state, player, ctx) {
    // Per-player time limit: the engine locks this player's attempt when it fires.
    if (state.config.timeLimit > 0) ctx.schedule('lock', state.config.timeLimit, player.id); // 0 = no time limit
    // A replay starts with no pick.
    const { [player.id]: _previous, ...picks } = state.picks;
    return { ...state, picks };
  },

  validateInput(state, player, input) {
    if (!input || typeof input !== 'object') return { ok: false, reason: 'Pick an option' };
    const answer = (input as Input).answer;
    if (typeof answer !== 'string' || !optionIds(state.config).includes(answer)) {
      return { ok: false, reason: 'Pick one of the listed options' };
    }
    if (state.picks[player.id] !== undefined) return { ok: false, reason: 'You have already answered' };
    return { ok: true };
  },

  handleInput(state, player, input) {
    return { ...state, picks: { ...state.picks, [player.id]: input.answer } };
  },

  evaluate(state, submissions, ctx) {
    // Immediate results: exactly one submission (the locked attempt's latest).
    const s = submissions[0]!;
    const c = state.config;
    const correctId = correctIdOf(c);
    const answer = String(s.payload.answer);
    const correct = correctId !== null && answer === correctId;
    const elapsedMs = Math.max(0, s.submittedAt - s.startedAt);
    const limitMs = c.timeLimit * 1000;
    let points = 0;
    if (correct) {
      points = c.points;
      if (c.speedBonus && limitMs > 0) {
        // Up to +50% for an instant answer, linearly down to +0% at the time limit.
        const speed = Math.min(1, Math.max(0, 1 - elapsedMs / limitMs));
        points = round1(c.points * (1 + 0.5 * speed));
      }
    }
    return { playerId: s.playerId, displayName: nameOf(ctx.players(), s.playerId), answer, correct, points, elapsedMs };
  },

  calculateScores(_state, evaluation) {
    return [
      {
        playerId: evaluation.playerId,
        points: evaluation.points,
        reason: evaluation.correct ? `Correct in ${seconds(evaluation.elapsedMs)}` : `Wrong (${evaluation.answer})`,
      },
    ];
  },

  getStatistics(state, evaluations) {
    const c = state.config;
    const correctId = correctIdOf(c);
    const total = evaluations.length;
    const counts: Record<string, number> = {};
    for (const id of optionIds(c)) counts[id] = 0;
    for (const e of evaluations) if (e.answer in counts) counts[e.answer] = (counts[e.answer] ?? 0) + 1;
    const correctRows = evaluations.filter((e) => e.correct);
    const fastest = [...correctRows].sort((a, b) => a.elapsedMs - b.elapsedMs)[0];
    return {
      question: c.question,
      answers: total,
      options: optionIds(c).map((id, i) => ({
        id,
        text: c.options[i] ?? '',
        count: counts[id] ?? 0,
        percent: pct(counts[id] ?? 0, total),
        correct: id === correctId,
      })),
      correctAnswer: correctId === null ? null : { id: correctId, text: c.options[c.correctIndex] ?? null },
      correctCount: correctRows.length,
      correctPercent: pct(correctRows.length, total),
      fastestCorrect: fastest ? { name: fastest.displayName, ms: fastest.elapsedMs } : null,
    };
  },

  introView(state) {
    const c = state.config;
    return ui.stack(
      [
        ui.text(`${c.timeLimit > 0 ? `You get ${c.timeLimit} seconds to pick` : 'Pick'} one of ${c.options.length} options. Tapping an option submits it — you cannot change your mind.`),
        ui.caption(c.speedBonus ? `A correct answer scores ${c.points} points, plus up to 50% extra for speed.` : `A correct answer scores ${c.points} points.`),
      ],
      { gap: 'sm' },
    );
  },

  guestView(state, player, ctx) {
    const c = state.config;
    const mine = state.picks[player.id];
    const children: UINode[] = [ui.subtitle(c.question)];
    if (c.media) children.push(ui.image(ctx.mediaUrl(c.media), { maxHeight: '25vh' }));
    if (mine !== undefined) {
      children.push(ui.badge(`Your answer: ${optionLabel(c, mine)}`, 'primary'));
      return { ui: ui.stack(children, { gap: 'md' }), canSubmit: false, status: 'Answer locked in' };
    }
    children.push(ui.timer('lock'));
    children.push(
      ui.choices(
        'answer',
        c.options.map((text, i) => ({ id: letter(i), label: `${letter(i)}. ${text}` })),
        { submitOnSelect: true, columns: c.options.length > 4 ? 2 : 1 },
      ),
    );
    return { ui: ui.stack(children, { gap: 'md' }), canSubmit: true, status: 'Tap an option to answer' };
  },

  mainView(state) {
    // Public card: the question only, never which option is right.
    return ui.caption(state.config.question);
  },

  resultsView(state, evaluations) {
    const c = state.config;
    const correctId = correctIdOf(c);
    const ids = optionIds(c);
    const counts: Record<string, number> = {};
    for (const id of ids) counts[id] = 0;
    for (const e of evaluations) if (e.answer in counts) counts[e.answer] = (counts[e.answer] ?? 0) + 1;

    const correctNode =
      correctId === null
        ? ui.badge('No correct answer was configured', 'warning')
        : ui.display(optionLabel(c, correctId), { tone: 'success' });
    const chart = ui.barChart(
      ids.map((id) => ({
        label: optionLabel(c, id),
        value: counts[id] ?? 0,
        highlight: id === correctId,
        tone: id === correctId ? 'success' : 'neutral',
      })),
      { percent: true },
    );
    const sorted = [...evaluations].sort((a, b) => b.points - a.points || a.elapsedMs - b.elapsedMs);
    const top = sorted.slice(0, 5);
    const ranking = ui.ranking(
      top.map((e, i) => ({
        rank: i + 1,
        name: e.displayName,
        value: e.correct ? `${e.answer} · ${seconds(e.elapsedMs)}` : e.answer,
        points: e.points,
        highlight: e.correct,
      })),
    );
    const correctCount = evaluations.filter((e) => e.correct).length;
    const shared = ui.stack(
      [
        ui.caption(c.question, { align: 'center' }),
        correctNode,
        chart,
        ranking,
        ui.row([ui.badge(`${correctCount} of ${evaluations.length} correct`, correctCount > 0 ? 'success' : 'muted')], { justify: 'center' }),
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
                ui.title(me.correct ? 'Correct!' : 'Wrong', { tone: me.correct ? 'success' : 'danger' }),
                ui.text(`You picked ${optionLabel(c, me.answer)}`),
                ui.text(me.correct ? `${me.points} points · answered in ${seconds(me.elapsedMs)}` : `${me.points} points`, { tone: 'muted' }),
              ],
              me.correct ? 'success' : 'danger',
            );
        return ui.stack([ui.caption(c.question), correctNode, mine, chart], { gap: 'md' });
      },
    };
  },
});
