/**
 * Blob War (contract v2).
 *
 * The room is a grid of territory (`territory.ts`) shown on the big screen (`displayPanel`
 * → `blob-field`). Every player owns a soft blob that starts as a small circle; tapping the
 * phone's pump (`tap-pad` → live actions, `onAction`) makes it grow outward evenly, keeping
 * whatever shape it has. A blob never grows beyond `maxShare` of the room.
 *
 * It is a fight: a blob that pumps clearly more than its neighbour *right now* (taps with a
 * short half-life, `activity`) pushes into it, even when the room is full. The neighbour gives
 * way into open space if it can, or shrinks, but never below `MIN_SHARE`. Blobs whose players
 * stop pumping lose ground; players have to keep coming back to hold or win territory.
 *
 * A newcomer (`onPlayerJoin`) appears in the emptiest spot and clears a circle the size of
 * the largest blob allowed. The blobs that were there are cut off by that circle and grow on
 * from their dented shape; the cleared room goes to whoever pumps first.
 *
 * When the host closes the challenge (or ends the game) the territory freezes, the field turns
 * into its final picture and points go out in proportion to territory (biggest = `points`).
 *
 * v1.1 replaced the round, floating blobs of v1.0; v1.2 added shape-keeping growth (`sources`)
 * and fights by activity; v1.3 keeps every blob one visible piece. Older state is upgraded on
 * first use.
 */
import { blobCells, defineModule, playerColor, ui, type BlobFieldNode, type InstanceContext, type Manifest, type PlayerRef, type PresentationSlide } from '@challenge/contract';
import manifestJson from '../manifest.json' with { type: 'json' };
import schemaJson from '../config.schema.json' with { type: 'json' };
import {
  COLS,
  MIN_CELLS,
  MIN_SHARE,
  ROWS,
  SEED_RADIUS,
  TOTAL,
  areasOf,
  emptyOwners,
  fieldOf,
  grow,
  releaseAbsent,
  tidy,
  seededRng,
  spawn,
  type Field,
  type Owners,
} from './territory.ts';

interface Config {
  points: number;
  tapsToMax: number;
  maxShare: number;
}

interface State {
  config: Config;
  /** playerId → colour slot (also the owner code in the grid), given once and never reused. */
  colors: Record<string, number>;
  nextColor: number;
  /** playerId → taps in total (pulse animation, statistics). */
  taps: Record<string, number>;
  /** The territory, `blobCells`-encoded, row-major COLS × ROWS. */
  cells: string;
  /** Per cell, the point its growth is measured from (`encodeSources`). */
  sources: string;
  /** Slots that lost ground since they last grew. */
  dented: number[];
  /** playerId → recent pumping: taps decaying with ACTIVITY_HALF_LIFE, as of `at`. */
  activity: Record<string, { value: number; at: number }>;
  /** playerId → fraction of a cell pumped but not yet claimed. */
  growth: Record<string, number>;
  /** The territory is frozen once the challenge closes. */
  closed: boolean;
}

/** v1.1 state: territory without sources or activity. */
type StateV11 = Omit<State, 'sources' | 'dented' | 'activity'>;

/** v1.0 state: round blobs sized from pumped "air". */
interface LegacyState {
  config: Config & { leakPerMinute?: number };
  colors: Record<string, number>;
  nextColor: number;
  taps: Record<string, number>;
  air?: Record<string, { value: number; at: number }>;
  frozen?: Record<string, number> | null;
}

/** One batch of taps from the phone's pump. */
interface Action {
  pump: number;
}

interface Evaluation {
  shares: { playerId: string; displayName: string; share: number; taps: number }[];
}

const MAX_TAPS_PER_BATCH = 60;
/** Cells in a fresh blob: a disc of the minimum size (nobody is ever pushed below it either). */
export const SEED_CELLS = Math.round(Math.PI * SEED_RADIUS * SEED_RADIUS);
export { MIN_CELLS, MIN_SHARE };
/** Pumping counts for the fight with this half-life (ms): stop pumping and you weaken fast. */
export const ACTIVITY_HALF_LIFE = 6000;

/** Fallback colour for a slot when the platform gives none: the platform's own player palette. */
export const colorFor = playerColor;

export const maxCellsOf = (config: Config) => Math.max(SEED_CELLS + 1, Math.round(Math.min(0.5, Math.max(0.05, config.maxShare)) * TOTAL));
/** Radius of the circle a newcomer clears: the size of the largest blob allowed. */
export const clearRadiusOf = (config: Config) => Math.sqrt(maxCellsOf(config) / Math.PI);
const cellsPerTap = (config: Config) => (maxCellsOf(config) - SEED_CELLS) / Math.max(1, config.tapsToMax);

export function decode(cells: string): Owners {
  const owners = emptyOwners();
  for (let i = 0; i < TOTAL && i < cells.length; i++) owners[i] = blobCells.decode(cells[i]!);
  return owners;
}

export function encode(owners: Owners): string {
  let out = '';
  for (let i = 0; i < TOTAL; i++) out += owners[i] === -1 ? blobCells.EMPTY : blobCells.encode(owners[i]!);
  return out;
}

/** Two printable characters per cell index (no quote or backslash, so JSON stays compact). */
const DIGITS = Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)).filter((ch) => ch !== '"' && ch !== '\\');
const BASE = DIGITS.length;
const DIGIT_VALUE = new Int16Array(128).fill(-1);
DIGITS.forEach((ch, i) => (DIGIT_VALUE[ch.charCodeAt(0)] = i));

export function encodeSources(sources: Int32Array): string {
  let out = '';
  for (let i = 0; i < TOTAL; i++) {
    const v = sources[i]!;
    out += DIGITS[Math.floor(v / BASE)]! + DIGITS[v % BASE]!;
  }
  return out;
}

export function decodeSources(text: string): Int32Array {
  const out = new Int32Array(TOTAL);
  for (let i = 0; i < TOTAL; i++) {
    const hi = DIGIT_VALUE[text.charCodeAt(2 * i) & 127] ?? -1;
    const lo = DIGIT_VALUE[text.charCodeAt(2 * i + 1) & 127] ?? -1;
    const v = hi < 0 || lo < 0 ? i : hi * BASE + lo;
    out[i] = v < TOTAL ? v : i;
  }
  return out;
}

const fieldFrom = (state: State): Field => fieldOf(decode(state.cells), decodeSources(state.sources), state.dented);

const withField = (state: State, field: Field): State => ({
  ...state,
  cells: encode(field.owners),
  sources: encodeSources(field.sources),
  dented: [...field.dented].sort((a, b) => a - b),
});

function withColor(state: State, playerId: string): State {
  if (state.colors[playerId] !== undefined) return state;
  return { ...state, colors: { ...state.colors, [playerId]: state.nextColor }, nextColor: state.nextColor + 1 };
}

/** A player's pumping as of `now`, decayed. */
export function activityOf(state: State, playerId: string, now: number): number {
  const a = state.activity[playerId];
  if (!a) return 0;
  return a.value * Math.pow(0.5, Math.max(0, now - a.at) / ACTIVITY_HALF_LIFE);
}

function strengthOf(state: State, now: number): (slot: number) => number {
  const bySlot = new Map(Object.entries(state.colors).map(([id, slot]) => [slot, id] as const));
  return (slot) => {
    const id = bySlot.get(slot);
    return id === undefined ? 0 : activityOf(state, id, now);
  };
}

/**
 * Upgrade older state. v1.0 (round blobs): lay them out on the grid in colour order at their
 * old sizes. v1.1: add growth sources (every blob grows from its current shape) and activity.
 * Pure (fixed seed), so views can call it too.
 */
/** The grid before 1.4: 112 × 70 cells. */
const V13 = { cols: 112, rows: 70 };

/**
 * Territory from the 1.3 grid on the wider 1.4 grid: every shape scaled down evenly (so blobs
 * stay round) and centred, which leaves open room at the sides to grow into. Blobs then grow
 * from their shapes as they are; any blob that came out below the minimum grows back to it.
 */
function widen(state: State): State {
  const old = new Int16Array(V13.cols * V13.rows).fill(-1);
  for (let i = 0; i < old.length; i++) old[i] = blobCells.decode(state.cells[i] ?? blobCells.EMPTY);
  const scale = Math.min(COLS / V13.cols, ROWS / V13.rows);
  const x0 = (COLS - V13.cols * scale) / 2;
  const y0 = (ROWS - V13.rows * scale) / 2;
  const owners = emptyOwners();
  for (let y = 0; y < ROWS; y++) {
    const oy = Math.floor((y + 0.5 - y0) / scale);
    if (oy < 0 || oy >= V13.rows) continue;
    for (let x = 0; x < COLS; x++) {
      const ox = Math.floor((x + 0.5 - x0) / scale);
      if (ox >= 0 && ox < V13.cols) owners[y * COLS + x] = old[oy * V13.cols + ox]!;
    }
  }
  const field = fieldOf(owners);
  tidy(field);
  const rng = seededRng(4231);
  for (const [slot, area] of areasOf(field.owners)) {
    if (area < MIN_CELLS) grow(field, slot, MIN_CELLS - area, { maxCells: maxCellsOf(state.config), rng });
  }
  return withField(state, field);
}

export function upgrade(raw: State | StateV11 | LegacyState, players: PlayerRef[]): State {
  if (typeof (raw as State).sources === 'string') {
    const state = raw as State;
    return state.cells.length === V13.cols * V13.rows && TOTAL !== V13.cols * V13.rows ? widen(state) : state;
  }
  if (typeof (raw as StateV11).cells === 'string') {
    const v11 = raw as StateV11;
    return withField({ ...v11, sources: '', dented: [], activity: {} }, fieldOf(decode(v11.cells)));
  }
  const old = raw as LegacyState;
  const config = { points: old.config.points, tapsToMax: old.config.tapsToMax, maxShare: old.config.maxShare };
  const field = fieldOf(emptyOwners());
  const rng = seededRng(7919);
  const cap = Math.max(0.006, config.maxShare);
  const wanted = (id: string) => 0.006 + (cap - 0.006) * Math.min(1, (old.air?.[id]?.value ?? 0) / Math.max(1, config.tapsToMax));
  const total = players.reduce((a, p) => a + wanted(p.id), 0);
  const scale = total > 0.8 ? 0.8 / total : 1;
  const ordered = players.filter((p) => old.colors[p.id] !== undefined).sort((a, b) => old.colors[a.id]! - old.colors[b.id]!);
  for (const p of ordered) spawn(field, old.colors[p.id]!, rng, 0);
  for (const p of ordered) {
    const share = old.frozen?.[p.id] ?? wanted(p.id) * scale;
    grow(field, old.colors[p.id]!, Math.round(share * TOTAL) - SEED_CELLS, { maxCells: maxCellsOf(config), rng });
  }
  const state: State = {
    config,
    colors: old.colors,
    nextColor: old.nextColor,
    taps: old.taps ?? {},
    cells: '',
    sources: '',
    dented: [],
    activity: {},
    growth: {},
    closed: Boolean(old.frozen),
  };
  return withField(state, field);
}

/**
 * Make room in `field` for players without territory (`clear`: a newcomer clears its full-size
 * circle); territory of players who left becomes open space. Returns the state with colours.
 */
function placeIn(field: Field, state: State, players: PlayerRef[], ids: string[], rng: () => number, clear: boolean): State {
  let next = state;
  for (const id of ids) next = withColor(next, id);
  releaseAbsent(field.owners, new Set(players.map((p) => next.colors[p.id]!).filter((s) => s !== undefined)));
  const areas = areasOf(field.owners);
  for (const id of ids) {
    const slot = next.colors[id]!;
    if ((areas.get(slot) ?? 0) === 0) spawn(field, slot, rng, clear ? clearRadiusOf(next.config) : 0);
  }
  return next;
}

function place(state: State, players: PlayerRef[], ids: string[], rng: () => number, clear: boolean): State {
  const field = fieldFrom(state);
  return withField(placeIn(field, state, players, ids, rng, clear), field);
}

function sharesOf(state: State, players: PlayerRef[]): Map<string, number> {
  const areas = areasOf(decode(state.cells));
  return new Map(players.map((p) => [p.id, state.colors[p.id] === undefined ? 0 : (areas.get(state.colors[p.id]!) ?? 0) / TOTAL] as const));
}

const pct = (share: number) => `${Math.round(share * 1000) / 10}%`;

function standings(state: State, players: PlayerRef[]): Evaluation['shares'] {
  const shares = sharesOf(state, players);
  return players
    .map((p) => ({ playerId: p.id, displayName: p.displayName, share: shares.get(p.id) ?? 0, taps: state.taps[p.id] ?? 0 }))
    .sort((a, b) => b.share - a.share || a.displayName.localeCompare(b.displayName));
}

/** The room as a blob field: live while open, the closing picture once closed. */
function blobFieldOf(raw: State, ctx: InstanceContext): BlobFieldNode {
  const players = ctx.players();
  const state = upgrade(raw, players);
  const owners = decode(state.cells);
  // Territory of players who left is shown as open space.
  const present = new Set(players.map((p) => state.colors[p.id]).filter((s): s is number => s !== undefined));
  releaseAbsent(owners, present);
  const areas = areasOf(owners);
  return ui.blobField(
    ctx.instanceId,
    state.closed ? 'final' : 'live',
    { cols: COLS, rows: ROWS, cells: encode(owners) },
    players
      .filter((p) => state.colors[p.id] !== undefined)
      .map((p) => {
        const slot = state.colors[p.id]!;
        // The player's own colour, the same as in the graphs and everywhere else.
        return { id: p.id, slot, color: p.color ?? colorFor(slot), label: p.displayName, share: (areas.get(slot) ?? 0) / TOTAL, pulse: state.taps[p.id] ?? 0 };
      }),
  );
}

export default defineModule<Config, State, Action, Evaluation>({
  manifest: manifestJson as unknown as Manifest,
  configurationSchema: schemaJson,

  createInstance(config) {
    const field = fieldOf(emptyOwners());
    return withField(
      { config, colors: {}, nextColor: 0, taps: {}, cells: '', sources: '', dented: [], activity: {}, growth: {}, closed: false },
      field,
    );
  },

  onPhaseChange(raw, phase, ctx) {
    const state = upgrade(raw, ctx.players());
    if (phase === 'ACTIVE') {
      // Everyone present gets a blob; when the challenge reopens, only those without one are new.
      const players = ctx.players();
      const fresh = players.filter((p) => state.colors[p.id] === undefined).length === players.length;
      return place({ ...state, closed: false }, players, players.map((p) => p.id), () => ctx.rng(), !fresh);
    }
    if (phase === 'PENDING') return state;
    return state.closed ? state : { ...state, closed: true };
  },

  onPlayerJoin(raw, player, ctx) {
    const state = upgrade(raw, ctx.players());
    if (state.closed) return state;
    return place(state, ctx.players(), [player.id], () => ctx.rng(), true);
  },

  onAttemptStart(raw, player, ctx) {
    const state = upgrade(raw, ctx.players());
    // A blob that was squeezed out completely comes back as a small seed (no circle cleared).
    return state.closed ? withColor(state, player.id) : place(state, ctx.players(), [player.id], () => ctx.rng(), false);
  },

  validateAction(_state, _player, payload) {
    const n = payload && typeof payload === 'object' ? (payload as { pump?: unknown }).pump : undefined;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_TAPS_PER_BATCH) return { ok: false, reason: 'Invalid pump' };
    return { ok: true };
  },

  onAction(raw, player, payload, ctx) {
    const n = (payload as Action).pump;
    const now = ctx.now();
    let state = upgrade(raw, ctx.players());
    state = {
      ...state,
      taps: { ...state.taps, [player.id]: (state.taps[player.id] ?? 0) + n },
      activity: { ...state.activity, [player.id]: { value: activityOf(state, player.id, now) + n, at: now } },
    };
    if (state.closed) return state;
    const field = fieldFrom(state);
    state = placeIn(field, state, ctx.players(), [player.id], () => ctx.rng(), false);
    const owed = (state.growth[player.id] ?? 0) + n * cellsPerTap(state.config);
    const whole = Math.floor(owed);
    const gained = grow(field, state.colors[player.id]!, whole, {
      maxCells: maxCellsOf(state.config),
      rng: () => ctx.rng(),
      strength: strengthOf(state, now),
      minCells: MIN_CELLS,
    });
    // Air that could not go anywhere (full size, or stronger neighbours all round) is not kept.
    const remainder = gained < whole ? 0 : owed - whole;
    return { ...withField(state, field), growth: { ...state.growth, [player.id]: remainder } };
  },

  validateInput() {
    return { ok: false, reason: 'Tap the pump to play' };
  },

  handleInput(state) {
    return state;
  },

  evaluate(raw, _submissions, ctx) {
    // onClose: territory as frozen when the host closed it; submissions are not used.
    return { shares: standings(upgrade(raw, ctx.players()), ctx.players()) };
  },

  calculateScores(state, evaluation) {
    const best = Math.max(0, ...evaluation.shares.map((s) => s.share));
    if (best <= 0) return [];
    return evaluation.shares
      .filter((s) => s.taps > 0)
      .map((s) => ({ playerId: s.playerId, points: Math.round((state.config.points * s.share) / best), reason: `Held ${pct(s.share)} of the room` }));
  },

  getStatistics(_state, evaluations) {
    const shares = evaluations[0]?.shares ?? [];
    return {
      players: shares.length,
      pumpers: shares.filter((s) => s.taps > 0).length,
      totalTaps: shares.reduce((a, s) => a + s.taps, 0),
      biggest: shares[0] ? { name: shares[0].displayName, share: shares[0].share } : null,
    };
  },

  displayPanel(raw, ctx) {
    return blobFieldOf(raw, ctx);
  },

  presentation(raw, _evaluations, ctx): PresentationSlide[] {
    const field = blobFieldOf(raw, ctx);
    const top = [...field.blobs].sort((a, b) => b.share - a.share).filter((b) => b.share > 0).slice(0, 5);
    return [
      {
        steps: [ui.stack([field, ui.caption(top.map((b) => `${b.label} ${pct(b.share)}`).join(' · '), { align: 'center' })], { gap: 'md', align: 'stretch' })],
        stepSeconds: 15,
      },
    ];
  },

  guestView(raw, player, ctx) {
    const players = ctx.players();
    const state = upgrade(raw, players);
    const share = sharesOf(state, players).get(player.id) ?? 0;
    const color = player.color ?? colorFor(state.colors[player.id] ?? state.nextColor);
    return {
      ui: ui.stack(
        [
          ui.caption('Your blob is on the big screen. Tap as fast as you can to pump it up!', { align: 'center' }),
          ui.tapPad('pump', { color, label: 'PUMP!', sublabel: `${pct(share)} of the room` }),
          ui.caption(
            `Pump harder than your neighbours to push into them, and keep coming back: blobs that stop pumping lose ground. Nobody can take more than ${pct(state.config.maxShare)}.`,
            { align: 'center' },
          ),
        ],
        { gap: 'md', align: 'stretch' },
      ),
      canSubmit: false,
      status: `${pct(share)} of the room`,
    };
  },

  resultsView(raw, evaluations) {
    const state = raw as State;
    const shares = evaluations[0]?.shares ?? [];
    const best = Math.max(0, ...shares.map((s) => s.share));
    const ranking = ui.ranking(
      shares.slice(0, 10).map((s, i) => ({
        rank: i + 1,
        name: s.displayName,
        value: pct(s.share),
        points: s.taps > 0 && best > 0 ? Math.round((state.config.points * s.share) / best) : 0,
        highlight: i === 0,
      })),
    );
    return {
      ui: ui.stack([ui.title('Who held the room', { align: 'center' }), ranking], { gap: 'md', align: 'stretch' }),
      guestUi: (player) => {
        const i = shares.findIndex((s) => s.playerId === player.id);
        const me = shares[i];
        const head = me
          ? ui.card([ui.display(pct(me.share)), ui.text(`of the room · #${i + 1} of ${shares.length} · ${me.taps} pumps`, { tone: 'muted' })], i === 0 ? 'success' : 'primary')
          : ui.badge('You had no blob in this one', 'muted');
        return ui.stack([head, ranking], { gap: 'md' });
      },
    };
  },
});
