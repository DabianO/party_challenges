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

export type ModuleCategory = 'knowledge' | 'skill' | 'social' | 'memory' | 'chaos' | 'other';

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
}

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

  // Attempt lifecycle (per player) ----------------------------------------
  /** Called when a player starts the challenge. Schedule the time limit here: `ctx.schedule('lock', s, player.id)`. */
  onAttemptStart?(state: State, player: PlayerRef, ctx: InstanceContext): State;
  /** Called when a player's attempt locks (submitted, finished, timed out, or instance closed). */
  onAttemptLocked?(state: State, player: PlayerRef, ctx: InstanceContext): State;

  // Input ------------------------------------------------------------------
  validateInput(state: State, player: PlayerRef, input: Input, ctx: InstanceContext): ValidationResult;
  handleInput(state: State, player: PlayerRef, input: Input, ctx: InstanceContext): State;

  // Evaluation -------------------------------------------------------------
  /**
   * `immediate`: called once per locked attempt with exactly one submission (carrying any
   * judgements). `onClose`: called once with every submission when the instance closes.
   */
  evaluate(state: State, submissions: Submission<Input>[], ctx: InstanceContext): Evaluation;
  calculateScores(state: State, evaluation: Evaluation, ctx: InstanceContext): ScoreAward[];
  /** Module statistics over all evaluations so far (`onClose`: exactly one). */
  getStatistics(state: State, evaluations: Evaluation[], ctx: InstanceContext): Statistics;
  /** onClose + host resolution only. */
  hostResolutionView?(state: State, evaluation: Evaluation, ctx: InstanceContext): HostResolutionViewModel;
  applyHostResolution?(state: State, evaluation: Evaluation, payload: FormPayload, ctx: InstanceContext): HostResolutionResult<Evaluation>;

  // Presentation -----------------------------------------------------------
  /** Instructions shown before the player presses Start. Falls back to the manifest description. */
  introView?(state: State, player: PlayerRef, ctx: InstanceContext): UINode;
  /** The player's live attempt screen. */
  guestView(state: State, player: PlayerRef, ctx: InstanceContext): GuestViewModel;
  /** How a submission is shown to judges (peer or host). Falls back to a generic evidence view. */
  presentSubmission?(state: State, submission: Submission<Input>, ctx: InstanceContext): UINode;
  /** Optional public card content for the main display (must not leak answers, MR-9). */
  mainView?(state: State, ctx: InstanceContext): UINode;
  /** Results over all evaluations so far; `guestUi` personalises them. */
  resultsView(state: State, evaluations: Evaluation[], ctx: InstanceContext): ResultsViewModel;
}

/** Identity helper so module authors get full type inference. */
export function defineModule<Config, State, Input, Evaluation>(
  mod: ChallengeModule<Config, State, Input, Evaluation>,
): ChallengeModule<Config, State, Input, Evaluation> {
  return mod;
}
