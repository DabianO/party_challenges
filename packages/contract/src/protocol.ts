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
}

export interface PlayerPublic {
  id: string;
  displayName: string;
  connected: boolean;
  joinedAt: number;
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
  submitted: number;
  scored: number;
  /** Awaiting peer/host judgement. */
  pendingEvaluations: number;
  averagePoints: number | null;
  bestPoints: number | null;
}

export interface ChallengeInstanceSummary {
  id: string;
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
  /** Host only (and the assignees themselves see the instance in their board). */
  assignedPlayerIds?: string[];
  stats: ChallengeStats;
  /** Host only. */
  configuration?: Record<string, unknown>;
  /** Host only: last module error (FR-52). */
  error?: string | null;
  /** Host only: a short human summary of the configuration (first string field). */
  title?: string;
}

export interface LeaderboardEntry {
  rank: number;
  playerId: string;
  displayName: string;
  total: number;
  /** Points from the player's most recent award. */
  lastDelta: number;
  wins: number;
  /** Challenges scored for this player. */
  completed: number;
  connected: boolean;
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
  | 'in_progress'
  | 'submitted' // locked, waiting for evaluation (automatic pending or judging)
  | 'scored'
  | 'missed' // attempt locked without a submission
  | 'closed'; // instance closed before the player attempted it

export interface BoardEntry {
  instanceId: string;
  moduleName: string;
  moduleCategory: string;
  description: string;
  evaluationMode: EvaluationMode;
  results: ResultsTiming;
  typicalSeconds: number;
  phase: ChallengePhase;
  status: AttemptStatus;
  /** Points awarded to this player (once scored). */
  points: number | null;
  startedAt: number | null;
  /** Instructions shown before Start (module introView or description). */
  intro: UINode | null;
  /** Live attempt screen while in progress. */
  view: UINode | null;
  canSubmit: boolean;
  statusText: string | null;
  /** Personal result once scored, or shared results for onClose modules in RESULTS. */
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
  /** Results of instances in RESULTS (shared view), keyed by instance id. */
  results: Record<string, ChallengeResults>;
  /** Host only: submissions waiting for a host decision. */
  hostQueue: HostQueueItem[];
  /** Host only: instance-level resolutions waiting for the host (onClose modules). */
  resolutions: { instanceId: string; moduleName: string; form: HostResolutionViewModel | null }[];
  /** Host only: every assignment, newest first. */
  evaluations: EvaluationRecord[];
  /** Host only: scored submissions the host may override. */
  scored: ScoredSubmissionSummary[];
}

export type GameEventType =
  | 'GAME_STATE_SNAPSHOT'
  | 'GAME_STARTED'
  | 'GAME_FINISHED'
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
  | { type: 'SUBMIT'; instanceId: string; payload: unknown; clientId: string }
  | { type: 'FINISH'; instanceId: string; clientId: string }
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
  availability: Availability;
  assignedPlayerIds: string[];
  /** Overrides the effective evaluation mode for this instance when the module supports it. */
  evaluationMode: EvaluationMode | null;
}

export type HostAction =
  | { action: 'open-lobby' }
  | { action: 'start-game' }
  | { action: 'end-game' }
  | { action: 'close-game' }
  | { action: 'pause' }
  | { action: 'resume' }
  | { action: 'unlock-challenge'; instanceId: string }
  | { action: 'relock-challenge'; instanceId: string }
  | { action: 'close-challenge'; instanceId: string }
  | { action: 'reopen-challenge'; instanceId: string }
  | { action: 'reset-challenge'; instanceId: string }
  | { action: 'assign-challenge'; instanceId: string; playerIds: string[] }
  | { action: 'remove-player'; playerId: string }
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
