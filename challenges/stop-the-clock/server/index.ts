/**
 * Stop the Clock (contract v2).
 *
 * The player starts a stopwatch and tries to stop it at exactly `targetSeconds`, watching the
 * running time all the way: it is all about milliseconds. (Time Estimation is the version
 * without a clock.) Games made before 1.1 may still carry `hideAfterSeconds`: it is ignored.
 *
 * Unlike Timed Reaction, the time is measured on the phone (`ui.stopwatch`): both taps are
 * timed by the same device clock, so Wi-Fi delay does not count and results are accurate to
 * the millisecond. The server still checks the phone's time against its own measurement
 * (start action → submission); when they disagree by more than `TRUST_MS` (a phone that slept,
 * or a tampered payload) the server's time is used instead.
 */
import { defineModule, ui, type Manifest, type PlayerRef, type UINode } from '@challenge/contract';
import manifestJson from '../manifest.json' with { type: 'json' };
import schemaJson from '../config.schema.json' with { type: 'json' };

interface Config {
  targetSeconds: number;
  /** No longer used (the clock is always visible since 1.1). */
  hideAfterSeconds?: number;
  maxPoints: number;
  fullPointsMs: number;
  zeroPointsMs: number;
}

interface State {
  config: Config;
  /** playerId → server time of their latest Start tap (the stopwatch's live action). */
  startedAt: Record<string, number>;
  /** playerId → their latest stopped time in ms, kept across replays. */
  last: Record<string, number>;
  /** playerId → their stop closest to the target so far, in ms. */
  best: Record<string, number>;
}

interface Input {
  clock: number;
}

/** One evaluation per stop (results: immediate). */
interface Evaluation {
  playerId: string;
  displayName: string;
  /** The time that counts. */
  elapsedMs: number;
  /** elapsedMs − target: negative = early, positive = late. */
  offMs: number;
  /** `server` when the phone's time was implausible and the server's measurement was used. */
  measuredBy: 'device' | 'server';
  points: number;
}

/** Payload key of the stopwatch (start action and submitted time). */
const CLOCK = 'clock';
/** How far the phone's time may differ from the server's (network jitter on two messages). */
const TRUST_MS = 750;
/** Longest run accepted, in ms. */
const MAX_MS = 60 * 60 * 1000;

function nameOf(players: PlayerRef[], id: string): string {
  return players.find((p) => p.id === id)?.displayName ?? 'Unknown';
}

function targetMs(config: Config): number {
  return Math.round(config.targetSeconds * 1000);
}

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(3)} s`;
}

/** "12 ms late", "1.250 s early", "spot on!". */
function offText(offMs: number): string {
  if (offMs === 0) return 'spot on!';
  const size = Math.abs(offMs);
  return `${size < 1000 ? `${size} ms` : secs(size)} ${offMs < 0 ? 'early' : 'late'}`;
}

/** Whole-point steps: the maximum within `fullPointsMs`, one less per equal step, 0 from `zeroPointsMs`. */
function pointsFor(offMs: number, config: Config): number {
  const max = Math.max(0, Math.round(config.maxPoints));
  const off = Math.abs(offMs);
  const full = Math.max(0, config.fullPointsMs);
  const zero = Math.max(full + 1, config.zeroPointsMs);
  if (max === 0 || off >= zero) return 0;
  if (off <= full) return max;
  const step = (zero - full) / max;
  return Math.min(max, Math.max(0, max - Math.floor((off - full) / step)));
}

export default defineModule<Config, State, Input, Evaluation>({
  manifest: manifestJson as unknown as Manifest,
  configurationSchema: schemaJson,

  createInstance(config) {
    return { config, startedAt: {}, last: {}, best: {} };
  },

  onAttemptStart(state, player) {
    // A replay starts from a fresh stopwatch.
    const { [player.id]: _start, ...startedAt } = state.startedAt;
    return { ...state, startedAt };
  },

  validateAction(_state, _player, payload) {
    const value = payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[CLOCK] : undefined;
    return value === 'start' ? { ok: true } : { ok: false, reason: 'Unknown action' };
  },

  onAction(state, player, _payload, ctx) {
    // Starting again (the page reloaded mid-run) restarts the server's measurement too.
    return { ...state, startedAt: { ...state.startedAt, [player.id]: ctx.now() } };
  },

  validateInput(_state, _player, input) {
    const ms = input && typeof input === 'object' ? (input as { clock?: unknown }).clock : undefined;
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > MAX_MS) return { ok: false, reason: 'Start the clock, then stop it' };
    return { ok: true };
  },

  handleInput(state, player, input) {
    const ms = Math.round(input.clock);
    const target = targetMs(state.config);
    const prev = state.best[player.id];
    const better = prev === undefined || Math.abs(ms - target) < Math.abs(prev - target);
    // Practice feedback (playerNote); the evaluation decides what counts.
    return { ...state, last: { ...state.last, [player.id]: ms }, best: better ? { ...state.best, [player.id]: ms } : state.best };
  },

  playerNote(state, player) {
    const last = state.last[player.id];
    if (last === undefined) return null;
    const target = targetMs(state.config);
    const best = state.best[player.id];
    const text = `${secs(last)} · ${offText(last - target)}`;
    return best !== undefined && best !== last ? `${text} · best ${offText(best - target)}` : text;
  },

  evaluate(state, submissions, ctx) {
    // Immediate results: exactly one submission, this player's stop.
    const s = submissions[0]!;
    const device = Math.round(s.payload.clock);
    // The server's own view: from the Start tap (or the attempt start if that never arrived).
    const serverMs = s.submittedAt - (state.startedAt[s.playerId] ?? s.startedAt);
    const trusted = Math.abs(device - serverMs) <= TRUST_MS;
    const elapsedMs = trusted ? device : Math.max(0, Math.round(serverMs));
    const offMs = elapsedMs - targetMs(state.config);
    return {
      playerId: s.playerId,
      displayName: nameOf(ctx.players(), s.playerId),
      elapsedMs,
      offMs,
      measuredBy: trusted ? 'device' : 'server',
      points: pointsFor(offMs, state.config),
    };
  },

  calculateScores(_state, evaluation) {
    const how = evaluation.measuredBy === 'server' ? ' (timed by the server)' : '';
    return [{ playerId: evaluation.playerId, points: evaluation.points, reason: `Stopped at ${secs(evaluation.elapsedMs)}, ${offText(evaluation.offMs)}${how}` }];
  },

  getStatistics(_state, evaluations) {
    const offs = evaluations.map((e) => Math.abs(e.offMs));
    const closest = [...evaluations].sort((a, b) => Math.abs(a.offMs) - Math.abs(b.offMs))[0];
    return {
      stops: evaluations.length,
      early: evaluations.filter((e) => e.offMs < 0).length,
      late: evaluations.filter((e) => e.offMs > 0).length,
      averageOffMs: offs.length ? Math.round(offs.reduce((a, b) => a + b, 0) / offs.length) : null,
      closest: closest ? { name: closest.displayName, offMs: closest.offMs } : null,
      timedByServer: evaluations.filter((e) => e.measuredBy === 'server').length,
    };
  },

  introView(state) {
    const c = state.config;
    return ui.stack(
      [
        ui.text(`Start the stopwatch and stop it at exactly ${secs(targetMs(c))}.`),
        ui.caption(`You can see the clock all the way: it is all about milliseconds. ${c.maxPoints} points within ${c.fullPointsMs} ms, fewer the further off you are.`),
      ],
      { gap: 'sm' },
    );
  },

  guestView(state) {
    const c = state.config;
    return {
      ui: ui.stack(
        [
          ui.card([ui.caption('Stop the clock at exactly', { align: 'center' }), ui.display(secs(targetMs(c)))], 'primary'),
          ui.stopwatch(CLOCK),
        ],
        { gap: 'lg', align: 'stretch' },
      ),
      canSubmit: true,
      status: 'Tap START, then STOP at the target time',
    };
  },

  mainView(state) {
    return ui.caption(`Stop the clock at exactly ${secs(targetMs(state.config))}, to the millisecond!`);
  },

  resultsView(state, evaluations) {
    const sorted = [...evaluations].sort((a, b) => Math.abs(a.offMs) - Math.abs(b.offMs));
    const offs = sorted.map((e) => Math.abs(e.offMs));
    const avg = offs.length ? Math.round(offs.reduce((a, b) => a + b, 0) / offs.length) : null;
    const rankOf = (id: string): number => sorted.findIndex((e) => e.playerId === id) + 1;
    const ranking = ui.ranking(sorted.map((e, i) => ({ rank: i + 1, name: e.displayName, value: `${secs(e.elapsedMs)} · ${offText(e.offMs)}`, points: e.points, highlight: i === 0 })));
    const badges = ui.row(
      [
        ui.badge(sorted.length ? `Closest ${offText(sorted[0]!.offMs)}` : 'Nobody stopped the clock yet', sorted.length ? 'success' : 'muted'),
        ui.badge(avg === null ? 'Average –' : `Average ${avg < 1000 ? `${avg} ms` : secs(avg)} off`),
        ui.badge(`${evaluations.filter((e) => e.offMs < 0).length} early · ${evaluations.filter((e) => e.offMs > 0).length} late`),
      ],
      { gap: 'sm', wrap: true, justify: 'center' },
    );
    const shared = ui.stack([ui.title(`Target ${secs(targetMs(state.config))}`, { align: 'center' }), ranking, badges], { gap: 'md', align: 'stretch' });
    return {
      ui: shared,
      guestUi: (player) => {
        const me = evaluations.find((e) => e.playerId === player.id);
        const mine: UINode = me
          ? ui.card(
              [
                ui.display(secs(me.elapsedMs)),
                ui.text(offText(me.offMs)),
                ui.text(`${me.points} of ${state.config.maxPoints} points · #${rankOf(me.playerId)} of ${sorted.length} so far`, { tone: 'muted' }),
              ],
              rankOf(me.playerId) === 1 ? 'success' : 'primary',
            )
          : ui.badge('You did not stop the clock', 'muted');
        return ui.stack(
          [
            mine,
            ui.ranking(sorted.slice(0, 5).map((e, i) => ({ rank: i + 1, name: e.displayName, value: offText(e.offMs), points: e.points, highlight: e.playerId === player.id }))),
            badges,
          ],
          { gap: 'md' },
        );
      },
    };
  },
});
