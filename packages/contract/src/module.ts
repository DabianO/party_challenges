/**
 * Challenge Module Contract, version 2 (spec §7 and §14).
 *
 * Model: a game is a *board* of challenge instances. Each player starts a challenge
 * whenever they like (subject to the instance's availability), plays it at their own
 * pace and submits. The engine evaluates submissions through a generic pipeline
 * (automatic / peer / host / hybrid) and writes scores to the ledger.
 *
 * The engine never inspects Config, State, Input or Evaluation.
 */
import type { UINode } from './ui.ts';

/** The contract version implemented by this package (MR-5). */
export const CONTRACT_API_VERSION = '2';

export type JsonSchema = Record<string, unknown>;

export type ModuleCategory = 'knowledge' | 'skill' | 'social' | 'memory' | 'creativity' | 'chaos' | 'other';

export type Capability =
  | 'timer'
  | 'image'
  | 'video'
  | 'audio'
  | 'text-input'
  | 'numeric-input'
  | 'multiple-choice'
  | 'drawing'
  | 'camera'
  | 'microphone'
  | 'real-time-burst'
  | 'anonymous'
  | 'evidence-upload'
  | 'media-upload'
  | 'statistics';

/** §14: who decides a submission's outcome. */
export type EvaluationMode = 'automatic' | 'peer' | 'host' | 'hybrid';

export type EvidenceKind = 'none' | 'text' | 'number' | 'image' | 'video' | 'audio';

/**
 * When results are produced:
 *  - `immediate`: every submission is evaluated on its own as soon as the player's attempt
 *    locks (after judging, for non-automatic modes). `evaluate()` receives one submission.
 *  - `onClose`: evaluation runs once over all submissions when the host closes the
 *    challenge (e.g. ranking, votes, predictions). Only `automatic` is supported here.
 */
export type ResultsTiming = 'immediate' | 'onClose';

export interface EvaluationSpec {
  /** Default mode. */
  mode: EvaluationMode;
  /** Modes the module can run in (FR-70). Defaults to `[mode]`. */
  supportedModes?: EvaluationMode[];
  /** Human-readable criteria shown to judges (MR-17). Required for non-automatic modes. */
  criteria?: string;
  /** What a submission carries for judges to look at (§14.6). */
  evidence?: { kind: EvidenceKind; field: string; label?: string };
  /** When set, hosts may enter points in this range instead of approve/reject (FR-67). */
  hostScoring?: { min: number; max: number; step?: number };
  /** Per-module override of the judge deadline (FR-64). */
  deadlineSeconds?: number;
}

export interface Manifest {
  id: string;
  name: string;
  version: string;
  apiVersion: string;
  category: ModuleCategory;
  description: string;
  players: { min: number; max: number | null };
  duration: { typicalSeconds: number };
  capabilities: Capability[];
  evaluation: EvaluationSpec;
  results: ResultsTiming;
  /** FR-28: `none` = one submission per attempt; `replace` lets the player change it until the attempt locks. */
  resubmission?: 'none' | 'replace';
  /**
   * `once` (default): one attempt per player, unless the host enables replays (best attempt counts).
   * `repeat`: taking part repeatedly is the challenge itself — players may always start a
   * new attempt (gate turns with `canStart`) and the points of all attempts add up.
   * `immediate` results only.
   */
  attempts?: 'once' | 'repeat';
  /** Pre-filled as the challenge's category when the host adds it (e.g. "Hot Takes"). */
  suggestedCategory?: string;
  /**
   * Replays start switched on when the host adds the challenge (they can still switch them
   * off): playing again to beat your own best is the point (`immediate` results only).
   */
  suggestedReplay?: boolean;
  /**
   * Id of the module that replaces this one. The host's library no longer offers it, but
   * games and setup files that use it keep working.
   */
  supersededBy?: string;
}

/**
 * Something the main display can put in the spotlight for a minute, e.g. one statement and
 * how the room answered it (see `ChallengeModule.spotlight`).
 */
export interface SpotlightItem {
  /** Stable within the instance. */
  id: string;
  /** Short text for the host's list, e.g. the statement itself. */
  label: string;
  ui: UINode;
  /** Grows with every new or changed answer; the display shows the busiest item next. */
  activity: number;
}

/**
 * One slide of the big screen's results presentation (see `ChallengeModule.presentation`).
 * The host moves through the steps one by one (or lets them play), then on to the next slide.
 * Most slides have one step; more steps change part of the slide in place, e.g. the entries
 * rolling through a sentence (`ui.spool`): give the nodes that stay the same position in every
 * step so they stay put and animate.
 */
export interface PresentationSlide {
  /** Small heading above the slide, e.g. "Sentence 2 of 5" (the challenge title is always shown). */
  caption?: string;
  /** What the slide shows, one node per step; at least one. */
  steps: UINode[];
  /** How long each step stays on screen while the presentation plays by itself (default 10). */
  stepSeconds?: number;
}

/**
 * A module's say on whether a player may start an attempt right now (see `canStart`).
 * `urgent`: the player is needed right now (e.g. it is their turn): their board puts the
 * tile on top, highlighted, for as long as it says so (also while their attempt runs).
 * `finished`: the player has nothing left to do here (a repeat module's tile then shows as
 * done instead of waiting for a turn).
 */
export type StartCheck = { ok: true; hint?: string; urgent?: boolean } | { ok: false; reason: string; finished?: boolean };

/** One piece of a big-screen top-bar line (`displayBanner`); `color` (#rrggbb) e.g. for a player's name. */
export interface BannerPart {
  text: string;
  color?: string;
}

/** `playerNote` with a tone: `danger`/`warning` show as a warning instead of "Locked in ✓". */
export interface PlayerNote {
  text: string;
  tone?: NoteTone;
}

export type NoteTone = 'success' | 'warning' | 'danger';

/**
 * Challenge instance lifecycle (engine-owned):
 *  PENDING    not yet available (host has not unlocked it / not started)
 *  ACTIVE     players may start attempts
 *  LOCKED     closed by the host: no new attempts; pending evaluations finish
 *  EVALUATING aggregate evaluation waiting on the host (onClose modules with host resolution)
 *  RESULTS    final results available
 */
export type ChallengePhase = 'PENDING' | 'ACTIVE' | 'LOCKED' | 'EVALUATING' | 'RESULTS';

/** Who may start an instance (engine-owned availability rule). */
export type Availability = 'open' | 'host-unlocked' | 'assigned';

export interface PlayerRef {
  id: string;
  displayName: string;
  connected: boolean;
  /** The player's colour (#rrggbb), the same everywhere in the game (`playerColor`). */
  color?: string;
}

export type EventAudience = 'all' | 'host' | 'main' | 'players' | `player:${string}`;

/**
 * Everything a module may use from the platform (MR-3, MR-11). All randomness
 * and time come from here so instances can be replayed and audited.
 */
export interface InstanceContext {
  gameId: string;
  instanceId: string;
  /** Seeded deterministic RNG in [0, 1). */
  rng(): number;
  /** Authoritative server clock, epoch milliseconds. */
  now(): number;
  /** Current roster (excluding removed players). */
  players(): PlayerRef[];
  /**
   * Schedule a server-side timer. When it fires the engine calls
   * `onTimer(state, tag, ctx, playerId)`. With a `playerId` the timer belongs to that
   * player's attempt; without, it belongs to the instance.
   * Reserved tag `lock`: with a playerId the engine locks that player's attempt (input
   * closes, evaluation starts); without, the engine closes the whole instance.
   * Timers are published to clients as authoritative end timestamps (FR-22) so a
   * `ui.timer(tag)` node renders a countdown for them.
   */
  schedule(tag: string, seconds: number, playerId?: string): void;
  cancel(tag: string, playerId?: string): void;
  /** Emit an opaque MODULE_EVENT to an audience (FR-39). */
  emit(audience: EventAudience, payload: unknown): void;
  /** Resolve a `media://` reference to a URL clients can load. Returns input unchanged if not a media ref. */
  mediaUrl(ref: string): string;
}

export type ValidationResult = { ok: true } | { ok: false; reason: string };

/** A judge's decision (peer or host), attached to the submission it concerns (FR-65). */
export interface Judgement {
  assignmentId: string;
  by: 'peer' | 'host';
  /** Judge player id for peers; null for the host. */
  judgePlayerId: string | null;
  decision: 'approve' | 'reject';
  /** Host-entered points (only when the manifest declares `hostScoring`). */
  points?: number;
  note?: string;
  decidedAt: number;
}

export interface Submission<Input = unknown> {
  id: string;
  playerId: string;
  payload: Input;
  /** Server time the player's attempt started. */
  startedAt: number;
  /** Server-side timestamp, epoch ms (FR-27). */
  submittedAt: number;
  /** Decisions gathered by the evaluation pipeline; empty for automatic mode. */
  judgements: Judgement[];
}

export interface ScoreAward {
  playerId: string;
  points: number;
  reason?: string;
}

export type Statistics = Record<string, unknown>;

export interface GuestViewModel {
  ui: UINode;
  /** Whether the guest UI should offer a submit action right now. */
  canSubmit: boolean;
  /** Short status shown in the guest chrome (e.g. "Answer locked in"). */
  status?: string;
  /**
   * Leaving the screen locks the answer in: the phone submits an empty payload (final) when
   * the player goes back to the board. For answers built up with live actions, e.g. once every
   * pair of a Match Up is linked (`validateInput` must accept `{}` then).
   */
  lockOnLeave?: boolean;
}

export interface ResultsViewModel {
  /** Shared results (main display, host). */
  ui: UINode;
  /** Personal results for one player; when omitted, `ui` is used. */
  guestUi?: (player: PlayerRef) => UINode;
}

/**
 * Instance-level host resolution for `onClose` modules that need a host-provided
 * outcome (e.g. "who actually won?"). Distinct from the per-submission host queue.
 * Payload shape: a flat object keyed by input `name` — `choices` → option id `string`
 * (or `string[]` when `multiple`), `number-input`/`slider` → `number`,
 * `text-input` → `string`, `toggle` → `boolean`.
 */
export interface HostResolutionViewModel {
  ui: UINode;
  submitLabel?: string;
}

export interface HostResolutionResult<Evaluation> {
  evaluation: Evaluation;
  /** When false, the engine keeps the instance in EVALUATING and re-renders the form. */
  complete: boolean;
  message?: string;
}

export type FormPayload = Record<string, unknown>;

export interface ChallengeModule<Config = unknown, State = unknown, Input = unknown, Evaluation = unknown> {
  // Identity ---------------------------------------------------------------
  manifest: Manifest;
  configurationSchema: JsonSchema;

  // Instance lifecycle -----------------------------------------------------
  /** Called when the instance is created for the board (before any player sees it). */
  createInstance(config: Config, ctx: InstanceContext): State;
  /** Called after every instance phase transition. */
  onPhaseChange?(state: State, phase: ChallengePhase, ctx: InstanceContext): State;
  /** Called when a timer fires (`playerId` set for attempt-scoped timers). */
  onTimer?(state: State, tag: string, ctx: InstanceContext, playerId?: string): State;

  /**
   * Called when a new player joins the game while this instance is ACTIVE (players already
   * present when it opens are in `ctx.players()` at `onPhaseChange('ACTIVE')`).
   */
  onPlayerJoin?(state: State, player: PlayerRef, ctx: InstanceContext): State;

  // Attempt lifecycle (per player) ----------------------------------------
  /**
   * Optional extra gate on top of the engine's availability rules, e.g. turn-taking ("it is
   * Bea's turn"). `{ ok: false, reason }` shows the player a waiting tile with `reason`;
   * `{ ok: true, hint }` shows `hint` on their playable tile. Called often: keep it pure and cheap.
   */
  canStart?(state: State, player: PlayerRef, ctx: InstanceContext): StartCheck;
  /**
   * Called when a player starts the challenge. Schedule the time limit here: `ctx.schedule('lock', s, player.id)`.
   * When the host allows replays this runs again for the same player on every new attempt:
   * clear that player's per-attempt data here so the new attempt starts fresh.
   */
  onAttemptStart?(state: State, player: PlayerRef, ctx: InstanceContext): State;
  /**
   * Players this challenge is closed for while it is still open for others (e.g. after an
   * answer that broke the rules). The host can give each of them another go (`reopenFor`).
   * Implement both or neither.
   */
  closedFor?(state: State, ctx: InstanceContext): string[];
  reopenFor?(state: State, player: PlayerRef, ctx: InstanceContext): State;
  /** Called when a player's attempt locks (submitted, finished, timed out, or instance closed). */
  onAttemptLocked?(state: State, player: PlayerRef, ctx: InstanceContext): State;
  /**
   * `immediate` results only. When an attempt locks without a submission (time up, Finish,
   * the host closing the challenge), the engine records this as the player's submission and
   * evaluates it, so answers given as live actions count (e.g. every name entered before the
   * time ran out). Null: nothing to record (the attempt is missed). Runs after `onAttemptLocked`.
   */
  lockInput?(state: State, player: PlayerRef, ctx: InstanceContext): Input | null;

  // Input ------------------------------------------------------------------
  validateInput(state: State, player: PlayerRef, input: Input, ctx: InstanceContext): ValidationResult;
  handleInput(state: State, player: PlayerRef, input: Input, ctx: InstanceContext): State;

  /**
   * Live actions: rapid input that is *not* a submission (e.g. taps from a `tap-pad`).
   * Only accepted from a player with an attempt in progress while the instance is ACTIVE.
   * Actions change state but are not stored or evaluated one by one; the engine throttles
   * the snapshots they cause. Implement both or neither.
   */
  validateAction?(state: State, player: PlayerRef, payload: unknown, ctx: InstanceContext): ValidationResult;
  onAction?(state: State, player: PlayerRef, payload: unknown, ctx: InstanceContext): State;

  // Evaluation -------------------------------------------------------------
  /**
   * `immediate`: called once per locked attempt with exactly one submission (carrying any
   * judgements). `onClose`: called once with every submission when the instance closes.
   */
  evaluate(state: State, submissions: Submission<Input>[], ctx: InstanceContext): Evaluation;
  calculateScores(state: State, evaluation: Evaluation, ctx: InstanceContext): ScoreAward[];
  /**
   * Module statistics over all evaluations so far (`onClose`: exactly one). With replays,
   * `getStatistics` and `resultsView` receive only each player's best attempt.
   */
  getStatistics(state: State, evaluations: Evaluation[], ctx: InstanceContext): Statistics;
  /** onClose + host resolution only. */
  hostResolutionView?(state: State, evaluation: Evaluation, ctx: InstanceContext): HostResolutionViewModel;
  applyHostResolution?(state: State, evaluation: Evaluation, payload: FormPayload, ctx: InstanceContext): HostResolutionResult<Evaluation>;

  // Presentation -----------------------------------------------------------
  /** Instructions shown before the player presses Start. Falls back to the manifest description. */
  introView?(state: State, player: PlayerRef, ctx: InstanceContext): UINode;
  /**
   * Seconds the player will have once they start (the `lock` timer `onAttemptStart` sets), or
   * null for no time limit. The phone warns the player before Start, so they can still go back.
   */
  timeLimit?(state: State, player: PlayerRef, ctx: InstanceContext): number | null;
  /**
   * Short personal feedback for the player's tile and lock-in message, shown even while
   * the host keeps results hidden (e.g. "312 ms · best 287 ms" so players can improve).
   * It bypasses the hidden-results rule: share only what is meant to be seen right away.
   */
  playerNote?(state: State, player: PlayerRef, ctx: InstanceContext): string | PlayerNote | null;
  /** The player's live attempt screen. */
  guestView(state: State, player: PlayerRef, ctx: InstanceContext): GuestViewModel;
  /** How a submission is shown to judges (peer or host). Falls back to a generic evidence view. */
  presentSubmission?(state: State, submission: Submission<Input>, ctx: InstanceContext): UINode;
  /** Optional public card content for the main display (must not leak answers, MR-9). */
  mainView?(state: State, ctx: InstanceContext): UINode;
  /**
   * Optional live panel for the big screen, shown next to the race graph while the instance
   * is open and as the closing picture once it is closed or the game ended (e.g. a
   * `blob-field`). Everyone in the room sees it: must not leak answers (MR-9). Return null for
   * nothing to show right now.
   */
  displayPanel?(state: State, ctx: InstanceContext): UINode | null;
  /**
   * Optional short line for the big screen's top bar while the instance is open, e.g.
   * "✍️ Bea's turn to write: open your phone". Everyone sees it (MR-9). Null for nothing.
   * Return parts instead of a string to colour some of it (e.g. the player's name in their colour).
   */
  displayBanner?(state: State, ctx: InstanceContext): string | BannerPart[] | null;
  /**
   * Optional layer over the whole big screen while the instance is open, e.g. a balloon to
   * shoot (`ui.aimField`). Drawn in a 16:9 box over everything else, see-through and not
   * clickable; hidden during the results presentation. Everyone sees it (MR-9). Null for nothing.
   */
  displayOverlay?(state: State, ctx: InstanceContext): UINode | null;
  /**
   * Optional items for the big screen's spotlight, which shows one item a minute from every
   * open instance that has any: the one with the most new answers since it was last shown,
   * every item once before any repeats. Everyone sees it: aggregate answers only (MR-9).
   */
  spotlight?(state: State, ctx: InstanceContext): SpotlightItem[];
  /**
   * Optional slides for the big screen's results presentation, which the host runs once the
   * challenge is closed (e.g. every caption, or every statement and how the room answered).
   * Shown while points are still hidden from the room: no points or rankings on slides.
   * Receives the same evaluations as `resultsView`. Return [] for nothing to show.
   */
  presentation?(state: State, evaluations: Evaluation[], ctx: InstanceContext): PresentationSlide[];
  /** Results over all evaluations so far; `guestUi` personalises them. */
  resultsView(state: State, evaluations: Evaluation[], ctx: InstanceContext): ResultsViewModel;
}

/** Identity helper so module authors get full type inference. */
export function defineModule<Config, State, Input, Evaluation>(
  mod: ChallengeModule<Config, State, Input, Evaluation>,
): ChallengeModule<Config, State, Input, Evaluation> {
  return mod;
}
