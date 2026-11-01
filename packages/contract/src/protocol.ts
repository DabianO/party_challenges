/**
 * Wire protocol shared by server and web clients (spec §9, §12, §14).
 */
import type { UINode } from './ui.ts';
import type {
  Availability,
  ChallengePhase,
  EvaluationMode,
  EventAudience,
  HostResolutionViewModel,
  JsonSchema,
  Judgement,
  Manifest,
  NoteTone,
  ResultsTiming,
  ScoreAward,
  Statistics,
} from './module.ts';

export type GameStatus = 'DRAFT' | 'LOBBY' | 'IN_PROGRESS' | 'GAME_RESULTS' | 'FINISHED';

export type TieBreak = 'shared' | 'wins' | 'earliest';

/** FR-70: game-level evaluation preference. `module-default` keeps each module's own mode. */
export type EvaluationPreference = 'module-default' | EvaluationMode;

export interface GameSettings {
  /** FR-18 */
  allowLateJoin: boolean;
  /** FR-42 */
  tieBreak: TieBreak;
  /** FR-70 */
  evaluationPreference: EvaluationPreference;
  /** FR-64: seconds a judge has to decide before reassignment. */
  judgeDeadlineSeconds: number;
  /** FR-64: reassignments before an assignment escalates to the host. */
  maxReassignments: number;
}

export interface Branding {
  hostName?: string;
  accentColor?: string;
  logo?: string;
  background?: string;
  introText?: string;
  finalText?: string;
  theme?: 'dark' | 'light';
}

export const DEFAULT_SETTINGS: GameSettings = {
  allowLateJoin: true,
  tieBreak: 'shared',
  evaluationPreference: 'module-default',
  judgeDeadlineSeconds: 60,
  maxReassignments: 2,
};

export interface GameSummary {
  id: string;
  name: string;
  code: string;
  status: GameStatus;
  settings: GameSettings;
  branding: Branding;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  paused: boolean;
  /**
   * False until the host reveals results: players and the main display then see who
   * finished what, but no points, rankings or per-challenge results.
   */
  resultsRevealed: boolean;
}

export interface PlayerPublic {
  id: string;
  displayName: string;
  connected: boolean;
  joinedAt: number;
  /** The player's colour (#rrggbb), the same everywhere in the game. */
  color: string;
  /** The player's own icon (an emoji, unique per player), shown when they have no picture. */
  icon: string;
  /** The player's selfie (`media://` reference), shown in a circle instead of the icon. */
  avatar: string | null;
}

export interface TimerInfo {
  tag: string;
  startedAt: number;
  endsAt: number;
  /** Set for attempt-scoped timers. */
  playerId?: string;
}

export interface ChallengeStats {
  /** Players who started an attempt. */
  started: number;
  /** Attempts in total (more than `started` when replays are allowed). */
  attempts: number;
  /** Players who submitted. */
  submitted: number;
  /** Players with a scored attempt. */
  scored: number;
  /** Awaiting peer/host judgement. */
  pendingEvaluations: number;
  /** Null for players and the main display until results are revealed. */
  averagePoints: number | null;
  bestPoints: number | null;
}

export interface ChallengeInstanceSummary {
  id: string;
  /** What players see: the host's title, or the module name when none was set. */
  title: string;
  /** Host only: the title exactly as the host entered it ('' = none). */
  customTitle?: string;
  /** The host's category; players' boards group challenges by it ('' = none). */
  category: string;
  moduleId: string;
  moduleVersion: string;
  moduleName: string;
  moduleCategory: string;
  moduleDescription: string;
  /** Effective mode after the game preference is applied (FR-70). */
  evaluationMode: EvaluationMode;
  /** Host only: the per-instance override (null = module default / game preference). */
  evaluationModeOverride?: EvaluationMode | null;
  results: ResultsTiming;
  typicalSeconds: number;
  sortOrder: number;
  phase: ChallengePhase;
  availability: Availability;
  /** Players may start it again; only their best attempt counts. */
  allowReplay: boolean;
  /** Host only (and the assignees themselves see the instance in their board). */
  assignedPlayerIds?: string[];
  stats: ChallengeStats;
  /** Host only. */
  configuration?: Record<string, unknown>;
  /** Host only: last module error (FR-52). */
  error?: string | null;
  /** Host only: a short human summary of the configuration (first string field). */
  summary?: string;
  /** Host only: players it is closed for while open for others (`reopen-for-player` gives them another go). */
  closedFor?: string[];
  /** Main display only: the module's live big-screen panel (`displayPanel`), when it has one and has started. */
  displayPanel?: UINode | null;
  /** Main display only: the module's line for the big screen's top bar (`displayBanner`), while open. */
  displayBanner?: string | null;
}

export interface LeaderboardEntry {
  rank: number;
  playerId: string;
  displayName: string;
  total: number;
  /** Points from the player's most recent award. */
  lastDelta: number;
  wins: number;
  /** Challenges this player has finished (submitted or ran out of time; replays count once). */
  completed: number;
  /**
   * Running total for the progress graph: index 0 = before any finished challenge, index k =
   * after the player's k-th finished challenge (in the order they finished them). A
   * challenge's value follows its current points, so improved replays and late judging
   * move the line. The last value equals `total`. Empty while points are hidden.
   */
  series: number[];
  connected: boolean;
}

/** One player in the standings the host last published to the big screen. */
export interface PublishedStanding {
  playerId: string;
  displayName: string;
  rank: number;
  total: number;
  completed: number;
  /** Progress-graph line, see `LeaderboardEntry.series`. */
  series: number[];
}

/** A frozen copy of the leaderboard, taken when the host presses "Update the big screen". */
export interface PublishedStandings {
  publishedAt: number;
  entries: PublishedStanding[];
}

/** A change in the published ranking: a new leader, an overtake, or a newcomer with points. */
export interface StandingsFeedItem {
  id: string;
  at: number;
  kind: 'lead' | 'overtake' | 'enter';
  text: string;
  playerId: string;
  rank: number;
  previousRank: number | null;
  /** Names of the players they passed. */
  passed: string[];
}

export interface GenericStatistics {
  participants: number;
  submissions: number;
  participationRate: number;
  /** Seconds from attempt start to submission. */
  submissionTime: { min: number | null; max: number | null; average: number | null; median: number | null };
  pointsDistribution: { points: number; count: number }[];
}

export interface ChallengeResults {
  ui: UINode;
  scores: ScoreAward[];
  statistics: Statistics;
  generic: GenericStatistics;
}

/** Player-visible state of one challenge on their board. */
export type AttemptStatus =
  | 'locked' // not available to this player yet
  | 'available'
  | 'waiting' // open, but the module says not now (e.g. another player's turn); see statusText
  | 'in_progress'
  | 'submitted' // locked, waiting for evaluation (automatic pending or judging)
  | 'scored'
  | 'missed' // attempt locked without a submission
  | 'closed'; // instance closed before the player attempted it

export interface BoardEntry {
  instanceId: string;
  /** The host's title for this challenge, or the module name when none was set. */
  title: string;
  /** The host's category; the board groups challenges by it ('' = none). */
  category: string;
  moduleName: string;
  moduleCategory: string;
  description: string;
  evaluationMode: EvaluationMode;
  results: ResultsTiming;
  typicalSeconds: number;
  phase: ChallengePhase;
  status: AttemptStatus;
  /** Points counted for this player (their best attempt); null until scored and revealed. */
  points: number | null;
  startedAt: number | null;
  /** Attempts this player has made. */
  attempts: number;
  /** The player may start another attempt (replays or repeat module, previous attempt finished). */
  canReplay: boolean;
  /** Points of all attempts add up (`attempts: 'repeat'` modules) instead of the best one counting. */
  repeat: boolean;
  /** The module's personal feedback (`playerNote`), visible even while results are hidden. */
  note: string | null;
  /** The note's tone, when the module gave one (`danger`/`warning`: something went wrong). */
  noteTone: NoteTone | null;
  /** The player is needed here right now (e.g. their turn): shown on top, highlighted. */
  urgent: boolean;
  /** Instructions shown before Start (module introView or description). */
  intro: UINode | null;
  /** Live attempt screen while in progress. */
  view: UINode | null;
  canSubmit: boolean;
  statusText: string | null;
  /** Personal result once scored and revealed, or shared results for onClose modules in RESULTS. */
  result: UINode | null;
  /** Timers for this player's attempt plus instance timers. */
  timers: TimerInfo[];
  /** Whether the player may finish early (resubmission = replace). */
  canFinish: boolean;
}

/** A judging task on a guest's phone (FR-54, FR-63). */
export interface JudgeTask {
  assignmentId: string;
  instanceId: string;
  title: string;
  moduleName: string;
  criteria: string;
  deadlineAt: number;
  presentation: UINode;
}

export type AssignmentStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'escalated' | 'overridden' | 'cancelled';

/** Host queue item (FR-67, FR-68, FR-55). */
export interface HostQueueItem {
  assignmentId: string;
  instanceId: string;
  title: string;
  moduleName: string;
  submissionId: string;
  playerId: string;
  displayName: string;
  criteria: string;
  presentation: UINode;
  status: AssignmentStatus;
  /** Why it reached the host: 'host-mode' | 'escalated-timeout' | 'escalated-rejection' | 'no-judges'. */
  reason: string;
  hostScoring: { min: number; max: number; step?: number } | null;
  /** Earlier peer decisions on this submission. */
  priorJudgements: Judgement[];
  submittedAt: number;
}

/** Host-side overview of every evaluation (FR-55). */
export interface EvaluationRecord {
  assignmentId: string;
  instanceId: string;
  title: string;
  moduleName: string;
  submissionId: string;
  playerId: string;
  displayName: string;
  judgePlayerId: string | null;
  judgeName: string | null;
  status: AssignmentStatus;
  decidedBy: 'peer' | 'host' | null;
  decision: 'approve' | 'reject' | null;
  points: number | null;
  note: string | null;
  assignedAt: number;
  deadlineAt: number | null;
  decidedAt: number | null;
}

export interface ScoredSubmissionSummary {
  submissionId: string;
  instanceId: string;
  title: string;
  moduleName: string;
  playerId: string;
  displayName: string;
  points: number;
  scoredAt: number;
  /** Present when the host can still override (always, FR-55). */
  presentation: UINode | null;
}

export interface ActivityItem {
  id: string;
  at: number;
  kind: 'joined' | 'started' | 'submitted' | 'scored' | 'unlocked' | 'closed' | 'results';
  text: string;
  playerId?: string;
  instanceId?: string;
  points?: number;
}

export interface GameSnapshot {
  serverTime: number;
  seq: number;
  game: GameSummary;
  players: PlayerPublic[];
  challenges: ChallengeInstanceSummary[];
  /**
   * Ranked by points. Until results are revealed, non-host audiences get every player with
   * `rank`, `total`, `lastDelta` and `wins` zeroed, ordered by challenges completed.
   */
  leaderboard: LeaderboardEntry[];
  /** Absolute URL guests use to join. */
  joinUrl: string;
  /** Players only. */
  me: { playerId: string; displayName: string } | null;
  /** Players only: their personal board. */
  board: BoardEntry[];
  /** Players only: pending judging tasks. */
  judging: JudgeTask[];
  /** Main display & host: recent activity, newest first. */
  activity: ActivityItem[];
  /** Results of instances in RESULTS (shared view), keyed by instance id. Empty for non-hosts until revealed. */
  results: Record<string, ChallengeResults>;
  /** Host only: submissions waiting for a host decision. */
  hostQueue: HostQueueItem[];
  /** Host only: instance-level resolutions waiting for the host (onClose modules). */
  resolutions: { instanceId: string; title: string; moduleName: string; form: HostResolutionViewModel | null }[];
  /** Host only: every assignment, newest first. */
  evaluations: EvaluationRecord[];
  /** Host only: scored submissions the host may override. */
  scored: ScoredSubmissionSummary[];
  /**
   * Main display & host: the standings last published by the host (`publish-standings`),
   * shown on the big screen regardless of `resultsRevealed`; null before the first update.
   */
  standings: PublishedStandings | null;
  /** Main display & host: ranking changes between published standings, newest first. */
  standingsFeed: StandingsFeedItem[];
  /** Main display & host: the item in the big screen's spotlight right now (module `spotlight`). */
  spotlight: SpotlightView | null;
  /** Host only: every item that can be put in the spotlight (`show-spotlight`). */
  spotlightChoices: SpotlightChoice[];
  /**
   * Main display & host: the results presentation slide on the big screen right now (module
   * `presentation`), shown instead of everything else; null when no presentation runs.
   */
  presentation: PresentationView | null;
  /** Host only: every closed challenge with slides, in board order (`start-presentation`). */
  presentationDeck: PresentationDeckEntry[];
}

/** A closed challenge the host can present, and whether the running presentation includes it. */
export interface PresentationDeckEntry {
  instanceId: string;
  title: string;
  category: string;
  slides: number;
  included: boolean;
}

/** One step of one slide of the results presentation. */
export interface PresentationView {
  instanceId: string;
  /** The challenge's title and category, for the heading. */
  title: string;
  category: string;
  /** The slide's own caption, e.g. "Sentence 2 of 5". */
  caption: string | null;
  /** Position within this challenge's slides (0-based). */
  slide: number;
  slideCount: number;
  /** Position within the slide's steps (0-based). */
  step: number;
  stepCount: number;
  /** Position of this slide in the whole presentation (0-based) and its length. */
  index: number;
  total: number;
  ui: UINode;
  /** Plays by itself: the next step comes at `endsAt`. */
  autoplay: boolean;
  startedAt: number;
  endsAt: number | null;
}

/** An item the host can put in the big screen's spotlight. */
export interface SpotlightChoice {
  instanceId: string;
  /** The challenge's title. */
  title: string;
  itemId: string;
  label: string;
  /** New or changed answers so far. */
  activity: number;
}

/** One module spotlight item on the big screen, for about a minute. */
export interface SpotlightView {
  instanceId: string;
  /** The challenge's title and category, for the heading. */
  title: string;
  category: string;
  itemId: string;
  ui: UINode;
  startedAt: number;
  endsAt: number;
  /** How many items take turns in the spotlight. */
  total: number;
  /** The host keeps it on screen until they release it (no rotation meanwhile). */
  held: boolean;
}

export type GameEventType =
  | 'GAME_STATE_SNAPSHOT'
  | 'GAME_STARTED'
  | 'GAME_FINISHED'
  | 'GAME_REOPENED'
  | 'GAME_PAUSED'
  | 'GAME_RESUMED'
  | 'LEADERBOARD_UPDATED'
  | 'PLAYER_JOINED'
  | 'PLAYER_DISCONNECTED'
  | 'PLAYER_RECONNECTED'
  | 'PLAYER_REMOVED'
  | 'PLAYER_SUBMITTED'
  | 'PLAYER_SCORED'
  | 'ATTEMPT_STARTED'
  | 'CHALLENGE_UNLOCKED'
  | 'CHALLENGE_PHASE_CHANGED'
  | 'CHALLENGE_LOCKED'
  | 'RESULTS_AVAILABLE'
  | 'STANDINGS_PUBLISHED'
  | 'RESULTS_REVEALED'
  | 'RESULTS_HIDDEN'
  | 'EVALUATION_ASSIGNED'
  | 'EVALUATION_DECIDED'
  | 'EVALUATION_ESCALATED'
  | 'MODULE_EVENT'
  | 'MODULE_ERROR';

export interface GameEvent<P = unknown> {
  gameId: string;
  seq: number;
  at: string;
  type: GameEventType;
  audience: EventAudience;
  payload: P;
}

// ---------------------------------------------------------------------------
// WebSocket messages
// ---------------------------------------------------------------------------

export type ClientRole = 'host' | 'main' | 'player';

export type ClientMessage =
  | { type: 'START'; instanceId: string; clientId: string }
  /** `final` locks the attempt right away, even for modules that accept replacement answers. */
  | { type: 'SUBMIT'; instanceId: string; payload: unknown; clientId: string; final?: boolean }
  | { type: 'FINISH'; instanceId: string; clientId: string }
  /** Live action (e.g. a batch of taps) for a module's `onAction`; not a submission. */
  | { type: 'ACTION'; instanceId: string; payload: unknown; clientId: string }
  | { type: 'JUDGE'; assignmentId: string; decision: 'approve' | 'reject'; note?: string; clientId: string }
  | { type: 'RESYNC' }
  | { type: 'PING'; t: number };

export type ServerMessage =
  | { type: 'HELLO'; role: ClientRole; playerId: string | null; serverTime: number }
  | { type: 'EVENT'; event: GameEvent }
  | { type: 'ACK'; clientId: string; ok: boolean; reason?: string }
  | { type: 'PONG'; t: number; serverTime: number }
  | { type: 'ERROR'; message: string; fatal?: boolean };

// ---------------------------------------------------------------------------
// REST DTOs
// ---------------------------------------------------------------------------

export interface ModuleInfo {
  manifest: Manifest;
  configurationSchema: JsonSchema;
}

export interface CreateGameRequest {
  name: string;
  settings?: Partial<GameSettings>;
  branding?: Branding;
}

export interface CreateGameResponse {
  game: GameSummary;
  hostToken: string;
}

export interface JoinRequest {
  code: string;
  displayName: string;
}

export interface JoinResponse {
  gameId: string;
  gameName: string;
  playerId: string;
  displayName: string;
  sessionToken: string;
}

export interface ResumeRequest {
  code: string;
  sessionToken: string;
}

export interface PublicGameInfo {
  id: string;
  name: string;
  status: GameStatus;
  joinable: boolean;
  playerCount: number;
  branding: Branding;
}

/** Instance-level options the host sets alongside the module configuration. */
export interface InstanceOptions {
  /** Shown to players instead of the module name; '' = use the module name. */
  title: string;
  /** Groups challenges on players' boards (e.g. "Intelligence"); '' = no category. */
  category: string;
  availability: Availability;
  assignedPlayerIds: string[];
  /** Overrides the effective evaluation mode for this instance when the module supports it. */
  evaluationMode: EvaluationMode | null;
  /** Players may play it again to improve; their best attempt counts (immediate-results modules only). */
  allowReplay: boolean;
}

export type PresentationMove = 'next' | 'previous' | 'next-slide' | 'previous-slide' | { instanceId: string; slide?: number };

export type HostAction =
  | { action: 'open-lobby' }
  | { action: 'start-game' }
  | { action: 'end-game' }
  | { action: 'close-game' }
  /** Continue an ended or closed game (players and points kept). */
  | { action: 'reopen-game' }
  | { action: 'pause' }
  | { action: 'resume' }
  | { action: 'reveal-results' }
  | { action: 'hide-results' }
  /** Copy the current standings to the big screen (it changes only on this action). */
  | { action: 'publish-standings' }
  /** Put one spotlight item on the big screen now; `hold` keeps it there until `release-spotlight`. */
  | { action: 'show-spotlight'; instanceId: string; itemId: string; hold?: boolean }
  /** Let the spotlight rotate again after a held item (moves on at once). */
  | { action: 'release-spotlight' }
  /** Results presentation on the big screen: the given closed challenges (default: all with slides), in board order. */
  | { action: 'start-presentation'; instanceIds?: string[]; autoplay?: boolean }
  /** One step or slide on or back, or straight to a challenge's slide. */
  | { action: 'move-presentation'; to: PresentationMove }
  | { action: 'autoplay-presentation'; on: boolean }
  | { action: 'stop-presentation' }
  | { action: 'unlock-challenge'; instanceId: string }
  | { action: 'relock-challenge'; instanceId: string }
  | { action: 'close-challenge'; instanceId: string }
  | { action: 'reopen-challenge'; instanceId: string }
  /** Every closed challenge open again at once (e.g. after continuing a closed game). */
  | { action: 'reopen-all-challenges' }
  | { action: 'reset-challenge'; instanceId: string }
  /** Give one player another go at a challenge the module closed for them (`closedFor`). */
  | { action: 'reopen-for-player'; instanceId: string; playerId: string }
  | { action: 'assign-challenge'; instanceId: string; playerIds: string[] }
  | { action: 'remove-player'; playerId: string }
  /** Take a player's selfie off (e.g. an unsuitable picture); they get their icon back. */
  | { action: 'clear-avatar'; playerId: string }
  | { action: 'free-player'; playerId: string }
  | { action: 'decide'; assignmentId: string; decision: 'approve' | 'reject'; points?: number; note?: string }
  | { action: 'override'; submissionId: string; decision: 'approve' | 'reject'; points?: number; reason: string }
  | { action: 'resolve'; instanceId: string; payload: Record<string, unknown> }
  | { action: 'retry-evaluation'; instanceId: string }
  | { action: 'adjust-score'; playerId: string; points: number; reason: string };

export interface ScoreLedgerEntry {
  id: string;
  gameId: string;
  challengeInstanceId: string | null;
  playerId: string;
  points: number;
  source: 'module' | 'manual';
  reason: string | null;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Setup export / import (JSON backup of a game's configuration)
// ---------------------------------------------------------------------------

export const SETUP_FORMAT = 'challenge-platform/setup';
export const SETUP_VERSION = 1;

/** One board entry in a setup file: module configuration plus instance options. */
export interface SetupChallenge extends Partial<Omit<InstanceOptions, 'assignedPlayerIds'>> {
  moduleId: string;
  /** Version the challenge was configured with; imports use the newest installed version. */
  moduleVersion?: string;
  configuration: Record<string, unknown>;
}

/** An uploaded file referenced as `media://<id>` from configuration or branding. */
export interface SetupMedia {
  mimeType: string;
  name: string | null;
  /** Base64 file contents. */
  data: string;
}

/**
 * Everything needed to recreate a game's configuration on any server: name, settings,
 * branding, the board and the media it references. Players, attempts and scores are not
 * part of a setup (assigned challenges come back with nobody assigned).
 */
export interface GameSetup {
  format: typeof SETUP_FORMAT;
  version: number;
  exportedAt: string;
  game: { name: string; settings: GameSettings; branding: Branding };
  challenges: SetupChallenge[];
  /** Keyed by the `media://<id>` reference used in the setup. */
  media: Record<string, SetupMedia>;
}

/** Also the response of POST /api/games/:id/duplicate (a fresh game from an existing game's setup). */
export interface ImportSetupResponse extends CreateGameResponse {
  /** Challenges or media that could not be imported, in plain words. */
  warnings: string[];
}

/** A game stored on this server, listed for the host machine itself (no token needed). */
export interface LocalGameInfo {
  game: GameSummary;
  hostToken: string;
  playerCount: number;
  challengeCount: number;
}
