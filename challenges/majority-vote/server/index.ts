/**
 * Majority Vote (contract v2, `results: "onClose"`).
 *
 * Anonymous vote with no correct answer. Every player votes at their own pace with
 * their own time limit; when the host closes the challenge all votes are tallied and
 * players on the winning side (majority or minority, configurable) score.
 */
import { defineModule, ui, type Manifest, type PlayerRef, type UINode } from '@challenge/contract';
import manifestJson from '../manifest.json' with { type: 'json' };
import schemaJson from '../config.schema.json' with { type: 'json' };

interface Config {
  question: string;
  options: string[];
  timeLimit: number;
  points: number;
  mode: 'majority' | 'minority';
  showLiveCounts: boolean;
}

interface State {
  config: Config;
  /** playerId → option id ('A', 'B', …). Never exposed per player on the main display. */
  votes: Record<string, string>;
}

interface Input {
  answer: string;
}

interface Row {
  playerId: string;
  displayName: string;
  vote: string;
  /** True when the player's option is among the winning option(s). */
  winner: boolean;
}

interface Evaluation {
  mode: Config['mode'];
  /** option id → votes (every option present, possibly 0). */
  counts: Record<string, number>;
  total: number;
  /** All winning option ids (several when tied); empty when nobody voted. */
  winningIds: string[];
  unanimous: boolean;
  /** Winners first. */
  rows: Row[];
}

function letter(index: number): string {
  return String.fromCharCode(65 + index);
}

function optionIds(config: Config): string[] {
  return config.options.map((_, i) => letter(i));
}

function optionText(config: Config, id: string): string {
  return config.options[id.charCodeAt(0) - 65] ?? '?';
}

function optionLabel(config: Config, id: string): string {
  return `${id}. ${optionText(config, id)}`;
}

function nameOf(players: PlayerRef[], id: string): string {
  return players.find((p) => p.id === id)?.displayName ?? 'Unknown';
}

function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

function tally(config: Config, votes: Iterable<string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const id of optionIds(config)) counts[id] = 0;
  for (const v of votes) if (counts[v] !== undefined) counts[v] += 1;
  return counts;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export default defineModule<Config, State, Input, Evaluation>({
  manifest: manifestJson as unknown as Manifest,
  configurationSchema: schemaJson,

  createInstance(config) {
    return { config, votes: {} };
  },

  onAttemptStart(state, player, ctx) {
    // Per-player time limit: the engine locks this player's attempt when it fires.
    if (state.config.timeLimit > 0) ctx.schedule('lock', state.config.timeLimit, player.id); // 0 = no time limit
    return state;
  },

  validateInput(state, _player, input) {
    if (!input || typeof input !== 'object') return { ok: false, reason: 'Pick an option' };
    const answer = (input as { answer?: unknown }).answer;
    if (typeof answer !== 'string' || !optionIds(state.config).includes(answer)) {
      return { ok: false, reason: 'Pick one of the listed options' };
    }
    return { ok: true };
  },

  handleInput(state, player, input) {
    return { ...state, votes: { ...state.votes, [player.id]: input.answer } };
  },

  evaluate(state, submissions, ctx) {
    // onClose: every (latest) submission at once.
    const players = ctx.players();
    const c = state.config;
    const ids = optionIds(c);
    const valid = submissions.filter((s) => ids.includes(String(s.payload?.answer)));
    const votes = valid.map((s) => String(s.payload.answer));
    const counts = tally(c, votes);
    const total = votes.length;
    // Only options somebody actually chose can win (matters for minority mode).
    const chosen = ids.filter((id) => (counts[id] ?? 0) > 0);
    let winningIds: string[] = [];
    if (chosen.length) {
      const values = chosen.map((id) => counts[id] ?? 0);
      const target = c.mode === 'minority' ? Math.min(...values) : Math.max(...values);
      winningIds = chosen.filter((id) => counts[id] === target);
    }
    const rows: Row[] = valid
      .map((s) => {
        const vote = String(s.payload.answer);
        return { playerId: s.playerId, displayName: nameOf(players, s.playerId), vote, winner: winningIds.includes(vote) };
      })
      .sort((a, b) => Number(b.winner) - Number(a.winner) || a.vote.localeCompare(b.vote) || a.displayName.localeCompare(b.displayName));
    return { mode: c.mode, counts, total, winningIds, unanimous: total > 0 && chosen.length === 1, rows };
  },

  calculateScores(state, evaluation, ctx) {
    const roster = new Set(ctx.players().map((p) => p.id));
    const side = evaluation.mode === 'minority' ? 'minority' : 'majority';
    return evaluation.rows
      .filter((r) => roster.has(r.playerId))
      .map((r) => ({
        playerId: r.playerId,
        points: r.winner ? state.config.points : 0,
        reason: r.winner ? `With the ${side} (${r.vote})` : `Not with the ${side} (${r.vote})`,
      }));
  },

  getStatistics(state, evaluations) {
    const c = state.config;
    const evaluation = evaluations[0];
    if (!evaluation) return { question: c.question, mode: c.mode, votes: Object.keys(state.votes).length, closed: false };
    return {
      question: c.question,
      mode: evaluation.mode,
      closed: true,
      votes: evaluation.total,
      options: optionIds(c).map((id, i) => ({
        id,
        text: c.options[i] ?? '',
        count: evaluation.counts[id] ?? 0,
        percent: pct(evaluation.counts[id] ?? 0, evaluation.total),
        winner: evaluation.winningIds.includes(id),
      })),
      winning: evaluation.winningIds.map((id) => ({ id, text: optionText(c, id) })),
      tie: evaluation.winningIds.length > 1,
      unanimous: evaluation.unanimous,
      scorers: evaluation.rows.filter((r) => r.winner).length,
    };
  },

  introView(state) {
    const c = state.config;
    return ui.stack(
      [
        ui.text(`Pick one of ${c.options.length} options. Your vote is anonymous${c.timeLimit > 0 ? ` and you have ${c.timeLimit} seconds` : ''}.`),
        ui.caption(
          c.mode === 'minority'
            ? `Side with the least popular option to score ${c.points} points when the host closes the vote.`
            : `Side with the most popular option to score ${c.points} points when the host closes the vote.`,
        ),
      ],
      { gap: 'sm' },
    );
  },

  guestView(state, player) {
    const c = state.config;
    const mine = state.votes[player.id];
    const children: UINode[] = [
      ui.subtitle(c.question),
      ui.timer('lock'),
      ui.choices(
        'answer',
        c.options.map((text, i) => ({ id: letter(i), label: `${letter(i)}. ${text}` })),
        { submitOnSelect: true, columns: c.options.length > 4 ? 2 : 1, value: mine },
      ),
    ];
    return {
      ui: ui.stack(children, { gap: 'md' }),
      canSubmit: true,
      status: mine === undefined ? 'Your vote is anonymous' : `Voted ${mine} — tap another option to change`,
    };
  },

  mainView(state) {
    const c = state.config;
    const cast = Object.keys(state.votes).length;
    const children: UINode[] = [
      ui.title(c.question, { align: 'center' }),
      ui.caption(c.mode === 'minority' ? 'Side with the minority to score' : 'Side with the majority to score', { align: 'center' }),
    ];
    if (c.showLiveCounts) {
      // Aggregates only – individual votes are never shown (anonymous).
      const counts = tally(c, Object.values(state.votes));
      children.push(ui.barChart(optionIds(c).map((id) => ({ label: optionLabel(c, id), value: counts[id] ?? 0 }))));
    } else {
      children.push(
        ui.grid(
          2,
          c.options.map((text, i) => ui.card([ui.row([ui.badge(letter(i), 'primary'), ui.text(text)], { gap: 'sm', align: 'center' })])),
          { gap: 'md' },
        ),
      );
    }
    children.push(ui.badge(`${plural(cast, 'vote')} so far`, cast > 0 ? 'primary' : 'muted'));
    return ui.stack(children, { gap: 'lg', align: 'stretch' });
  },

  resultsView(state, evaluations) {
    const c = state.config;
    const evaluation = evaluations[0];
    if (!evaluation) return { ui: ui.caption('Waiting for the host to close the vote.') };
    const ids = optionIds(c);
    const side = evaluation.mode === 'minority' ? 'Minority' : 'Majority';
    const chart = ui.barChart(
      ids.map((id) => ({
        label: optionLabel(c, id),
        value: evaluation.counts[id] ?? 0,
        highlight: evaluation.winningIds.includes(id),
        tone: evaluation.winningIds.includes(id) ? 'success' : 'neutral',
      })),
      { percent: true },
    );
    const winnersBadge = evaluation.winningIds.length
      ? ui.badge(
          `${side}${evaluation.winningIds.length > 1 ? ' (tie)' : ''}: ${evaluation.winningIds.map((id) => optionLabel(c, id)).join(' · ')}`,
          'success',
        )
      : ui.badge('No votes were cast', 'muted');
    const scorers = evaluation.rows.filter((r) => r.winner);
    const shared = ui.stack(
      [
        ui.caption(c.question, { align: 'center' }),
        winnersBadge,
        chart,
        ui.row(
          [
            ui.badge(plural(evaluation.total, 'vote')),
            ui.badge(`${scorers.length} scored`, scorers.length ? 'success' : 'muted'),
            ...(evaluation.unanimous ? [ui.badge('Unanimous!', 'primary')] : []),
          ],
          { gap: 'sm', wrap: true, justify: 'center' },
        ),
        scorers.length ? ui.list(scorers.map((r) => ({ label: r.displayName, value: `+${c.points}`, tone: 'success' }))) : ui.spacer('sm'),
      ],
      { gap: 'md', align: 'stretch' },
    );
    return {
      ui: shared,
      guestUi: (player) => {
        const me = evaluation.rows.find((r) => r.playerId === player.id);
        const mine: UINode = !me
          ? ui.badge('You did not vote', 'muted')
          : ui.card(
              [
                ui.title(me.winner ? `With the ${side.toLowerCase()}!` : `Not with the ${side.toLowerCase()}`, {
                  tone: me.winner ? 'success' : 'danger',
                }),
                ui.text(`You voted ${optionLabel(c, me.vote)}`),
                ui.text(`${me.winner ? c.points : 0} points`, { tone: 'muted' }),
              ],
              me.winner ? 'success' : 'danger',
            );
        return ui.stack([ui.caption(c.question), winnersBadge, mine, chart], { gap: 'md' });
      },
    };
  },
});
