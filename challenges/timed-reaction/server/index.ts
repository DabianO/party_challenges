/**
 * Timed Reaction (contract v2).
 *
 * Each player plays alone: when they press Start a per-player `go` timer is scheduled
 * with a random delay. When it fires their screen turns green and they tap as fast as
 * they can. Reaction time is measured from server timestamps only (SR-5) and scored on
 * an absolute scale, since players do not race each other any more.
 */
import { defineModule, ui, type Manifest, type PlayerRef, type UINode } from '@challenge/contract';
import manifestJson from '../manifest.json' with { type: 'json' };
import schemaJson from '../config.schema.json' with { type: 'json' };

interface Config {
  minDelaySeconds: number;
  maxDelaySeconds: number;
  windowSeconds: number;
  maxPoints: number;
  /** Reaction times up to this many ms earn maxPoints (absent before 2.3). */
  fullPointsMs?: number;
  /** Reaction times from this many ms on earn 0 points (absent before 2.3). */
  zeroPointsMs?: number;
  falseStartPenalty: number;
}

interface Tap {
  /** Server time of the tap (ctx.now() in handleInput). */
  tappedAt: number;
  /** True when the tap happened before this player's GO. */
  falseStart: boolean;
}

interface State {
  config: Config;
  /** playerId → server time their GO was shown. Absent until their `go` timer fires. */
  goAt: Record<string, number>;
  /** playerId → the player's single tap. */
  taps: Record<string, Tap>;
  /** playerId → outcome of their latest attempt, kept across replays (absent in pre-2.2 state). */
  last?: Record<string, number | 'false-start' | 'missed'>;
  /** playerId → their fastest valid reaction in ms, kept across replays. */
  best?: Record<string, number>;
}

interface Input {
  tap: true;
}

/** One evaluation per submission (results: immediate). */
interface Evaluation {
  playerId: string;
  displayName: string;
  /** Server-measured reaction time; null for false starts. */
  reactionMs: number | null;
  falseStart: boolean;
  points: number;
}

/** Defaults for instances created before 2.3, whose config has no timing scale. */
const FULL_POINTS_MS = 200;
const ZERO_POINTS_MS = 500;

function nameOf(players: PlayerRef[], id: string): string {
  return players.find((p) => p.id === id)?.displayName ?? 'Unknown';
}

function ms(n: number): string {
  return `${Math.round(n)} ms`;
}

/**
 * Absolute score in whole-point steps: `maxPoints` up to `fullPointsMs`, then one point less
 * for every equal slice of time, down to 0 from `zeroPointsMs` on. Never negative.
 */
function pointsFor(reactionMs: number, config: Config): number {
  const max = Math.max(0, Math.round(config.maxPoints));
  const fast = config.fullPointsMs ?? FULL_POINTS_MS;
  const slow = Math.max(fast + 1, config.zeroPointsMs ?? ZERO_POINTS_MS);
  if (max === 0 || reactionMs >= slow) return 0;
  if (reactionMs <= fast) return max;
  const step = (slow - fast) / max;
  return Math.min(max, Math.max(0, max - Math.floor((reactionMs - fast) / step)));
}

function penaltyOf(config: Config): number {
  return Math.max(0, config.falseStartPenalty ?? 0);
}

const INSTRUCTION = 'Tap as fast as you can when the screen turns green';

export default defineModule<Config, State, Input, Evaluation>({
  manifest: manifestJson as unknown as Manifest,
  configurationSchema: schemaJson,

  createInstance(config) {
    return { config, goAt: {}, taps: {} };
  },

  onAttemptStart(state, player, ctx) {
    const c = state.config;
    const lo = Math.min(c.minDelaySeconds, c.maxDelaySeconds);
    const hi = Math.max(c.minDelaySeconds, c.maxDelaySeconds);
    // The pending delay is deliberately not stored in state so no view can leak it.
    // There is no `lock` yet: it is scheduled once GO fires, so the tap window is fair.
    ctx.schedule('go', lo + ctx.rng() * (hi - lo), player.id);
    // A replay starts from "Wait…" again: forget the previous GO and tap.
    const { [player.id]: _go, ...goAt } = state.goAt;
    const { [player.id]: _tap, ...taps } = state.taps;
    return { ...state, goAt, taps };
  },

  onTimer(state, tag, ctx, playerId) {
    if (tag === 'go' && playerId && state.goAt[playerId] === undefined && !state.taps[playerId]) {
      ctx.schedule('lock', state.config.windowSeconds, playerId);
      ctx.emit(`player:${playerId}`, { go: true });
      return { ...state, goAt: { ...state.goAt, [playerId]: ctx.now() } };
    }
    return state;
  },

  validateInput(state, player, input) {
    if (!input || typeof input !== 'object' || (input as { tap?: unknown }).tap !== true) {
      return { ok: false, reason: 'Tap the button' };
    }
    // A tap before GO is accepted: it is a false start and uses up the single submission.
    if (state.taps[player.id]) return { ok: false, reason: 'You already tapped' };
    return { ok: true };
  },

  handleInput(state, player, _input, ctx) {
    const goAt = state.goAt[player.id];
    const now = ctx.now();
    const falseStart = goAt === undefined || now < goAt;
    const reaction = falseStart ? null : now - (goAt as number);
    const best = state.best ?? {};
    const prevBest = best[player.id];
    return {
      ...state,
      taps: { ...state.taps, [player.id]: { tappedAt: now, falseStart } },
      // Practice feedback (playerNote): the latest outcome and the fastest time so far.
      last: { ...(state.last ?? {}), [player.id]: reaction ?? 'false-start' },
      best: reaction !== null && (prevBest === undefined || reaction < prevBest) ? { ...best, [player.id]: reaction } : best,
    };
  },

  onAttemptLocked(state, player) {
    // Locked without a tap: the tap window ran out.
    if (state.taps[player.id]) return state;
    return { ...state, last: { ...(state.last ?? {}), [player.id]: 'missed' } };
  },

  playerNote(state, player) {
    const last = state.last?.[player.id];
    if (last === undefined) return null;
    const best = state.best?.[player.id];
    const lastText = last === 'false-start' ? 'False start' : last === 'missed' ? 'Too late' : ms(last);
    return best === undefined ? lastText : `${lastText} · best ${ms(best)}`;
  },

  evaluate(state, submissions, ctx) {
    // Immediate results: exactly one submission (this player's single tap).
    const s = submissions[0]!;
    const goAt = state.goAt[s.playerId];
    // Server timestamps only (SR-5): a false start when GO had not happened yet.
    const falseStart = goAt === undefined || s.submittedAt < goAt;
    const reactionMs = falseStart ? null : Math.max(0, s.submittedAt - (goAt as number));
    const penalty = penaltyOf(state.config);
    const points = reactionMs === null ? (penalty > 0 ? -penalty : 0) : pointsFor(reactionMs, state.config);
    return { playerId: s.playerId, displayName: nameOf(ctx.players(), s.playerId), reactionMs, falseStart, points };
  },

  calculateScores(state, evaluation) {
    if (evaluation.reactionMs === null) {
      const penalty = penaltyOf(state.config);
      // False starts: 0 when no penalty is configured, otherwise a negative award.
      return [{ playerId: evaluation.playerId, points: evaluation.points, reason: penalty > 0 ? `False start (-${penalty} penalty)` : 'False start' }];
    }
    return [{ playerId: evaluation.playerId, points: evaluation.points, reason: `Reacted in ${ms(evaluation.reactionMs)}` }];
  },

  getStatistics(_state, evaluations) {
    const valid = evaluations.filter((e) => e.reactionMs !== null);
    const times = valid.map((e) => e.reactionMs as number);
    const n = times.length;
    const sorted = [...times].sort((a, b) => a - b);
    const mean = n ? times.reduce((a, b) => a + b, 0) / n : null;
    const mid = Math.floor(n / 2);
    const median = n ? (n % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2) : null;
    const stdDev = n && mean !== null ? Math.sqrt(times.reduce((a, t) => a + (t - mean) ** 2, 0) / n) : null;
    const fastest = [...valid].sort((a, b) => (a.reactionMs as number) - (b.reactionMs as number))[0];
    return {
      taps: evaluations.length,
      validTaps: n,
      falseStarts: evaluations.filter((e) => e.falseStart).length,
      fastestMs: n ? sorted[0] : null,
      slowestMs: n ? sorted[n - 1] : null,
      averageMs: mean === null ? null : Math.round(mean),
      medianMs: median === null ? null : Math.round(median),
      stdDevMs: stdDev === null ? null : Math.round(stdDev),
      fastest: fastest ? { name: fastest.displayName, ms: fastest.reactionMs } : null,
    };
  },

  introView(state) {
    const c = state.config;
    const penalty = penaltyOf(c);
    return ui.stack(
      [
        ui.text(`${INSTRUCTION}. The wait is random, so keep your eyes on the screen.`),
        ui.caption(
          `${c.maxPoints} points for a lightning-fast tap, fewer the slower you are, 0 from ${ms(c.zeroPointsMs ?? ZERO_POINTS_MS)}. Tapping before green is a false start${penalty > 0 ? ` (-${penalty} points)` : ''}.`,
        ),
      ],
      { gap: 'sm' },
    );
  },

  guestView(state, player) {
    const mine = state.taps[player.id];
    const goAt = state.goAt[player.id];
    if (mine) {
      const node: UINode = mine.falseStart
        ? ui.card([ui.display('False start!'), ui.caption('You tapped before GO', { align: 'center' })], 'danger')
        : ui.card([ui.display(goAt === undefined ? 'Tapped' : ms(mine.tappedAt - goAt)), ui.caption('Your reaction time', { align: 'center' })], 'primary');
      return { ui: node, canSubmit: false, status: mine.falseStart ? 'False start' : 'Tapped!' };
    }
    const waiting = goAt === undefined;
    const button = ui.submit('TAP', { payload: { tap: true }, size: 'huge', tone: waiting ? 'danger' : 'success' });
    // Before GO: no timer and nothing that hints at when GO will come.
    const card = waiting ? ui.card([ui.display('Wait…')], 'danger') : ui.card([ui.display('TAP NOW!'), ui.timer('lock', { size: 'sm' })], 'success');
    return { ui: ui.stack([card, button], { gap: 'lg', align: 'stretch' }), canSubmit: true, status: waiting ? 'Wait for green…' : 'GO!' };
  },

  mainView() {
    return ui.caption(`${INSTRUCTION}. Tapping too early is a false start!`);
  },

  resultsView(state, evaluations) {
    const valid = [...evaluations].filter((e) => e.reactionMs !== null).sort((a, b) => (a.reactionMs as number) - (b.reactionMs as number));
    const falseStarts = evaluations.filter((e) => e.falseStart);
    const times = valid.map((e) => e.reactionMs as number);
    const avg = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null;
    const rankOf = (id: string): number => valid.findIndex((e) => e.playerId === id) + 1;
    const ranking = ui.ranking([
      ...valid.map((e, i) => ({ rank: i + 1, name: e.displayName, value: ms(e.reactionMs as number), points: e.points, highlight: i === 0 })),
      ...falseStarts.map((e) => ({ rank: valid.length + 1, name: e.displayName, value: 'False start', points: e.points })),
    ]);
    const badges = ui.row(
      [
        ui.badge(times.length ? `Fastest ${ms(times[0]!)}` : 'No valid taps yet', times.length ? 'success' : 'muted'),
        ui.badge(avg === null ? 'Average –' : `Average ${ms(avg)}`),
        ui.badge(`${falseStarts.length} false start${falseStarts.length === 1 ? '' : 's'}`, falseStarts.length ? 'danger' : 'neutral'),
      ],
      { gap: 'sm', wrap: true, justify: 'center' },
    );
    const shared = ui.stack([ui.title('Reaction times', { align: 'center' }), ranking, badges], { gap: 'md', align: 'stretch' });
    return {
      ui: shared,
      guestUi: (player) => {
        const me = evaluations.find((e) => e.playerId === player.id);
        const mine: UINode = !me
          ? ui.badge('You did not tap', 'muted')
          : me.reactionMs === null
            ? ui.card([ui.title('False start!', { tone: 'danger' }), ui.text('You tapped before GO'), ui.text(`${me.points} points`, { tone: 'muted' })], 'danger')
            : ui.card(
                [
                  ui.display(ms(me.reactionMs)),
                  ui.text(`${me.points} of ${state.config.maxPoints} points · #${rankOf(me.playerId)} of ${valid.length} so far`, { tone: 'muted' }),
                ],
                rankOf(me.playerId) === 1 ? 'success' : 'primary',
              );
        return ui.stack(
          [
            mine,
            ui.ranking(
              valid.slice(0, 5).map((e, i) => ({ rank: i + 1, name: e.displayName, value: ms(e.reactionMs as number), points: e.points, highlight: e.playerId === player.id })),
            ),
            badges,
          ],
          { gap: 'md' },
        );
      },
    };
  },
});
