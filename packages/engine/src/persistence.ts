import type {
  ActivityItem,
  AssignmentStatus,
  Availability,
  Branding,
  ChallengePhase,
  EvaluationMode,
  GameSettings,
  GameStatus,
  PublishedStandings,
  ScoreLedgerEntry,
  StandingsFeedItem,
} from '@challenge/contract';

/**
 * Persisted shape of a game (spec §12). The engine writes the whole document through
 * a repository after each mutation; repositories may store it normalized (SQLite) or
 * as one blob (memory / JSON files).
 */
export interface PersistedPlayer {
  id: string;
  gameId: string;
  displayName: string;
  sessionTokenHash: string;
  joinedAt: number;
  removedAt: number | null;
  /** True when the host freed the slot (FR-34); the next join with this name reclaims it. */
  reclaimable: boolean;
  /** The player's selfie (`media://` reference); absent or null = their icon. */
  avatar?: string | null;
}

export interface PersistedSubmission {
  id: string;
  challengeInstanceId: string;
  playerId: string;
  /** The attempt this submission belongs to (a player may have several with replays). */
  attemptId: string;
  payload: unknown;
  submittedAt: number;
  supersededBy: string | null;
  /** Module evaluation for immediate-results modules (null until scored). */
  evaluation: unknown;
  /** Points written to the ledger for this submission (null until scored). */
  scoredAt: number | null;
}

export type AttemptStatus = 'in_progress' | 'locked' | 'scored';

/** One player's run of one challenge instance (several per player when replays are allowed). */
export interface PersistedAttempt {
  id: string;
  challengeInstanceId: string;
  playerId: string;
  startedAt: number;
  lockedAt: number | null;
  status: AttemptStatus;
}

/** §14: engine-managed judge assignment. */
export interface PersistedAssignment {
  id: string;
  challengeInstanceId: string;
  submissionId: string;
  /** null = host queue item. */
  judgePlayerId: string | null;
  status: AssignmentStatus;
  /** 'host-mode' | 'peer' | 'escalated-timeout' | 'escalated-rejection' | 'no-judges' | 'reassigned' */
  reason: string;
  assignedAt: number;
  deadlineAt: number | null;
  decidedAt: number | null;
  decidedBy: 'peer' | 'host' | null;
  decision: 'approve' | 'reject' | null;
  points: number | null;
  note: string | null;
  /** How many times this submission has been reassigned before this assignment. */
  reassignments: number;
}

export interface PersistedTimer {
  tag: string;
  /** Attempt-scoped when set. */
  playerId: string | null;
  startedAt: number;
  endsAt: number;
  /** Remaining ms when paused; null while running. */
  remainingMs: number | null;
}

/** The big screen's spotlight rotation (see spotlight.ts). */
export interface SpotlightState {
  /** What is on screen: `key` is `<instanceId>/<itemId>`. */
  current: {
    key: string;
    instanceId: string;
    itemId: string;
    startedAt: number;
    endsAt: number;
    /** How many items were taking turns when this one was picked. */
    total: number;
    /** Put there by the host to stay until released. */
    held?: boolean;
  } | null;
  /** key → the item's `activity` when it was last on screen. */
  seen: Record<string, number>;
  /** Keys shown in the current round (every item once before repeats). */
  round: string[];
}

export interface PersistedInstance {
  id: string;
  gameId: string;
  moduleId: string;
  moduleVersion: string;
  sortOrder: number;
  /** Host-entered title shown to players ('' = module name). */
  title: string;
  /** Host-entered category; players' boards group by it ('' = none). */
  category: string;
  /** Players may start new attempts; only their best one counts. */
  allowReplay: boolean;
  configuration: Record<string, unknown>;
  moduleState: unknown;
  phase: ChallengePhase;
  availability: Availability;
  assignedPlayerIds: string[];
  /** Host override of the module's evaluation mode (null = module default / game preference). */
  evaluationMode: EvaluationMode | null;
  seed: number;
  createdAt: number;
  openedAt: number | null;
  closedAt: number | null;
  timers: PersistedTimer[];
  /** Aggregate evaluation for onClose modules. */
  evaluation: unknown;
  /** Set once the instance has final aggregate results (onClose) — statistics snapshot. */
  results: {
    scores: { playerId: string; points: number; reason?: string }[];
    statistics: Record<string, unknown>;
  } | null;
  error: string | null;
}

export interface PersistedGame {
  id: string;
  name: string;
  code: string;
  hostTokenHash: string;
  status: GameStatus;
  settings: GameSettings;
  branding: Branding;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  paused: boolean;
  /** Host revealed points and results to players and the main display. */
  resultsRevealed: boolean;
  /** Standings as last published to the big screen (null before the first update). */
  standings: PublishedStandings | null;
  /** Ranking changes between publications, oldest first (capped). */
  standingsFeed: StandingsFeedItem[];
  /** Big-screen spotlight rotation over module `spotlight` items. */
  spotlight: SpotlightState;
  seq: number;
  players: PersistedPlayer[];
  instances: PersistedInstance[];
  attempts: PersistedAttempt[];
  submissions: PersistedSubmission[];
  assignments: PersistedAssignment[];
  ledger: ScoreLedgerEntry[];
  activity: ActivityItem[];
}

export interface Repository {
  saveGame(game: PersistedGame): void | Promise<void>;
  loadGames(): PersistedGame[] | Promise<PersistedGame[]>;
  deleteGame(id: string): void | Promise<void>;
}

export class MemoryRepository implements Repository {
  private readonly games = new Map<string, PersistedGame>();
  saveGame(game: PersistedGame): void {
    this.games.set(game.id, structuredClone(game));
  }
  loadGames(): PersistedGame[] {
    return [...this.games.values()].map((g) => structuredClone(g));
  }
  deleteGame(id: string): void {
    this.games.delete(id);
  }
}
