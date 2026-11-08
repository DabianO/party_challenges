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
import { defineModule, ui, type Manifest, type PlayerRef, type PresentationSlide, type Tone, type UINode } from '@challenge/contract';
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

  presentation(state, evaluations): PresentationSlide[] {
    // Step 1: when the room stopped the clock; step 2: the same, with the target on it and how
    // far off the room was. No names, points or ranks: only the room as a whole.
    if (evaluations.length === 0) return [];
    const goalMs = targetMs(state.config);
    const goal = goalMs / 1000;
    const stops = evaluations.map((e) => e.elapsedMs / 1000);
    const sorted = [...stops].sort((a, b) => a - b);
    const avgOff = Math.round(evaluations.reduce((a, e) => a + Math.abs(e.offMs), 0) / evaluations.length);
    const early = evaluations.filter((e) => e.offMs < 0).length;
    const late = evaluations.filter((e) => e.offMs > 0).length;
    const spotOn = evaluations.filter((e) => e.offMs === 0).length;
    // The target is no secret: the axis spans it from the start, so only the marker appears.
    const spread = spreadOf(stops, [goal], (n) => `${Number(n.toFixed(3))} s`);
    const summary = `${stops.length} ${stops.length === 1 ? 'stop' : 'stops'}`;
    const verdict = [`${early} early`, `${late} late`, ...(spotOn ? [`${spotOn} spot on`] : []), `on average ${avgOff < 1000 ? `${avgOff} ms` : secs(avgOff)} off`].join(' · ');
    const step = (reveal: boolean): UINode =>
      ui.stack(
        [
          ui.title(`Stop the clock at exactly ${secs(goalMs)}`, { align: 'center' }),
          ui.distribution(spread.columns, {
            axis: spread.axis,
            compact: spread.axis ? true : undefined,
            marker: reveal ? { at: spread.at(goal), label: `target ${secs(goalMs)}` } : undefined,
            highlight: reveal ? spread.indexOf(goal) : undefined,
          }),
          ui.grid(
            4,
            [
              stat('Earliest stop', secs(sorted[0]! * 1000)),
              stat('Middle stop', secs(medianOf(stops) * 1000)),
              stat('Latest stop', secs(sorted[sorted.length - 1]! * 1000)),
              stat('Target', secs(goalMs), reveal ? 'success' : 'primary'),
            ],
            { gap: 'md' },
          ),
          ui.caption(reveal ? `${summary} · ${verdict}` : summary, { align: 'center' }),
        ],
        { gap: 'md', align: 'stretch' },
      );
    return [{ steps: [step(false), step(true)], stepSeconds: 10 }];
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
