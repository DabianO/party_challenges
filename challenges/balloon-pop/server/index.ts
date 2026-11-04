/**
 * Balloon Pop (contract v2).
 *
 * While the challenge is open a balloon floats onto the big screen every few minutes
 * (`displayOverlay` with `ui.aimField`). There is one crosshair, shared by everyone who has the
 * challenge open: every arrow press on any phone (`ui.dPad`, live actions) moves it one step,
 * so presses add up (up + right goes diagonally, up + up twice as far). Whoever shoots first
 * while the crosshair is on the balloon pops it and scores; the next balloon comes one interval
 * later. The crosshair starts on its home base in the corner and stays wherever it is: players
 * can steer and shoot at any time (every shot flashes on the screen), but only a shot on a
 * balloon does anything. A miss at a balloon means a short reload for that player, so hammering
 * the button does not win.
 *
 * Timing is server-side: an instance timer `balloon` brings the next balloon (paused with the
 * game), `burst` clears the pop from the screen. Points are awarded when the host closes it.
 *
 * The field is 16 × 9 units (the big screen's shape), so a step is as long across as down.
 */
import { defineModule, ui, type Manifest, type PlayerRef, type PresentationSlide, type UINode } from '@challenge/contract';
import manifestJson from '../manifest.json' with { type: 'json' };
import schemaJson from '../config.schema.json' with { type: 'json' };

type Speed = 'slow' | 'normal' | 'fast';

interface Config {
  intervalMinutes?: number;
  pointsPerPop?: number;
  speed?: Speed;
}

interface Point {
  x: number;
  y: number;
}

interface Balloon extends Point {
  id: string;
  color: string;
  /** Server time it appeared. */
  since: number;
}

interface Popped {
  balloonId: string;
  playerId: string;
  displayName: string;
  /** How long the balloon was up, in ms. */
  ms: number;
}

interface State {
  config: Config;
  crosshair: Point;
  balloon: Balloon | null;
  /** Balloons so far (also names the next one). */
  spawned: number;
  popped: Popped[];
  /** The latest pop, on screen until the `burst` timer clears it. */
  burst: (Point & { id: string; text: string; color: string }) | null;
  /** playerId → server time until which their shots are blocked after a miss. */
  reload: Record<string, number>;
  /** Shots so far (names the latest one, so the screen flashes once per shot). */
  shots?: number;
  /** Where the latest shot went. */
  lastShot?: Point | null;
}

/** Live action payload: `{ aim: { move: [dx, dy] } }` or `{ aim: { fire: true } }`. */
type Aim = { move: [number, number] } | { fire: true };

interface Evaluation {
  pops: Record<string, number>;
  popped: Popped[];
}

const ACTION = 'aim';
const WIDTH = 16;
const HEIGHT = 9;
const HOME: Point = { x: 1, y: HEIGHT - 1 };
const HOME_SIZE = 1.3;
/** Balloon radius for hits; drawn slightly smaller than it counts. */
const RADIUS = 0.75;
const STEP: Record<Speed, number> = { slow: 0.25, normal: 0.4, fast: 0.65 };
/** A batch of presses from one phone moves at most this many steps (a phone sends every ~120 ms). */
const MAX_BATCH = 20;
const RELOAD_MS = 1500;
const BURST_SECONDS = 4;
const COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ec4899', '#14b8a6'];

function intervalSeconds(config: Config): number {
  const minutes = Number(config.intervalMinutes);
  return Math.round(Math.min(60, Math.max(0.5, Number.isFinite(minutes) ? minutes : 5)) * 60);
}

function stepOf(config: Config): number {
  return STEP[config.speed ?? 'normal'] ?? STEP.normal;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Is the crosshair on the balloon? */
export function onTarget(crosshair: Point, balloon: Point): boolean {
  return Math.hypot(crosshair.x - balloon.x, crosshair.y - balloon.y) <= RADIUS;
}

/** A spot for a new balloon: inside the field, clear of the top bar's corners and well away from home. */
export function spotFor(rng: () => number): Point {
  for (;;) {
    const p = { x: 2 + rng() * (WIDTH - 4), y: 2 + rng() * (HEIGHT - 3.2) };
    if (Math.hypot(p.x - HOME.x, p.y - HOME.y) >= 5) return p;
  }
}

function spawn(state: State, ctx: { rng(): number; now(): number }): State {
  const spot = spotFor(() => ctx.rng());
  const color = COLORS[Math.floor(ctx.rng() * COLORS.length)]!;
  return { ...state, balloon: { id: `b${state.spawned + 1}`, ...spot, color, since: ctx.now() }, spawned: state.spawned + 1 };
}

function aimOf(payload: unknown): Aim | null {
  const aim = payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[ACTION] : undefined;
  if (!aim || typeof aim !== 'object') return null;
  const { move, fire } = aim as { move?: unknown; fire?: unknown };
  if (fire === true) return { fire: true };
  if (Array.isArray(move) && move.length === 2 && move.every((n) => Number.isInteger(n) && Math.abs(n as number) <= MAX_BATCH)) return { move: move as [number, number] };
  return null;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function popsOf(state: State): Record<string, number> {
  const pops: Record<string, number> = {};
  for (const p of state.popped) pops[p.playerId] = (pops[p.playerId] ?? 0) + 1;
  return pops;
}

function seconds(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))} s`;
}

const INSTRUCTIONS = 'Look at the big screen. Everyone with this open steers the same crosshair: every press moves it a bit. Shoot when it is on the balloon; first shot wins. A miss means a short reload.';

export default defineModule<Config, State, Record<string, unknown>, Evaluation>({
  manifest: manifestJson as unknown as Manifest,
  configurationSchema: schemaJson,

  createInstance(config) {
    return { config, crosshair: { ...HOME }, balloon: null, spawned: 0, popped: [], burst: null, reload: {} };
  },

  onPhaseChange(state, phase, ctx) {
    // Opened (or reopened) without a balloon up: the next one comes one interval later.
    if (phase === 'ACTIVE' && !state.balloon) ctx.schedule('balloon', intervalSeconds(state.config));
    return state;
  },

  onTimer(state, tag, ctx) {
    if (tag === 'balloon') return state.balloon ? state : spawn(state, ctx);
    if (tag === 'burst') return { ...state, burst: null };
    return state;
  },

  // Shots and moves are live actions; there is nothing to submit.
  validateInput() {
    return { ok: false, reason: 'Use the arrows and the shoot button' };
  },

  handleInput(state) {
    return state;
  },

  validateAction(_state, _player, payload) {
    return aimOf(payload) ? { ok: true } : { ok: false, reason: 'Unknown action' };
  },

  onAction(state, player, payload, ctx) {
    const aim = aimOf(payload)!;
    const balloon = state.balloon;
    if ('move' in aim) {
      const step = stepOf(state.config);
      const crosshair = { x: clamp(state.crosshair.x + aim.move[0] * step, 0, WIDTH), y: clamp(state.crosshair.y + aim.move[1] * step, 0, HEIGHT) };
      return { ...state, crosshair };
    }
    const now = ctx.now();
    if ((state.reload[player.id] ?? 0) > now) return state;
    const shot = { ...state, shots: (state.shots ?? 0) + 1, lastShot: { ...state.crosshair } };
    // Nothing to hit: just the flash. A miss at a balloon costs a reload.
    if (!balloon) return shot;
    if (!onTarget(state.crosshair, balloon)) return { ...shot, reload: { ...state.reload, [player.id]: now + RELOAD_MS } };
    // Popped: the crosshair stays put and the next balloon comes one interval from now.
    ctx.schedule('balloon', intervalSeconds(state.config));
    ctx.schedule('burst', BURST_SECONDS);
    return {
      ...shot,
      balloon: null,
      popped: [...state.popped, { balloonId: balloon.id, playerId: player.id, displayName: player.displayName, ms: Math.max(0, now - balloon.since) }],
      burst: { id: balloon.id, x: balloon.x, y: balloon.y, text: `${player.displayName}!`, color: balloon.color },
      reload: {},
    };
  },

  playerNote(state, player) {
    const mine = popsOf(state)[player.id] ?? 0;
    return mine ? `You popped ${plural(mine, 'balloon')}` : null;
  },

  evaluate(state) {
    // Scored from state: pops are live actions.
    return { pops: popsOf(state), popped: state.popped };
  },

  calculateScores(state, evaluation) {
    const each = Math.max(0, state.config.pointsPerPop ?? 1);
    return Object.entries(evaluation.pops).map(([playerId, n]) => ({ playerId, points: n * each, reason: `Popped ${plural(n, 'balloon')}` }));
  },

  getStatistics(state, evaluations) {
    const popped = evaluations[0]?.popped ?? state.popped;
    return {
      balloons: state.spawned,
      popped: popped.length,
      shooters: new Set(popped.map((p) => p.playerId)).size,
      fastestMs: popped.length ? Math.min(...popped.map((p) => p.ms)) : null,
    };
  },

  introView(state) {
    const minutes = intervalSeconds(state.config) / 60;
    return ui.stack([ui.text(`A balloon floats onto the big screen every ${minutes === 1 ? 'minute' : `${minutes} minutes`}.`), ui.caption(INSTRUCTIONS)], { gap: 'sm' });
  },

  guestView(state, player, ctx) {
    const reloading = (state.reload[player.id] ?? 0) > ctx.now();
    const children: UINode[] = [];
    if (state.balloon) {
      children.push(ui.title('🎈 Balloon up!', { align: 'center' }), ui.caption(INSTRUCTIONS, { align: 'center' }));
    } else {
      children.push(ui.title('No balloon right now', { align: 'center' }), ui.timer('balloon', { label: 'Next balloon in' }), ui.caption('Keep this open, or come back when the big screen shows one. You can practise steering and shooting meanwhile.', { align: 'center' }));
    }
    children.push(ui.dPad(ACTION, { fireLabel: 'Shoot' }));
    const mine = popsOf(state)[player.id] ?? 0;
    return {
      ui: ui.stack(children, { gap: 'md', align: 'stretch' }),
      canSubmit: false,
      status: reloading ? 'Missed! Reloading…' : mine ? `You popped ${plural(mine, 'balloon')}` : state.balloon ? 'Steer together, shoot first' : 'Waiting for the next balloon',
    };
  },

  mainView(state) {
    return ui.caption(`${plural(state.popped.length, 'balloon')} popped so far`);
  },

  displayBanner(state) {
    return state.balloon ? '🎈 A balloon! Open it on your phone to aim and shoot' : null;
  },

  displayOverlay(state) {
    const at = (p: Point) => ({ x: p.x / WIDTH, y: p.y / HEIGHT });
    const targets = state.balloon ? [{ id: state.balloon.id, ...at(state.balloon), size: (2 * RADIUS) / WIDTH, color: state.balloon.color }] : [];
    const bursts = state.burst ? [{ id: state.burst.id, ...at(state.burst), text: state.burst.text, color: state.burst.color }] : [];
    const shot = state.lastShot ? { id: `s${state.shots ?? 0}`, ...at(state.lastShot) } : undefined;
    // Always there while open: the home base, and the crosshair wherever it was left.
    return ui.aimField(at(state.crosshair), { ...at(HOME), size: HOME_SIZE / WIDTH }, targets, bursts, shot);
  },

  presentation(state, evaluations): PresentationSlide[] {
    const popped = evaluations[0]?.popped ?? state.popped;
    if (state.spawned === 0) return [];
    if (popped.length === 0) return [{ steps: [ui.display(`🎈 ${plural(state.spawned, 'balloon')} floated by. Nobody popped one!`, { align: 'center' })] }];
    const fastest = popped.reduce((a, p) => (p.ms < a.ms ? p : a));
    const names = [...new Set(popped.map((p) => p.displayName))];
    return [
      {
        steps: [
          ui.stack(
            [
              ui.display(`🎈 ${plural(popped.length, 'balloon')} popped`, { align: 'center' }),
              ui.text(`Fastest: ${fastest.displayName}, ${seconds(fastest.ms)} after it appeared`, { align: 'center' }),
              ui.caption(`Popped by ${names.join(', ')}`, { align: 'center' }),
            ],
            { gap: 'md', align: 'stretch' },
          ),
        ],
      },
    ];
  },

  resultsView(state, evaluations) {
    const popped = evaluations[0]?.popped ?? state.popped;
    const pops = popsOf({ ...state, popped });
    const names = new Map(popped.map((p) => [p.playerId, p.displayName]));
    const rows = Object.entries(pops)
      .sort((a, b) => b[1] - a[1])
      .map(([id, n]) => ({ label: names.get(id) ?? 'Unknown', value: plural(n, 'balloon') }));
    const shared = ui.stack(
      [ui.caption(`${plural(popped.length, 'balloon')} popped of ${state.spawned}`, { align: 'center' }), rows.length ? ui.list(rows) : ui.badge('Nobody popped one', 'muted')],
      { gap: 'md', align: 'stretch' },
    );
    return {
      ui: shared,
      guestUi: (player: PlayerRef) => {
        const mine = pops[player.id] ?? 0;
        return ui.stack([ui.title(mine ? `You popped ${plural(mine, 'balloon')}!` : 'You did not pop one', { tone: mine ? 'success' : 'neutral' }), shared], { gap: 'md' });
      },
    };
  },
});
