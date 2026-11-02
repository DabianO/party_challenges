import type {
  ActivityItem,
  AttemptStatus,
  Availability,
  BoardEntry,
  Branding,
  ChallengeInstanceSummary,
  ChallengePhase,
  ChallengeResults,
  ChallengeStats,
  EvaluationMode,
  EvaluationRecord,
  EventAudience,
  GameEvent,
  GameEventType,
  GameSettings,
  GameSetup,
  GameSnapshot,
  GameSummary,
  HostAction,
  HostQueueItem,
  InstanceContext,
  InstanceOptions,
  JudgeTask,
  Judgement,
  LeaderboardEntry,
  PlayerPublic,
  PlayerRef,
  PresentationDeckEntry,
  PresentationMove,
  PresentationSlide,
  PresentationView,
  PublishedStanding,
  ScoreAward,
  ScoredSubmissionSummary,
  ScoreLedgerEntry,
  SpotlightChoice,
  SpotlightItem,
  SpotlightView,
  StartCheck,
  Submission,
  TimerInfo,
  UINode,
} from '@challenge/contract';
import { DEFAULT_SETTINGS, SETUP_FORMAT, SETUP_VERSION, playerColor, playerIcon, ui } from '@challenge/contract';
import { EngineError, invalidState, notFound, validationError } from './errors.ts';
import { createSeededRng, generateGameCode, hashToken, newId, newToken, randomSeed } from './ids.ts';
import { computeLeaderboard } from './leaderboard.ts';
import { STANDINGS_FEED_LIMIT, diffStandings } from './standings.ts';
import { SPOTLIGHT_IDLE_SECONDS, SPOTLIGHT_SECONDS, emptySpotlight, pickSpotlight } from './spotlight.ts';
import { PRESENTATION_STEP_SECONDS, locate, move, type DeckPosition, type DeckSlide } from './presentation.ts';
import type {
  PersistedAssignment,
  PersistedAttempt,
  PersistedGame,
  PersistedInstance,
  PersistedPlayer,
  PersistedSubmission,
  Repository,
} from './persistence.ts';
import type { LoadedModule, ModuleRegistry } from './registry.ts';
import { computeGenericStatistics } from './statistics.ts';
import { sanitizeDisplayName, uniqueDisplayName, validateConfiguration } from './validation.ts';

export type SnapshotAudience = { role: 'host' } | { role: 'main' } | { role: 'player'; playerId: string };

export interface RuntimeDeps {
  registry: ModuleRegistry;
  repo: Repository;
  /** Authoritative clock (epoch ms). Injectable for tests. */
  clock: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Deliver an event to connected clients by audience. */
  emit: (event: GameEvent) => void;
  /** Close all connections of a player (removed / freed). */
  kickPlayer: (gameId: string, playerId: string) => void;
  joinUrl: (code: string) => string;
  mediaUrl: (ref: string) => string;
  /** Non-deterministic randomness for engine decisions (judge selection). */
  random?: () => number;
  /**
   * A code this game may use when it becomes joinable again (`reopen-game`): `current`
   * when no other live game took it meanwhile, otherwise a fresh one. Absent: keep it.
   */
  reclaimCode?: (current: string, gameId: string) => string;
}

export interface HostActionResult {
  ok: true;
  message?: string;
}

export type PlayerResult = { ok: true } | { ok: false; reason: string };

/** Most players in one game: plenty for a party, and a ceiling on join floods. */
export const MAX_PLAYERS = 200;
const RATE_LIMIT_WINDOW_MS = 5_000;
const RATE_LIMIT_MAX = 20;
/** Live actions (taps) are batched by clients; allow a brisk but bounded rate. */
const ACTION_RATE_MAX = 60;
const MAX_ACTION_BYTES = 1024;
/** Snapshots caused by live actions go out at most this often… */
const ACTION_COMMIT_MS = 250;
/** …and the document they changed is saved at most this often. */
const ACTION_PERSIST_MS = 2000;
const MAX_PAYLOAD_BYTES = 16 * 1024;
const ACTIVITY_LIMIT = 40;

interface QueuedEvent {
  type: GameEventType;
  audience: EventAudience;
  payload: unknown;
}

/** Ledger reversal rows: `<kind>-reversal:<reversed row id>`. */
const REVERSAL = /^[a-z-]+-reversal:(.+)$/;

const timerKey = (instanceId: string, playerId: string | null, tag: string) => `${instanceId}|${playerId ?? ''}|${tag}`;
const assignmentKey = (assignmentId: string) => `assignment|${assignmentId}`;
const SPOTLIGHT_TIMER = 'spotlight';
const PRESENTATION_TIMER = 'presentation';
/** Host actions that still work once the game is finished. */
const ALWAYS_ALLOWED = new Set<string>(['reveal-results', 'reopen-game', 'start-presentation', 'move-presentation', 'autoplay-presentation', 'stop-presentation']);

/** The results presentation on the big screen (kept in memory: a server restart ends it). */
interface PresentationState {
  /** The challenges it shows, in board order. */
  instanceIds: string[];
  at: DeckPosition;
  autoplay: boolean;
  startedAt: number;
  endsAt: number | null;
}

/**
 * One running game: a board of challenge instances that players attempt at their own
 * pace (§5), the submission pipeline (§7.6), the evaluation pipeline (§14), the score
 * ledger (§10) and audience-scoped snapshots (§9).
 */
export class GameRuntime {
  readonly doc: PersistedGame;
  private readonly deps: RuntimeDeps;
  private readonly timerHandles = new Map<string, unknown>();
  private readonly rngs = new Map<string, () => number>();
  private readonly playerConnections = new Map<string, number>();
  private readonly everConnected = new Set<string>();
  private readonly rateBuckets = new Map<string, number[]>();
  private hostConnections = 0;
  private mainConnections = 0;
  private queue: QueuedEvent[] = [];
  private flushScheduled = false;
  private disposed = false;
  private actionCommitTimer: unknown = null;
  private actionPersistTimer: unknown = null;
  private readonly actionBuckets = new Map<string, number[]>();
  private presentation: PresentationState | null = null;
  /** Slides per closed instance, built once per commit (`seq`) for every snapshot that needs them. */
  private slideCache: { seq: number; slides: Map<string, PresentationSlide[]> } = { seq: -1, slides: new Map() };

  constructor(doc: PersistedGame, deps: RuntimeDeps) {
    this.doc = doc;
    this.deps = deps;
    this.doc.instances.sort((a, b) => a.sortOrder - b.sortOrder);
    this.doc.activity ??= [];
    this.doc.attempts ??= [];
    this.doc.assignments ??= [];
    this.doc.resultsRevealed ??= false;
    this.doc.standings ??= null;
    this.doc.standingsFeed ??= [];
    this.doc.spotlight ??= emptySpotlight();
    for (const inst of this.doc.instances) {
      inst.title ??= '';
      inst.category ??= '';
      inst.allowReplay ??= false;
      // A pinned version that is no longer installed moves up to a compatible minor (same major).
      if (!deps.registry.get(inst.moduleId, inst.moduleVersion)) {
        const compatible = deps.registry.compatible(inst.moduleId, inst.moduleVersion);
        if (compatible) inst.moduleVersion = compatible.manifest.version;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Construction & restore
  // ---------------------------------------------------------------------------

  static createDocument(input: {
    name: string;
    code: string;
    hostToken: string;
    settings?: Partial<GameSettings>;
    branding?: Branding;
    now: number;
  }): PersistedGame {
    return {
      id: newId('g'),
      name: input.name,
      code: input.code,
      hostTokenHash: hashToken(input.hostToken),
      status: 'DRAFT',
      settings: { ...DEFAULT_SETTINGS, ...(input.settings ?? {}) },
      branding: input.branding ?? {},
      createdAt: input.now,
      startedAt: null,
      finishedAt: null,
      paused: false,
      resultsRevealed: false,
      standings: null,
      standingsFeed: [],
      spotlight: emptySpotlight(),
      seq: 0,
      players: [],
      instances: [],
      attempts: [],
      submissions: [],
      assignments: [],
      ledger: [],
      activity: [],
    };
  }

  /** FR-51: bring a persisted game back after a server restart. */
  restoreAfterRestart(): void {
    // In-flight attempts cannot resume faithfully (their timers are gone); players start again.
    const inFlight = new Set(this.doc.attempts.filter((a) => a.status === 'in_progress').map((a) => a.id));
    this.doc.submissions = this.doc.submissions.filter((s) => !inFlight.has(s.attemptId));
    this.doc.attempts = this.doc.attempts.filter((a) => a.status !== 'in_progress');
    for (const inst of this.doc.instances) inst.timers = inst.timers.filter((t) => t.playerId === null);
    for (const inst of this.doc.instances) {
      for (const t of inst.timers) {
        if (t.remainingMs === null) this.armInstanceTimer(inst, t.playerId, t.tag, Math.max(0, t.endsAt - this.deps.clock()));
      }
    }
    // Re-arm judge deadlines; expired ones are handled immediately.
    for (const a of this.doc.assignments) {
      if (a.status === 'pending' && a.judgePlayerId && a.deadlineAt !== null && !this.doc.paused) {
        this.armAssignmentTimer(a, Math.max(0, a.deadlineAt - this.deps.clock()));
      }
    }
    this.updateSpotlight();
    this.persist();
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  get id(): string {
    return this.doc.id;
  }
  get code(): string {
    return this.doc.code;
  }
  get status(): PersistedGame['status'] {
    return this.doc.status;
  }
  get ledger(): ScoreLedgerEntry[] {
    return this.doc.ledger;
  }

  verifyHostToken(token: string | undefined): boolean {
    return typeof token === 'string' && token.length > 0 && hashToken(token) === this.doc.hostTokenHash;
  }

  getInstance(instanceId: string): PersistedInstance {
    const inst = this.doc.instances.find((i) => i.id === instanceId);
    if (!inst) throw notFound('Challenge not found');
    return inst;
  }

  getPlayer(playerId: string): PersistedPlayer | undefined {
    return this.doc.players.find((p) => p.id === playerId);
  }

  findPlayerBySessionToken(token: string): PersistedPlayer | undefined {
    const hash = hashToken(token);
    return this.doc.players.find((p) => p.sessionTokenHash === hash && p.removedAt === null);
  }

  isPlayerConnected(playerId: string): boolean {
    return (this.playerConnections.get(playerId) ?? 0) > 0;
  }

  get isHostConnected(): boolean {
    return this.hostConnections > 0;
  }

  /** The player's most recent attempt at an instance. */
  attemptOf(instanceId: string, playerId: string): PersistedAttempt | undefined {
    return this.doc.attempts.findLast((a) => a.challengeInstanceId === instanceId && a.playerId === playerId);
  }

  attemptsOf(instanceId: string, playerId: string): PersistedAttempt[] {
    return this.doc.attempts.filter((a) => a.challengeInstanceId === instanceId && a.playerId === playerId);
  }

  private attemptById(attemptId: string): PersistedAttempt | undefined {
    return this.doc.attempts.find((a) => a.id === attemptId);
  }

  /** The live (not superseded) submission of one attempt. */
  submissionOf(attempt: PersistedAttempt): PersistedSubmission | undefined {
    return this.doc.submissions.find((s) => s.attemptId === attempt.id && !s.supersededBy);
  }

  /** The live submission of the player's most recent attempt. */
  latestSubmission(instanceId: string, playerId: string): PersistedSubmission | undefined {
    const attempt = this.attemptOf(instanceId, playerId);
    return attempt ? this.submissionOf(attempt) : undefined;
  }

  /** Replays only make sense when each submission is scored on its own. */
  private replayAllowed(inst: PersistedInstance): boolean {
    const manifest = this.moduleFor(inst).manifest;
    return manifest.results === 'immediate' && (inst.allowReplay || manifest.attempts === 'repeat');
  }

  /** `attempts: 'repeat'` modules: every attempt counts and points add up. */
  private isRepeat(inst: PersistedInstance): boolean {
    return this.moduleFor(inst).manifest.attempts === 'repeat';
  }

  /** The module's own start gate (`canStart`), or null when it has none / is not running yet. */
  private moduleStartCheck(inst: PersistedInstance, player: PersistedPlayer): StartCheck | null {
    const loaded = this.deps.registry.get(inst.moduleId, inst.moduleVersion);
    if (!loaded?.module.canStart || inst.moduleState === null) return null;
    return this.safeView(inst, () => loaded.module.canStart!(inst.moduleState, this.playerRef(player), this.ctxFor(inst)));
  }

  /** What players see for an instance: the host's title, or the module name. */
  titleOf(inst: PersistedInstance): string {
    return inst.title || this.moduleName(inst);
  }

  getAssignment(assignmentId: string): PersistedAssignment | undefined {
    return this.doc.assignments.find((a) => a.id === assignmentId);
  }

  /** Effective evaluation mode for an instance (FR-70): instance override → game preference → module default. */
  effectiveMode(inst: PersistedInstance): EvaluationMode {
    const manifest = this.moduleFor(inst).manifest;
    const supported = manifest.evaluation.supportedModes ?? [manifest.evaluation.mode];
    if (inst.evaluationMode && supported.includes(inst.evaluationMode)) return inst.evaluationMode;
    const pref = this.doc.settings.evaluationPreference;
    if (pref !== 'module-default' && supported.includes(pref)) return pref;
    return manifest.evaluation.mode;
  }

  // ---------------------------------------------------------------------------
  // Game configuration (host)
  // ---------------------------------------------------------------------------

  updateGame(patch: { name?: string; settings?: Partial<GameSettings>; branding?: Branding }): void {
    this.assertNotFinished();
    if (patch.name !== undefined) {
      const name = String(patch.name).trim();
      if (!name || name.length > 80) throw validationError('Game name must be 1–80 characters');
      this.doc.name = name;
    }
    if (patch.settings) {
      const s = { ...this.doc.settings, ...patch.settings };
      if (!Number.isFinite(s.judgeDeadlineSeconds) || s.judgeDeadlineSeconds < 10 || s.judgeDeadlineSeconds > 3600) {
        throw validationError('Judge deadline must be between 10 and 3600 seconds');
      }
      if (!Number.isInteger(s.maxReassignments) || s.maxReassignments < 0 || s.maxReassignments > 10) {
        throw validationError('Max reassignments must be between 0 and 10');
      }
      this.doc.settings = s;
    }
    if (patch.branding) this.doc.branding = { ...this.doc.branding, ...patch.branding };
    this.commit();
  }

  addChallenge(moduleId: string, configuration: unknown, options: Partial<InstanceOptions> = {}): PersistedInstance {
    this.assertNotFinished();
    const loaded = this.deps.registry.latest(moduleId);
    if (!loaded) throw notFound(`Module ${moduleId} is not installed`);
    const validated = validateConfiguration(loaded.module.configurationSchema, configuration);
    if (!validated.ok) throw validationError(`Invalid configuration: ${validated.errors.join('; ')}`);
    const inst: PersistedInstance = {
      id: newId('c'),
      gameId: this.doc.id,
      moduleId: loaded.manifest.id,
      moduleVersion: loaded.manifest.version, // MR-15: pinned
      sortOrder: this.doc.instances.length,
      title: '',
      category: '',
      allowReplay: loaded.manifest.suggestedReplay === true && loaded.manifest.results === 'immediate',
      configuration: validated.value,
      moduleState: null,
      phase: 'PENDING',
      availability: 'open',
      assignedPlayerIds: [],
      evaluationMode: null,
      seed: randomSeed(),
      createdAt: this.deps.clock(),
      openedAt: null,
      closedAt: null,
      timers: [],
      evaluation: null,
      results: null,
      error: null,
    };
    this.applyOptions(inst, loaded, options);
    this.doc.instances.push(inst);
    if (this.doc.status === 'IN_PROGRESS' && inst.availability !== 'host-unlocked') this.openInstance(inst);
    this.commit();
    return inst;
  }

  updateChallenge(instanceId: string, configuration: unknown | undefined, options: Partial<InstanceOptions> = {}): PersistedInstance {
    this.assertNotFinished();
    const inst = this.getInstance(instanceId);
    const loaded = this.moduleFor(inst);
    if (configuration !== undefined) {
      // Nobody's answer may be judged against a changed configuration: only while nobody has
      // played it (never opened, or reset). A closed challenge has to be reset first.
      const played = this.doc.attempts.some((a) => a.challengeInstanceId === inst.id);
      const open = inst.phase === 'PENDING' || inst.phase === 'ACTIVE';
      if (played || !open) throw invalidState('Players have already played this challenge; reset it first to change its configuration');
      const validated = validateConfiguration(loaded.module.configurationSchema, configuration);
      if (!validated.ok) throw validationError(`Invalid configuration: ${validated.errors.join('; ')}`);
      inst.configuration = validated.value;
      if (inst.moduleState !== null) this.restartModuleState(inst, loaded);
    }
    this.applyOptions(inst, loaded, options);
    this.commit();
    return inst;
  }

  /**
   * The configuration of an opened (but unplayed) instance changed: the module starts over
   * from the new configuration. An open instance stays open, without announcing it again.
   */
  private restartModuleState(inst: PersistedInstance, loaded: LoadedModule): void {
    this.cancelInstanceTimers(inst, true);
    inst.timers = [];
    inst.evaluation = null;
    inst.results = null;
    inst.error = null;
    inst.moduleState = null;
    inst.seed = randomSeed();
    this.rngs.delete(inst.id);
    // A hidden (re-locked) instance gets fresh state when the host unlocks it again.
    if (inst.phase !== 'ACTIVE') return;
    const ok = this.callModule(inst, () => {
      inst.moduleState = loaded.module.createInstance(inst.configuration, this.ctxFor(inst));
    });
    // A module that fails on the new configuration stays hidden (the error shows to the host).
    this.setPhase(inst, ok ? 'ACTIVE' : 'PENDING');
  }

  private applyOptions(inst: PersistedInstance, loaded: LoadedModule, options: Partial<InstanceOptions>): void {
    if (options.title !== undefined) {
      if (typeof options.title !== 'string') throw validationError('Title must be text');
      const title = options.title.trim().replace(/\s+/g, ' ');
      if (title.length > 80) throw validationError('Title must be at most 80 characters');
      inst.title = title;
    }
    if (options.category !== undefined) {
      if (typeof options.category !== 'string') throw validationError('Category must be text');
      const category = options.category.trim().replace(/\s+/g, ' ');
      if (category.length > 40) throw validationError('Category must be at most 40 characters');
      inst.category = category;
    }
    if (options.allowReplay !== undefined) {
      if (typeof options.allowReplay !== 'boolean') throw validationError('allowReplay must be true or false');
      if (options.allowReplay && loaded.manifest.results !== 'immediate') {
        throw validationError(`${loaded.manifest.name} scores everyone together when it closes, so it cannot be replayed`);
      }
      inst.allowReplay = options.allowReplay;
    }
    if (options.availability !== undefined) {
      if (!['open', 'host-unlocked', 'assigned'].includes(options.availability)) throw validationError('Invalid availability');
      inst.availability = options.availability;
    }
    if (options.assignedPlayerIds !== undefined) {
      if (!Array.isArray(options.assignedPlayerIds) || options.assignedPlayerIds.some((p) => typeof p !== 'string')) {
        throw validationError('assignedPlayerIds must be a list of player ids');
      }
      inst.assignedPlayerIds = [...new Set(options.assignedPlayerIds)];
    }
    if (options.evaluationMode !== undefined) {
      if (options.evaluationMode !== null) {
        const supported = loaded.manifest.evaluation.supportedModes ?? [loaded.manifest.evaluation.mode];
        if (!supported.includes(options.evaluationMode)) {
          throw validationError(`${loaded.manifest.name} supports evaluation modes: ${supported.join(', ')}`);
        }
      }
      inst.evaluationMode = options.evaluationMode;
    }
  }

  /** The game's configuration as a portable setup (media is filled in by the server). */
  exportSetup(): GameSetup {
    return {
      format: SETUP_FORMAT,
      version: SETUP_VERSION,
      exportedAt: new Date(this.deps.clock()).toISOString(),
      game: { name: this.doc.name, settings: structuredClone(this.doc.settings), branding: structuredClone(this.doc.branding) },
      challenges: this.doc.instances.map((inst) => ({
        moduleId: inst.moduleId,
        moduleVersion: inst.moduleVersion,
        title: inst.title,
        category: inst.category,
        configuration: structuredClone(inst.configuration),
        availability: inst.availability,
        evaluationMode: inst.evaluationMode,
        allowReplay: inst.allowReplay,
      })),
      media: {},
    };
  }

  removeChallenge(instanceId: string): void {
    this.assertNotFinished();
    const idx = this.doc.instances.findIndex((i) => i.id === instanceId);
    if (idx < 0) throw notFound('Challenge not found');
    const inst = this.doc.instances[idx]!;
    // Anything already played goes the way of a reset: points reversed, attempts dropped.
    this.wipeInstance(inst);
    this.doc.instances.splice(idx, 1);
    this.renumber();
    this.queueEvent('LEADERBOARD_UPDATED', 'all', { instanceId: inst.id });
    this.commit();
  }

  reorderChallenges(order: string[]): void {
    this.assertNotFinished();
    const byId = new Map(this.doc.instances.map((i) => [i.id, i]));
    if (order.length !== byId.size || new Set(order).size !== order.length || order.some((id) => !byId.has(id))) {
      throw validationError('Order must contain every challenge exactly once');
    }
    this.doc.instances = order.map((id) => byId.get(id)!);
    this.renumber();
    this.commit();
  }

  private renumber(): void {
    this.doc.instances.forEach((inst, i) => (inst.sortOrder = i));
  }

  // ---------------------------------------------------------------------------
  // Players (§8)
  // ---------------------------------------------------------------------------

  join(rawName: unknown): { player: PersistedPlayer; sessionToken: string; reclaimed: boolean } {
    if (this.doc.status === 'LOBBY') {
      // ok
    } else if (this.doc.status === 'IN_PROGRESS') {
      if (!this.doc.settings.allowLateJoin) throw invalidState('This game does not allow joining after it has started');
    } else if (this.doc.status === 'DRAFT') {
      throw invalidState('The host has not opened the lobby yet');
    } else {
      throw invalidState('This game has ended');
    }
    const check = sanitizeDisplayName(rawName);
    if (!check.ok) throw validationError(check.reason);

    const sessionToken = newToken();
    const now = this.deps.clock();
    const active = this.doc.players.filter((p) => p.removedAt === null);

    // FR-34: a freed slot can be reclaimed by joining with the same name.
    const reclaimable = active.find((p) => p.reclaimable && p.displayName.toLowerCase() === check.name.toLowerCase());
    if (reclaimable) {
      reclaimable.sessionTokenHash = hashToken(sessionToken);
      reclaimable.reclaimable = false;
      this.queueEvent('PLAYER_RECONNECTED', 'all', { playerId: reclaimable.id, displayName: reclaimable.displayName });
      this.commit();
      return { player: reclaimable, sessionToken, reclaimed: true };
    }
    if (active.length >= MAX_PLAYERS) throw invalidState(`This game is full (${MAX_PLAYERS} players)`);

    const player: PersistedPlayer = {
      id: newId('p'),
      gameId: this.doc.id,
      displayName: uniqueDisplayName(
        check.name,
        active.map((p) => p.displayName),
      ),
      sessionTokenHash: hashToken(sessionToken),
      joinedAt: now,
      removedAt: null,
      reclaimable: false,
    };
    this.doc.players.push(player);
    this.activity('joined', `${player.displayName} joined`, { playerId: player.id });
    // Open challenges that care (e.g. making room for a newcomer's blob) hear about it.
    for (const inst of this.doc.instances) {
      if (inst.phase !== 'ACTIVE' || inst.moduleState === null) continue;
      const loaded = this.moduleFor(inst);
      if (!loaded.module.onPlayerJoin) continue;
      this.callModule(inst, () => {
        inst.moduleState = loaded.module.onPlayerJoin!(inst.moduleState, this.playerRef(player), this.ctxFor(inst));
      });
    }
    this.queueEvent('PLAYER_JOINED', 'all', { playerId: player.id, displayName: player.displayName });
    this.commit();
    return { player, sessionToken, reclaimed: false };
  }

  connect(audience: SnapshotAudience): void {
    if (audience.role === 'host') this.hostConnections += 1;
    else if (audience.role === 'main') this.mainConnections += 1;
    else {
      const player = this.getPlayer(audience.playerId);
      if (!player || player.removedAt !== null) throw notFound('Player not found');
      const n = (this.playerConnections.get(player.id) ?? 0) + 1;
      this.playerConnections.set(player.id, n);
      if (n === 1 && this.everConnected.has(player.id)) {
        this.queueEvent('PLAYER_RECONNECTED', 'all', { playerId: player.id, displayName: player.displayName });
      }
      this.everConnected.add(player.id);
    }
    this.commit();
  }

  disconnect(audience: SnapshotAudience): void {
    if (audience.role === 'host') this.hostConnections = Math.max(0, this.hostConnections - 1);
    else if (audience.role === 'main') this.mainConnections = Math.max(0, this.mainConnections - 1);
    else {
      const n = Math.max(0, (this.playerConnections.get(audience.playerId) ?? 0) - 1);
      this.playerConnections.set(audience.playerId, n);
      if (n === 0) {
        const player = this.getPlayer(audience.playerId);
        if (player && player.removedAt === null) {
          this.queueEvent('PLAYER_DISCONNECTED', 'all', { playerId: player.id, displayName: player.displayName });
        }
      }
    }
    this.commit();
  }

  // ---------------------------------------------------------------------------
  // Attempts & submissions (§7.6, SR-2..SR-4)
  // ---------------------------------------------------------------------------

  /** Can this player start (or see) the instance right now? */
  private eligibility(inst: PersistedInstance, playerId: string): { visible: boolean; canStart: boolean } {
    const assigned = inst.availability === 'assigned';
    const isAssignee = inst.assignedPlayerIds.includes(playerId);
    const visible = !assigned || isAssignee || this.attemptOf(inst.id, playerId) !== undefined;
    const canStart = inst.phase === 'ACTIVE' && (!assigned || isAssignee);
    return { visible, canStart };
  }

  startAttempt(playerId: string, instanceId: string): PlayerResult {
    const player = this.getPlayer(playerId);
    if (!player || player.removedAt !== null) return { ok: false, reason: 'You are no longer in this game' };
    if (this.doc.status !== 'IN_PROGRESS') return { ok: false, reason: 'The game is not running' };
    if (this.doc.paused) return { ok: false, reason: 'The game is paused' };
    const inst = this.doc.instances.find((i) => i.id === instanceId);
    if (!inst) return { ok: false, reason: 'Challenge not found' };
    const { canStart } = this.eligibility(inst, playerId);
    if (!canStart) return { ok: false, reason: inst.phase === 'ACTIVE' ? 'This challenge is not available to you' : 'This challenge is not open' };
    const previous = this.attemptOf(inst.id, playerId);
    if (previous?.status === 'in_progress') return { ok: false, reason: 'You are already playing this challenge' };
    if (previous && !this.replayAllowed(inst)) return { ok: false, reason: 'You have already played this challenge' };
    const check = this.moduleStartCheck(inst, player);
    if (check && !check.ok) return { ok: false, reason: check.reason };
    if (!this.checkRateLimit(playerId)) return { ok: false, reason: 'Slow down a little' };

    const attempt: PersistedAttempt = {
      id: newId('t'),
      challengeInstanceId: inst.id,
      playerId,
      startedAt: this.deps.clock(),
      lockedAt: null,
      status: 'in_progress',
    };
    this.doc.attempts.push(attempt);
    const loaded = this.moduleFor(inst);
    if (loaded.module.onAttemptStart) {
      const ok = this.callModule(inst, () => {
        inst.moduleState = loaded.module.onAttemptStart!(inst.moduleState, this.playerRef(player), this.ctxFor(inst));
      });
      if (!ok) {
        this.doc.attempts = this.doc.attempts.filter((a) => a.id !== attempt.id);
        this.commit();
        return { ok: false, reason: 'The challenge could not start' };
      }
    }
    const again = previous ? ' again' : '';
    this.activity('started', `${player.displayName} started ${this.titleOf(inst)}${again}`, { playerId, instanceId: inst.id });
    this.queueEvent('ATTEMPT_STARTED', 'host', { playerId, instanceId: inst.id });
    this.commit();
    return { ok: true };
  }

  /** `final` locks the attempt right after this submission even when the module accepts replacements. */
  submit(playerId: string, instanceId: string, payload: unknown, final = false): PlayerResult {
    const player = this.getPlayer(playerId);
    if (!player || player.removedAt !== null) return { ok: false, reason: 'You are no longer in this game' };
    if (this.doc.status !== 'IN_PROGRESS') return { ok: false, reason: 'The game is not running' };
    if (this.doc.paused) return { ok: false, reason: 'The game is paused' };
    const inst = this.doc.instances.find((i) => i.id === instanceId);
    if (!inst) return { ok: false, reason: 'Challenge not found' };
    const attempt = this.attemptOf(inst.id, playerId);
    if (!attempt || attempt.status !== 'in_progress') return { ok: false, reason: 'Submissions are closed' };
    if (inst.phase !== 'ACTIVE' && inst.phase !== 'PENDING') return { ok: false, reason: 'Submissions are closed' };
    if (!this.checkRateLimit(playerId)) return { ok: false, reason: 'Too many submissions, slow down' };

    let size = 0;
    try {
      size = Buffer.byteLength(JSON.stringify(payload) ?? '', 'utf8');
    } catch {
      return { ok: false, reason: 'Invalid submission' };
    }
    if (size > MAX_PAYLOAD_BYTES) return { ok: false, reason: 'Submission too large' };

    const loaded = this.moduleFor(inst);
    const existing = this.submissionOf(attempt);
    if (existing && loaded.manifest.resubmission !== 'replace') return { ok: false, reason: 'You have already submitted' };

    const ref = this.playerRef(player);
    const ctx = this.ctxFor(inst);
    let verdict: { ok: true } | { ok: false; reason: string };
    try {
      verdict = loaded.module.validateInput(inst.moduleState, ref, payload, ctx);
    } catch (err) {
      this.recordModuleError(inst, err);
      this.commit();
      return { ok: false, reason: 'The challenge could not process your answer' };
    }
    if (!verdict.ok) return { ok: false, reason: verdict.reason };

    // FR-27: persist verbatim with server timestamp before evaluation.
    const submission: PersistedSubmission = {
      id: newId('s'),
      challengeInstanceId: inst.id,
      playerId,
      attemptId: attempt.id,
      payload: structuredClone(payload),
      submittedAt: this.deps.clock(),
      supersededBy: null,
      evaluation: null,
      scoredAt: null,
    };
    if (existing) existing.supersededBy = submission.id;
    this.doc.submissions.push(submission);
    this.callModule(inst, () => {
      inst.moduleState = loaded.module.handleInput(inst.moduleState, ref, payload, ctx);
    });
    this.queueEvent('PLAYER_SUBMITTED', 'all', { playerId, displayName: player.displayName, instanceId: inst.id });
    if (loaded.manifest.resubmission !== 'replace' || final) this.lockAttempt(inst, attempt);
    this.commit();
    return { ok: true };
  }

  /** Player ends their own attempt early (resubmission = replace). */
  finishAttempt(playerId: string, instanceId: string): PlayerResult {
    const player = this.getPlayer(playerId);
    if (!player || player.removedAt !== null) return { ok: false, reason: 'You are no longer in this game' };
    const inst = this.doc.instances.find((i) => i.id === instanceId);
    if (!inst) return { ok: false, reason: 'Challenge not found' };
    const attempt = this.attemptOf(inst.id, playerId);
    if (!attempt || attempt.status !== 'in_progress') return { ok: false, reason: 'Nothing to finish' };
    this.lockAttempt(inst, attempt);
    this.commit();
    return { ok: true };
  }

  /**
   * Live action (e.g. a batch of taps) for a module's `onAction`: not a submission, so
   * nothing is stored or evaluated per action. Snapshots are throttled (ACTION_COMMIT_MS).
   */
  /**
   * A player's own picture: a `media://` reference to their uploaded selfie (the server checks
   * the file), or null to go back to their icon. Shown on the big screen next to their name.
   */
  setAvatar(playerId: string, ref: string | null): PlayerResult {
    const player = this.getPlayer(playerId);
    if (!player || player.removedAt !== null) return { ok: false, reason: 'You are no longer in this game' };
    if (this.doc.status === 'FINISHED') return { ok: false, reason: 'This game is over' };
    if (ref !== null && !/^media:\/\/[A-Za-z0-9_-]+$/.test(ref)) return { ok: false, reason: 'That picture cannot be used' };
    player.avatar = ref;
    this.commit();
    return { ok: true };
  }

  moduleAction(playerId: string, instanceId: string, payload: unknown): PlayerResult {
    const player = this.getPlayer(playerId);
    if (!player || player.removedAt !== null) return { ok: false, reason: 'You are no longer in this game' };
    if (this.doc.status !== 'IN_PROGRESS') return { ok: false, reason: 'The game is not running' };
    if (this.doc.paused) return { ok: false, reason: 'The game is paused' };
    const inst = this.doc.instances.find((i) => i.id === instanceId);
    if (!inst) return { ok: false, reason: 'Challenge not found' };
    const loaded = this.moduleFor(inst);
    if (!loaded.module.onAction || !loaded.module.validateAction) return { ok: false, reason: 'This challenge takes no live actions' };
    if (inst.phase !== 'ACTIVE') return { ok: false, reason: 'This challenge is not open' };
    if (this.attemptOf(inst.id, playerId)?.status !== 'in_progress') return { ok: false, reason: 'Start the challenge first' };
    if (!this.checkActionRate(playerId)) return { ok: false, reason: 'Slow down a little' };
    let size = 0;
    try {
      size = Buffer.byteLength(JSON.stringify(payload) ?? '', 'utf8');
    } catch {
      return { ok: false, reason: 'Invalid action' };
    }
    if (size > MAX_ACTION_BYTES) return { ok: false, reason: 'Action too large' };
    const ref = this.playerRef(player);
    const ctx = this.ctxFor(inst);
    let verdict: { ok: true } | { ok: false; reason: string } = { ok: true };
    const ok = this.callModule(inst, () => {
      verdict = loaded.module.validateAction!(inst.moduleState, ref, payload, ctx);
      if (verdict.ok) inst.moduleState = loaded.module.onAction!(inst.moduleState, ref, structuredClone(payload), ctx);
    });
    if (!ok) {
      this.commit();
      return { ok: false, reason: 'The challenge could not process that' };
    }
    if (!verdict.ok) return verdict;
    this.commitSoon();
    return { ok: true };
  }

  private checkActionRate(playerId: string): boolean {
    const now = this.deps.clock();
    const bucket = (this.actionBuckets.get(playerId) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    const ok = bucket.length < ACTION_RATE_MAX;
    if (ok) bucket.push(now);
    this.actionBuckets.set(playerId, bucket);
    return ok;
  }

  /** Input closes for one player; evaluation starts for immediate-results modules. */
  private lockAttempt(inst: PersistedInstance, attempt: PersistedAttempt, closing = false): void {
    if (attempt.status !== 'in_progress') return;
    attempt.status = 'locked';
    attempt.lockedAt = this.deps.clock();
    this.cancelPlayerTimers(inst, attempt.playerId);
    const loaded = this.moduleFor(inst);
    const player = this.getPlayer(attempt.playerId);
    if (loaded.module.onAttemptLocked && player) {
      this.callModule(inst, () => {
        inst.moduleState = loaded.module.onAttemptLocked!(inst.moduleState, this.playerRef(player), this.ctxFor(inst));
      });
    }
    const submission = this.submissionOf(attempt);
    // An attempt the host's close ended without a submission did not "run out of time".
    if (player && (submission || !closing)) {
      const text = submission ? `${player.displayName} finished ${this.titleOf(inst)}` : `${player.displayName} ran out of time on ${this.titleOf(inst)}`;
      this.activity('submitted', text, { playerId: player.id, instanceId: inst.id });
    }
    if (submission && loaded.manifest.results === 'immediate') this.beginEvaluation(inst, submission);
  }

  private checkRateLimit(playerId: string): boolean {
    const now = this.deps.clock();
    const bucket = (this.rateBuckets.get(playerId) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (bucket.length >= RATE_LIMIT_MAX) {
      this.rateBuckets.set(playerId, bucket);
      return false;
    }
    bucket.push(now);
    this.rateBuckets.set(playerId, bucket);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Evaluation pipeline (§14)
  // ---------------------------------------------------------------------------

  private beginEvaluation(inst: PersistedInstance, submission: PersistedSubmission): void {
    const mode = this.effectiveMode(inst);
    if (mode === 'automatic') {
      this.scoreSubmission(inst, submission);
    } else if (mode === 'host') {
      this.createHostAssignment(inst, submission, 'host-mode', 0);
    } else {
      this.createPeerAssignment(inst, submission, 0, []);
    }
  }

  private deadlineSeconds(inst: PersistedInstance): number {
    return this.moduleFor(inst).manifest.evaluation.deadlineSeconds ?? this.doc.settings.judgeDeadlineSeconds;
  }

  /** FR-62: choose a judge. Returns undefined when nobody is eligible. */
  private pickJudge(inst: PersistedInstance, submission: PersistedSubmission, exclude: string[]): PersistedPlayer | undefined {
    const pendingByJudge = new Map<string, number>();
    for (const a of this.doc.assignments) {
      if (a.status === 'pending' && a.judgePlayerId) pendingByJudge.set(a.judgePlayerId, (pendingByJudge.get(a.judgePlayerId) ?? 0) + 1);
    }
    // Reciprocal pairs: the submitter is currently judging X → X must not judge the submitter.
    const reciprocal = new Set<string>();
    for (const a of this.doc.assignments) {
      if (a.status !== 'pending' || a.judgePlayerId !== submission.playerId || a.challengeInstanceId !== inst.id) continue;
      const s = this.doc.submissions.find((x) => x.id === a.submissionId);
      if (s) reciprocal.add(s.playerId);
    }
    const base = this.doc.players.filter(
      (p) => p.removedAt === null && p.id !== submission.playerId && !exclude.includes(p.id) && this.isPlayerConnected(p.id),
    );
    let candidates = base.filter((p) => !reciprocal.has(p.id));
    if (candidates.length === 0) candidates = base; // unavoidable with tiny groups (FR-62)
    if (candidates.length === 0) return undefined;
    const minPending = Math.min(...candidates.map((p) => pendingByJudge.get(p.id) ?? 0));
    const best = candidates.filter((p) => (pendingByJudge.get(p.id) ?? 0) === minPending);
    const rnd = this.deps.random ?? Math.random;
    return best[Math.floor(rnd() * best.length)];
  }

  private createPeerAssignment(inst: PersistedInstance, submission: PersistedSubmission, reassignments: number, exclude: string[]): void {
    const judge = this.pickJudge(inst, submission, exclude);
    if (!judge) {
      this.createHostAssignment(inst, submission, 'no-judges', reassignments);
      return;
    }
    const now = this.deps.clock();
    const assignment: PersistedAssignment = {
      id: newId('e'),
      challengeInstanceId: inst.id,
      submissionId: submission.id,
      judgePlayerId: judge.id,
      status: 'pending',
      reason: reassignments === 0 ? 'peer' : 'reassigned',
      assignedAt: now,
      deadlineAt: now + this.deadlineSeconds(inst) * 1000,
      decidedAt: null,
      decidedBy: null,
      decision: null,
      points: null,
      note: null,
      reassignments,
    };
    this.doc.assignments.push(assignment);
    if (!this.doc.paused) this.armAssignmentTimer(assignment, assignment.deadlineAt! - now);
    // FR-63: only the judge (and the host) learns about the assignment.
    this.queueEvent('EVALUATION_ASSIGNED', `player:${judge.id}`, { assignmentId: assignment.id, instanceId: inst.id, deadlineAt: assignment.deadlineAt });
    this.queueEvent('EVALUATION_ASSIGNED', 'host', { assignmentId: assignment.id, instanceId: inst.id, judgePlayerId: judge.id });
  }

  private createHostAssignment(inst: PersistedInstance, submission: PersistedSubmission, reason: string, reassignments: number): PersistedAssignment {
    const assignment: PersistedAssignment = {
      id: newId('e'),
      challengeInstanceId: inst.id,
      submissionId: submission.id,
      judgePlayerId: null,
      status: 'pending',
      reason,
      assignedAt: this.deps.clock(),
      deadlineAt: null,
      decidedAt: null,
      decidedBy: null,
      decision: null,
      points: null,
      note: null,
      reassignments,
    };
    this.doc.assignments.push(assignment);
    this.queueEvent('EVALUATION_ESCALATED', 'host', { assignmentId: assignment.id, instanceId: inst.id, submissionId: submission.id, reason });
    return assignment;
  }

  private armAssignmentTimer(assignment: PersistedAssignment, ms: number): void {
    const key = assignmentKey(assignment.id);
    const existing = this.timerHandles.get(key);
    if (existing !== undefined) this.deps.clearTimer(existing);
    this.timerHandles.set(key, this.deps.setTimer(() => this.onAssignmentDeadline(assignment.id), Math.max(0, ms)));
  }

  private clearAssignmentTimer(assignmentId: string): void {
    const key = assignmentKey(assignmentId);
    const h = this.timerHandles.get(key);
    if (h !== undefined) this.deps.clearTimer(h);
    this.timerHandles.delete(key);
  }

  /** FR-64: deadline passed → reassign or escalate. */
  private onAssignmentDeadline(assignmentId: string): void {
    if (this.disposed) return;
    this.timerHandles.delete(assignmentKey(assignmentId));
    const a = this.getAssignment(assignmentId);
    if (!a || a.status !== 'pending' || this.doc.paused) return;
    a.status = 'expired';
    a.decidedAt = this.deps.clock();
    const inst = this.doc.instances.find((i) => i.id === a.challengeInstanceId);
    const submission = this.doc.submissions.find((s) => s.id === a.submissionId);
    if (inst && submission && !submission.scoredAt) {
      const previousJudges = this.doc.assignments.filter((x) => x.submissionId === submission.id && x.judgePlayerId).map((x) => x.judgePlayerId!);
      if (a.reassignments < this.doc.settings.maxReassignments) {
        this.createPeerAssignment(inst, submission, a.reassignments + 1, previousJudges);
      } else {
        this.createHostAssignment(inst, submission, 'escalated-timeout', a.reassignments);
      }
    }
    this.commit();
  }

  /** SR-11: a peer judge decides on exactly the assignment given to them, while pending and before its deadline. */
  judge(playerId: string, assignmentId: string, decision: 'approve' | 'reject', note?: string): PlayerResult {
    const player = this.getPlayer(playerId);
    if (!player || player.removedAt !== null) return { ok: false, reason: 'You are no longer in this game' };
    if (decision !== 'approve' && decision !== 'reject') return { ok: false, reason: 'Decision must be approve or reject' };
    const a = this.getAssignment(assignmentId);
    if (!a || a.judgePlayerId !== playerId) return { ok: false, reason: 'This is not your judging task' };
    if (a.status !== 'pending') return { ok: false, reason: 'This task is no longer open' };
    if (a.deadlineAt !== null && this.deps.clock() > a.deadlineAt) return { ok: false, reason: 'The deadline for this task has passed' };
    if (this.doc.paused) return { ok: false, reason: 'The game is paused' };
    const inst = this.doc.instances.find((i) => i.id === a.challengeInstanceId);
    const submission = this.doc.submissions.find((s) => s.id === a.submissionId);
    if (!inst || !submission) return { ok: false, reason: 'Submission no longer exists' };

    this.clearAssignmentTimer(a.id);
    a.status = decision === 'approve' ? 'approved' : 'rejected';
    a.decision = decision;
    a.decidedBy = 'peer';
    a.decidedAt = this.deps.clock();
    a.note = typeof note === 'string' && note.trim() ? note.trim().slice(0, 200) : null;
    this.queueEvent('EVALUATION_DECIDED', 'host', { assignmentId: a.id, instanceId: inst.id, decision, by: 'peer' });

    const mode = this.effectiveMode(inst);
    if (mode === 'hybrid' && decision === 'reject') {
      // FR-68: rejections surface in the host queue before they count.
      this.createHostAssignment(inst, submission, 'escalated-rejection', a.reassignments);
    } else if (!submission.scoredAt) {
      this.scoreSubmission(inst, submission);
    }
    this.commit();
    return { ok: true };
  }

  private judgementsFor(submission: PersistedSubmission): Judgement[] {
    return this.doc.assignments
      .filter((a) => a.submissionId === submission.id && a.decision !== null && a.status !== 'overridden')
      .sort((a, b) => (a.decidedAt ?? 0) - (b.decidedAt ?? 0))
      .map((a) => ({
        assignmentId: a.id,
        by: a.decidedBy ?? 'peer',
        judgePlayerId: a.judgePlayerId,
        decision: a.decision!,
        points: a.points ?? undefined,
        note: a.note ?? undefined,
        decidedAt: a.decidedAt ?? 0,
      }));
  }

  private toSubmission(inst: PersistedInstance, s: PersistedSubmission): Submission {
    const attempt = this.attemptById(s.attemptId);
    return {
      id: s.id,
      playerId: s.playerId,
      payload: structuredClone(s.payload),
      startedAt: attempt?.startedAt ?? s.submittedAt,
      submittedAt: s.submittedAt,
      judgements: this.judgementsFor(s),
    };
  }

  /** Immediate results: evaluate one submission and write its awards to the ledger. */
  private scoreSubmission(inst: PersistedInstance, submission: PersistedSubmission): void {
    const loaded = this.moduleFor(inst);
    const ctx = this.ctxFor(inst);
    let evaluation: unknown;
    let scores: ScoreAward[] = [];
    const ok = this.callModule(inst, () => {
      evaluation = loaded.module.evaluate(inst.moduleState, [this.toSubmission(inst, submission)], ctx);
      scores = loaded.module.calculateScores(inst.moduleState, evaluation, ctx);
    });
    if (!ok) return; // host retries (FR-52)
    submission.evaluation = evaluation ?? null;
    submission.scoredAt = this.deps.clock();
    this.writeAwards(inst, scores, `submission:${submission.id}`);
    const attempt = this.attemptById(submission.attemptId);
    if (attempt) attempt.status = 'scored';
    this.settleBestAttempt(inst, submission.playerId);
    const player = this.getPlayer(submission.playerId);
    const own = scores.filter((s) => s.playerId === submission.playerId).reduce((a, s) => a + s.points, 0);
    if (player) this.activity('scored', `${player.displayName} scored ${fmtPoints(own)} on ${this.titleOf(inst)}`, { playerId: player.id, instanceId: inst.id, points: own });
    // Points stay with the host until results are revealed.
    this.queueEvent('PLAYER_SCORED', this.doc.resultsRevealed ? 'all' : 'host', { playerId: submission.playerId, instanceId: inst.id, points: own });
    this.queueEvent('LEADERBOARD_UPDATED', 'all', { instanceId: inst.id });
    this.maybeFinalizeImmediate(inst);
  }

  /** Net points the ledger holds for one submission's own awards (after reversals). */
  private submissionPoints(inst: PersistedInstance, submission: PersistedSubmission): number {
    const tag = `[submission:${submission.id}]`;
    const ids = new Set<string>();
    let total = 0;
    for (const r of this.doc.ledger) {
      if (r.challengeInstanceId !== inst.id || r.playerId !== submission.playerId || r.source !== 'module') continue;
      if (r.reason?.endsWith(tag)) {
        ids.add(r.id);
        total += r.points;
      }
    }
    for (const r of this.doc.ledger) {
      const reversed = r.reason ? REVERSAL.exec(r.reason)?.[1] : undefined;
      if (reversed && ids.has(reversed)) total += r.points;
    }
    return Math.round(total * 100) / 100;
  }

  /**
   * Replays: a player's points for an instance equal their best attempt. Every attempt's
   * own awards stay in the (append-only) ledger; an adjustment row tagged `[best:<player>]`
   * brings the total back to the best one. Idempotent.
   */
  private settleBestAttempt(inst: PersistedInstance, playerId: string): void {
    if (this.isRepeat(inst) || this.attemptsOf(inst.id, playerId).length < 2) return;
    const subs = this.doc.submissions.filter((s) => s.challengeInstanceId === inst.id && s.playerId === playerId && !s.supersededBy);
    const scored = subs.filter((s) => s.scoredAt !== null).map((s) => this.submissionPoints(inst, s));
    const best = scored.length ? Math.max(...scored) : 0;
    const bestTag = `[best:${playerId}]`;
    let current = subs.reduce((a, s) => a + this.submissionPoints(inst, s), 0);
    for (const r of this.doc.ledger) {
      if (r.challengeInstanceId === inst.id && r.playerId === playerId && r.source === 'module' && r.reason?.endsWith(bestTag)) current += r.points;
    }
    const delta = Math.round((best - current) * 100) / 100;
    if (delta === 0) return;
    this.doc.ledger.push({
      id: newId('a'),
      gameId: this.doc.id,
      challengeInstanceId: inst.id,
      playerId,
      points: delta,
      source: 'module',
      reason: `Only the best attempt counts ${bestTag}`,
      createdAt: this.deps.clock(),
    });
  }

  private writeAwards(inst: PersistedInstance, scores: ScoreAward[], tag: string): ScoreAward[] {
    const validPlayers = new Set(this.doc.players.filter((p) => p.removedAt === null).map((p) => p.id));
    const now = this.deps.clock();
    const cleaned: ScoreAward[] = [];
    for (const award of Array.isArray(scores) ? scores : []) {
      if (!award || !validPlayers.has(award.playerId)) continue;
      const points = Number(award.points);
      if (!Number.isFinite(points)) continue;
      const rounded = Math.round(points * 100) / 100;
      cleaned.push({ playerId: award.playerId, points: rounded, reason: award.reason });
      // FR-40: append-only ledger, written only from module output.
      this.doc.ledger.push({
        id: newId('a'),
        gameId: this.doc.id,
        challengeInstanceId: inst.id,
        playerId: award.playerId,
        points: rounded,
        source: 'module',
        reason: award.reason ? `${award.reason} [${tag}]` : `[${tag}]`,
        createdAt: now,
      });
    }
    return cleaned;
  }

  /** Reverse every module award tagged for a submission (append-only, FR-40). */
  private reverseAwards(inst: PersistedInstance, tag: string, reason: string): void {
    const now = this.deps.clock();
    const rows = this.doc.ledger.filter((r) => r.challengeInstanceId === inst.id && r.source === 'module' && r.reason?.endsWith(`[${tag}]`));
    const alreadyReversed = new Set(
      this.doc.ledger.filter((r) => r.reason?.startsWith(`${reason}:`)).map((r) => r.reason!.slice(reason.length + 1)),
    );
    for (const row of rows) {
      if (alreadyReversed.has(row.id)) continue;
      this.doc.ledger.push({
        id: newId('a'),
        gameId: this.doc.id,
        challengeInstanceId: inst.id,
        playerId: row.playerId,
        points: -row.points,
        source: 'module',
        reason: `${reason}:${row.id}`,
        createdAt: now,
      });
    }
  }

  private pendingAssignments(inst: PersistedInstance): PersistedAssignment[] {
    return this.doc.assignments.filter((a) => a.challengeInstanceId === inst.id && a.status === 'pending');
  }

  /** Immediate modules reach RESULTS once closed and nothing is left to judge. */
  private maybeFinalizeImmediate(inst: PersistedInstance): void {
    if (inst.phase !== 'LOCKED') return;
    if (this.moduleFor(inst).manifest.results !== 'immediate') return;
    if (this.pendingAssignments(inst).length > 0) return;
    const unscored = this.doc.submissions.some((s) => s.challengeInstanceId === inst.id && !s.supersededBy && !s.scoredAt);
    if (unscored) return;
    this.finalize(inst);
  }

  private finalize(inst: PersistedInstance): void {
    const loaded = this.moduleFor(inst);
    const ctx = this.ctxFor(inst);
    let statistics: Record<string, unknown> = {};
    this.callModule(inst, () => {
      statistics = loaded.module.getStatistics(inst.moduleState, this.evaluationsOf(inst), ctx) ?? {};
    });
    const scores = this.doc.ledger
      .filter((r) => r.challengeInstanceId === inst.id && r.source === 'module')
      .reduce<Map<string, number>>((m, r) => m.set(r.playerId, (m.get(r.playerId) ?? 0) + r.points), new Map());
    inst.results = { scores: [...scores.entries()].map(([playerId, points]) => ({ playerId, points: Math.round(points * 100) / 100 })), statistics };
    this.setPhase(inst, 'RESULTS');
    this.activity('results', `Results are in for ${this.titleOf(inst)}`, { instanceId: inst.id });
    this.queueEvent('RESULTS_AVAILABLE', 'all', { instanceId: inst.id, moduleId: inst.moduleId });
  }

  /** onClose modules: aggregate evaluation when the instance closes. */
  private runAggregate(inst: PersistedInstance): void {
    const loaded = this.moduleFor(inst);
    const ctx = this.ctxFor(inst);
    const submissions = this.doc.submissions
      .filter((s) => s.challengeInstanceId === inst.id && !s.supersededBy && this.getPlayer(s.playerId)?.removedAt === null)
      .map((s) => this.toSubmission(inst, s));
    const ok = this.callModule(inst, () => {
      inst.evaluation = loaded.module.evaluate(inst.moduleState, submissions, ctx);
    });
    if (!ok) return;
    if (loaded.module.hostResolutionView) {
      this.setPhase(inst, 'EVALUATING');
    } else {
      this.finalizeAggregate(inst);
    }
  }

  private finalizeAggregate(inst: PersistedInstance): void {
    const loaded = this.moduleFor(inst);
    const ctx = this.ctxFor(inst);
    let scores: ScoreAward[] = [];
    const ok = this.callModule(inst, () => {
      scores = loaded.module.calculateScores(inst.moduleState, inst.evaluation, ctx);
    });
    if (!ok) return;
    this.writeAwards(inst, scores, `instance:${inst.id}`);
    const now = this.deps.clock();
    for (const s of this.doc.submissions) {
      if (s.challengeInstanceId === inst.id && !s.supersededBy) {
        s.scoredAt = now;
        s.evaluation = null;
      }
    }
    for (const a of this.doc.attempts) if (a.challengeInstanceId === inst.id && a.status === 'locked') a.status = 'scored';
    this.queueEvent('LEADERBOARD_UPDATED', 'all', { instanceId: inst.id });
    this.finalize(inst);
  }

  /** Evaluations handed to `getStatistics`/`resultsView`: with replays, each player's best attempt only. */
  private evaluationsOf(inst: PersistedInstance): unknown[] {
    if (this.moduleFor(inst).manifest.results === 'onClose') return inst.evaluation === null ? [] : [inst.evaluation];
    if (this.isRepeat(inst)) {
      return this.doc.submissions.filter((s) => s.challengeInstanceId === inst.id && !s.supersededBy && s.scoredAt !== null).map((s) => s.evaluation);
    }
    const byPlayer = new Map<string, PersistedSubmission[]>();
    for (const s of this.doc.submissions) {
      if (s.challengeInstanceId !== inst.id || s.supersededBy || s.scoredAt === null) continue;
      byPlayer.set(s.playerId, [...(byPlayer.get(s.playerId) ?? []), s]);
    }
    return [...byPlayer.values()].map((subs) => {
      if (subs.length === 1) return subs[0]!.evaluation;
      // Highest points wins; the earliest attempt that reached them on a tie.
      let best = subs[0]!;
      let bestPoints = this.submissionPoints(inst, best);
      for (const s of subs.slice(1)) {
        const p = this.submissionPoints(inst, s);
        if (p > bestPoints) {
          best = s;
          bestPoints = p;
        }
      }
      return best.evaluation;
    });
  }

  // ---------------------------------------------------------------------------
  // Host actions
  // ---------------------------------------------------------------------------

  performHostAction(action: HostAction): HostActionResult {
    // Revealing stays possible after the game is closed, so hidden results are never lost,
    // and a closed game can be continued.
    // So does the results presentation, which is what a closed game is for.
    if (!ALWAYS_ALLOWED.has(action.action)) this.assertNotFinished();
    switch (action.action) {
      case 'start-presentation':
        return this.startPresentation(action.instanceIds, action.autoplay === true);
      case 'move-presentation':
        return this.movePresentation(action.to);
      case 'autoplay-presentation':
        return this.autoplayPresentation(action.on === true);
      case 'stop-presentation':
        return this.stopPresentation();
      case 'reopen-game':
        return this.reopenGame();
      case 'publish-standings':
        return this.publishStandings();
      case 'show-spotlight':
        return this.showSpotlight(action.instanceId, action.itemId, action.hold === true);
      case 'release-spotlight':
        return this.releaseSpotlight();
      case 'reveal-results':
        return this.setResultsRevealed(true);
      case 'hide-results':
        return this.setResultsRevealed(false);
      case 'open-lobby':
        return this.openLobby();
      case 'start-game':
        return this.startGame();
      case 'end-game':
        return this.endGame();
      case 'close-game':
        return this.closeGame();
      case 'pause':
        return this.pause();
      case 'resume':
        return this.resume();
      case 'unlock-challenge':
        return this.unlockChallenge(action.instanceId);
      case 'relock-challenge':
        return this.relockChallenge(action.instanceId);
      case 'close-challenge':
        return this.closeChallenge(action.instanceId);
      case 'reopen-challenge':
        return this.reopenChallenge(action.instanceId);
      case 'reopen-all-challenges':
        return this.reopenAllChallenges();
      case 'reset-challenge':
        return this.resetChallenge(action.instanceId);
      case 'reopen-for-player':
        return this.reopenForPlayer(action.instanceId, action.playerId);
      case 'assign-challenge':
        return this.assignChallenge(action.instanceId, action.playerIds);
      case 'remove-player':
        return this.removePlayer(action.playerId);
      case 'clear-avatar': {
        const player = this.getPlayer(action.playerId);
        if (!player) throw notFound('Player not found');
        player.avatar = null;
        this.commit();
        return { ok: true };
      }
      case 'free-player':
        return this.freePlayer(action.playerId);
      case 'decide':
        return this.hostDecide(action.assignmentId, action.decision, action.points, action.note);
      case 'override':
        return this.hostOverride(action.submissionId, action.decision, action.points, action.reason);
      case 'resolve':
        return this.hostResolve(action.instanceId, action.payload);
      case 'retry-evaluation':
        return this.retryEvaluation(action.instanceId);
      case 'adjust-score':
        return this.adjustScore(action.playerId, action.points, action.reason);
      default:
        throw validationError(`Unknown action ${(action as { action: string }).action}`);
    }
  }

  /** Points, rankings and results become visible to players and the main display (or hidden again). */
  /** Copy the live standings to the big screen and record who moved up since the last copy. */
  private publishStandings(): HostActionResult {
    const now = this.deps.clock();
    const entries: PublishedStanding[] = this.liveLeaderboard().map((e) => ({
      playerId: e.playerId,
      displayName: e.displayName,
      rank: e.rank,
      total: e.total,
      completed: e.completed,
      series: e.series,
    }));
    const changes = diffStandings(this.doc.standings?.entries ?? null, entries, now);
    this.doc.standings = { publishedAt: now, entries };
    this.doc.standingsFeed.push(...changes);
    if (this.doc.standingsFeed.length > STANDINGS_FEED_LIMIT) this.doc.standingsFeed.splice(0, this.doc.standingsFeed.length - STANDINGS_FEED_LIMIT);
    this.queueEvent('STANDINGS_PUBLISHED', 'main', { changes: changes.length });
    this.queueEvent('STANDINGS_PUBLISHED', 'host', { changes: changes.length });
    this.commit();
    const n = changes.length;
    return { ok: true, message: n ? `Big screen updated: ${n} ${n === 1 ? 'change' : 'changes'} in the ranking` : 'Big screen updated: no changes in the ranking' };
  }

  private liveLeaderboard(): LeaderboardEntry[] {
    return computeLeaderboard({
      players: this.doc.players,
      ledger: this.doc.ledger,
      instances: this.doc.instances,
      attempts: this.doc.attempts,
      submissions: this.doc.submissions,
      tieBreak: this.doc.settings.tieBreak,
      connected: (id) => this.isPlayerConnected(id),
    });
  }

  private setResultsRevealed(revealed: boolean): HostActionResult {
    if (this.doc.resultsRevealed === revealed) return { ok: true };
    this.doc.resultsRevealed = revealed;
    this.queueEvent(revealed ? 'RESULTS_REVEALED' : 'RESULTS_HIDDEN', 'all', {});
    this.commit();
    return { ok: true };
  }

  private openLobby(): HostActionResult {
    if (this.doc.status !== 'DRAFT') throw invalidState('Lobby can only be opened from DRAFT');
    this.doc.status = 'LOBBY';
    this.commit();
    return { ok: true };
  }

  /** The board opens: every non-host-gated challenge becomes ACTIVE. */
  private startGame(): HostActionResult {
    if (this.doc.status !== 'LOBBY') throw invalidState('Game can only be started from the lobby');
    if (this.doc.instances.length === 0) throw invalidState('Add at least one challenge before starting');
    this.doc.status = 'IN_PROGRESS';
    this.doc.startedAt = this.deps.clock();
    for (const inst of this.doc.instances) {
      if (inst.phase === 'PENDING' && inst.availability !== 'host-unlocked') this.openInstance(inst);
    }
    this.updateSpotlight();
    this.queueEvent('GAME_STARTED', 'all', {});
    this.commit();
    return { ok: true };
  }

  private openInstance(inst: PersistedInstance): void {
    const loaded = this.moduleFor(inst);
    if (inst.moduleState === null) {
      inst.seed = randomSeed();
      this.rngs.delete(inst.id);
      const ok = this.callModule(inst, () => {
        inst.moduleState = loaded.module.createInstance(inst.configuration, this.ctxFor(inst));
      });
      if (!ok) return;
    }
    inst.openedAt = this.deps.clock();
    inst.error = null;
    this.setPhase(inst, 'ACTIVE');
    if (inst.availability !== 'assigned') this.activity('unlocked', `${this.titleOf(inst)} is open`, { instanceId: inst.id });
    this.queueEvent('CHALLENGE_UNLOCKED', 'all', { instanceId: inst.id, moduleId: inst.moduleId });
  }

  private unlockChallenge(instanceId: string): HostActionResult {
    this.assertInProgress();
    const inst = this.getInstance(instanceId);
    if (inst.phase !== 'PENDING') throw invalidState(`Challenge is ${inst.phase}`);
    this.openInstance(inst);
    this.commit();
    return { ok: true };
  }

  /** Hide again from players who have not started; running attempts continue. */
  private relockChallenge(instanceId: string): HostActionResult {
    this.assertInProgress();
    const inst = this.getInstance(instanceId);
    if (inst.phase !== 'ACTIVE') throw invalidState(`Challenge is ${inst.phase}`);
    this.setPhase(inst, 'PENDING');
    this.commit();
    return { ok: true };
  }

  private closeChallenge(instanceId: string): HostActionResult {
    const inst = this.getInstance(instanceId);
    if (inst.phase !== 'ACTIVE' && inst.phase !== 'PENDING') throw invalidState(`Challenge is ${inst.phase}`);
    if (inst.moduleState === null) throw invalidState('Challenge was never opened');
    this.closeInstance(inst);
    this.commit();
    return { ok: true };
  }

  private closeInstance(inst: PersistedInstance): void {
    const loaded = this.moduleFor(inst);
    inst.closedAt = this.deps.clock();
    this.cancelInstanceTimers(inst, true);
    for (const attempt of this.doc.attempts) {
      if (attempt.challengeInstanceId === inst.id && attempt.status === 'in_progress') this.lockAttempt(inst, attempt, true);
    }
    this.setPhase(inst, 'LOCKED');
    this.activity('closed', `${this.titleOf(inst)} is closed`, { instanceId: inst.id });
    this.queueEvent('CHALLENGE_LOCKED', 'all', { instanceId: inst.id });
    if (loaded.manifest.results === 'onClose') this.runAggregate(inst);
    else this.maybeFinalizeImmediate(inst);
  }

  private reopenChallenge(instanceId: string): HostActionResult {
    this.assertInProgress();
    const inst = this.getInstance(instanceId);
    if (inst.phase === 'ACTIVE' || inst.phase === 'PENDING') throw invalidState('Challenge is already open');
    this.reopenInstance(inst);
    this.commit();
    return { ok: true };
  }

  /** Every closed challenge open again, e.g. after the host continued a closed game. */
  private reopenAllChallenges(): HostActionResult {
    this.assertInProgress();
    const closed = this.doc.instances.filter((i) => i.phase === 'LOCKED' || i.phase === 'EVALUATING' || i.phase === 'RESULTS');
    for (const inst of closed) this.reopenInstance(inst);
    this.commit();
    return { ok: true, message: closed.length ? `${closed.length} ${closed.length === 1 ? 'challenge' : 'challenges'} open again` : 'Every challenge is already open' };
  }

  /**
   * A closed instance back to ACTIVE. Players who already played keep their result. Points an
   * `onClose` module awarded at the close are taken back (append-only reversal rows): it scores
   * everyone again at the next close. Live-action ones (Hot Takes, Blob War) also give players
   * their attempt back, so they carry on answering or pumping where they were.
   */
  private reopenInstance(inst: PersistedInstance): void {
    const loaded = this.moduleFor(inst);
    if (loaded.manifest.results === 'onClose') {
      const before = this.doc.ledger.length;
      this.reverseAwards(inst, `instance:${inst.id}`, 'reopen-reversal');
      if (this.doc.ledger.length > before) this.queueEvent('LEADERBOARD_UPDATED', 'all', { instanceId: inst.id });
      const closedAt = inst.closedAt;
      if (loaded.module.onAction && closedAt !== null) {
        for (const a of this.doc.attempts) {
          // Locked by the close itself, without a submission: still playing, really.
          if (a.challengeInstanceId !== inst.id || a.status === 'in_progress' || a.lockedAt === null || a.lockedAt < closedAt || this.submissionOf(a)) continue;
          a.status = 'in_progress';
          a.lockedAt = null;
        }
      }
    }
    inst.evaluation = null;
    inst.results = null;
    inst.closedAt = null;
    this.setPhase(inst, 'ACTIVE');
  }

  /** Wipe everything about an instance (points reversed) so it can be played again. */
  private resetChallenge(instanceId: string): HostActionResult {
    const inst = this.getInstance(instanceId);
    this.wipeInstance(inst);
    inst.openedAt = null;
    inst.closedAt = null;
    inst.phase = 'PENDING';
    if (this.doc.status === 'IN_PROGRESS' && inst.availability !== 'host-unlocked') this.openInstance(inst);
    this.queueEvent('LEADERBOARD_UPDATED', 'all', { instanceId: inst.id });
    this.commit();
    return { ok: true };
  }

  /** Cancel an instance's timers and judging, reverse its points, drop its attempts and state. */
  private wipeInstance(inst: PersistedInstance): void {
    this.cancelInstanceTimers(inst, true);
    for (const a of this.doc.assignments) {
      if (a.challengeInstanceId === inst.id && a.status === 'pending') {
        a.status = 'cancelled';
        this.clearAssignmentTimer(a.id);
      }
    }
    // Ledger stays append-only: reverse every module award for this instance.
    const now = this.deps.clock();
    const rows = this.doc.ledger.filter((r) => r.challengeInstanceId === inst.id && r.source === 'module');
    const reversed = new Set(this.doc.ledger.filter((r) => r.reason?.startsWith('reset-reversal:')).map((r) => r.reason!.slice('reset-reversal:'.length)));
    for (const row of rows) {
      if (row.reason?.startsWith('reset-reversal:') || reversed.has(row.id)) continue;
      this.doc.ledger.push({ id: newId('a'), gameId: this.doc.id, challengeInstanceId: inst.id, playerId: row.playerId, points: -row.points, source: 'module', reason: `reset-reversal:${row.id}`, createdAt: now });
    }
    this.doc.attempts = this.doc.attempts.filter((a) => a.challengeInstanceId !== inst.id);
    this.doc.submissions = this.doc.submissions.filter((s) => s.challengeInstanceId !== inst.id);
    this.doc.assignments = this.doc.assignments.filter((a) => a.challengeInstanceId !== inst.id);
    inst.moduleState = null;
    inst.evaluation = null;
    inst.results = null;
    inst.timers = [];
    inst.error = null;
    this.rngs.delete(inst.id);
  }

  private assignChallenge(instanceId: string, playerIds: string[]): HostActionResult {
    const inst = this.getInstance(instanceId);
    if (!Array.isArray(playerIds)) throw validationError('playerIds must be a list');
    const valid = new Set(this.doc.players.filter((p) => p.removedAt === null).map((p) => p.id));
    inst.assignedPlayerIds = [...new Set(playerIds.filter((id) => valid.has(id)))];
    inst.availability = 'assigned';
    if (this.doc.status === 'IN_PROGRESS' && inst.phase === 'PENDING' && inst.moduleState === null) this.openInstance(inst);
    this.commit();
    return { ok: true };
  }

  private pause(): HostActionResult {
    this.assertInProgress();
    if (this.doc.paused) return { ok: true };
    this.doc.paused = true;
    const now = this.deps.clock();
    for (const inst of this.doc.instances) {
      for (const t of inst.timers) {
        if (t.remainingMs === null) {
          t.remainingMs = Math.max(0, t.endsAt - now);
          this.clearHandle(timerKey(inst.id, t.playerId, t.tag));
        }
      }
    }
    for (const a of this.doc.assignments) {
      if (a.status === 'pending' && a.deadlineAt !== null) {
        this.clearAssignmentTimer(a.id);
        a.deadlineAt = -Math.max(0, a.deadlineAt - now); // negative = remaining ms while paused
      }
    }
    this.queueEvent('GAME_PAUSED', 'all', {});
    this.commit();
    return { ok: true };
  }

  private resume(): HostActionResult {
    this.assertInProgress();
    if (!this.doc.paused) return { ok: true };
    this.doc.paused = false;
    const now = this.deps.clock();
    for (const inst of this.doc.instances) {
      for (const t of inst.timers) {
        if (t.remainingMs !== null) {
          t.startedAt = now;
          t.endsAt = now + t.remainingMs;
          t.remainingMs = null;
          this.armInstanceTimer(inst, t.playerId, t.tag, t.endsAt - now);
        }
      }
    }
    for (const a of this.doc.assignments) {
      if (a.status === 'pending' && a.deadlineAt !== null && a.deadlineAt <= 0) {
        a.deadlineAt = now + -a.deadlineAt;
        this.armAssignmentTimer(a, a.deadlineAt - now);
      }
    }
    this.updateSpotlight();
    this.queueEvent('GAME_RESUMED', 'all', {});
    this.commit();
    return { ok: true };
  }

  /** FR-19: end early from any state, preserving partial results. */
  private endGame(): HostActionResult {
    if (this.doc.status === 'GAME_RESULTS') return { ok: true };
    if (this.doc.paused) this.resume();
    for (const inst of this.doc.instances) {
      if ((inst.phase === 'ACTIVE' || inst.phase === 'PENDING') && inst.moduleState !== null) this.closeInstance(inst);
    }
    // Pending peer tasks cannot be completed after the game ends: hand them to the host.
    for (const a of [...this.doc.assignments]) {
      if (a.status === 'pending' && a.judgePlayerId) {
        this.clearAssignmentTimer(a.id);
        a.status = 'expired';
        a.decidedAt = this.deps.clock();
        const inst = this.doc.instances.find((i) => i.id === a.challengeInstanceId);
        const s = this.doc.submissions.find((x) => x.id === a.submissionId);
        if (inst && s && !s.scoredAt) this.createHostAssignment(inst, s, 'escalated-timeout', a.reassignments);
      }
    }
    this.doc.status = 'GAME_RESULTS';
    this.doc.finishedAt = this.deps.clock();
    this.updateSpotlight();
    this.queueEvent('GAME_FINISHED', 'all', {});
    this.commit();
    return { ok: true };
  }

  /**
   * Continue an ended (GAME_RESULTS) or closed (FINISHED) game: back to IN_PROGRESS with
   * every player, attempt and point kept. Challenges stay as they were; the host reopens
   * the ones that should be playable again. Results go back to hidden for the new round.
   */
  private reopenGame(): HostActionResult {
    if (this.doc.status !== 'GAME_RESULTS' && this.doc.status !== 'FINISHED') throw invalidState('Only an ended game can be continued');
    const wasClosed = this.doc.status === 'FINISHED';
    // A closed game's code may have been handed to another game meanwhile (SR-7).
    if (wasClosed && this.deps.reclaimCode) this.doc.code = this.deps.reclaimCode(this.doc.code, this.doc.id);
    this.doc.status = 'IN_PROGRESS';
    this.doc.finishedAt = null;
    if (this.doc.resultsRevealed) {
      this.doc.resultsRevealed = false;
      this.queueEvent('RESULTS_HIDDEN', 'all', {});
    }
    this.updateSpotlight();
    this.queueEvent('GAME_REOPENED', 'all', {});
    this.commit();
    return { ok: true, message: wasClosed ? `Game continued — join code ${this.doc.code}. Reopen the challenges players should play.` : 'Game continued. Reopen the challenges players should play.' };
  }

  private closeGame(): HostActionResult {
    if (this.doc.status !== 'GAME_RESULTS') throw invalidState('Only a game showing its results can be closed');
    this.doc.status = 'FINISHED'; // SR-7: the engine stops resolving this code
    if (!this.doc.resultsRevealed) {
      this.doc.resultsRevealed = true; // a closed game is read-only: its results are public
      this.queueEvent('RESULTS_REVEALED', 'all', {});
    }
    this.commit();
    return { ok: true };
  }

  private removePlayer(playerId: string): HostActionResult {
    const player = this.getPlayer(playerId);
    if (!player || player.removedAt !== null) throw notFound('Player not found');
    player.removedAt = this.deps.clock();
    player.sessionTokenHash = hashToken(newToken());
    // Their pending judging tasks go back into the pool.
    for (const a of this.doc.assignments) {
      if (a.status === 'pending' && a.judgePlayerId === playerId) {
        this.clearAssignmentTimer(a.id);
        a.status = 'expired';
        a.decidedAt = this.deps.clock();
        const inst = this.doc.instances.find((i) => i.id === a.challengeInstanceId);
        const s = this.doc.submissions.find((x) => x.id === a.submissionId);
        if (inst && s && !s.scoredAt) this.createPeerAssignment(inst, s, a.reassignments, [playerId]);
      }
    }
    this.queueEvent('PLAYER_REMOVED', 'all', { playerId, displayName: player.displayName });
    this.deps.kickPlayer(this.doc.id, playerId);
    this.commit();
    return { ok: true };
  }

  /** FR-34: free a slot when a device is lost; the name can be reclaimed by rejoining. */
  private freePlayer(playerId: string): HostActionResult {
    const player = this.getPlayer(playerId);
    if (!player || player.removedAt !== null) throw notFound('Player not found');
    player.sessionTokenHash = hashToken(newToken());
    player.reclaimable = true;
    this.deps.kickPlayer(this.doc.id, playerId);
    this.commit();
    return { ok: true, message: `${player.displayName} can rejoin with the same name to reclaim their scores` };
  }

  /** FR-67: host decides a queued item. */
  private hostDecide(assignmentId: string, decision: 'approve' | 'reject', points?: number, note?: string): HostActionResult {
    const a = this.getAssignment(assignmentId);
    if (!a) throw notFound('Assignment not found');
    if (a.status !== 'pending' || a.judgePlayerId !== null) throw invalidState('This item is not waiting for the host');
    if (decision !== 'approve' && decision !== 'reject') throw validationError('Decision must be approve or reject');
    const inst = this.getInstance(a.challengeInstanceId);
    const submission = this.doc.submissions.find((s) => s.id === a.submissionId);
    if (!submission) throw notFound('Submission not found');
    a.points = this.validateHostPoints(inst, points);
    a.status = decision === 'approve' ? 'approved' : 'rejected';
    a.decision = decision;
    a.decidedBy = 'host';
    a.decidedAt = this.deps.clock();
    a.note = typeof note === 'string' && note.trim() ? note.trim().slice(0, 200) : null;
    this.queueEvent('EVALUATION_DECIDED', 'host', { assignmentId: a.id, instanceId: inst.id, decision, by: 'host' });
    if (submission.scoredAt) {
      this.reverseAwards(inst, `submission:${submission.id}`, 'override-reversal');
      submission.scoredAt = null;
    }
    this.scoreSubmission(inst, submission);
    this.commit();
    return { ok: true };
  }

  private validateHostPoints(inst: PersistedInstance, points: number | undefined): number | null {
    if (points === undefined || points === null) return null;
    const range = this.moduleFor(inst).manifest.evaluation.hostScoring;
    const n = Number(points);
    if (!range) throw validationError('This challenge does not take a points value');
    if (!Number.isFinite(n) || n < range.min || n > range.max) throw validationError(`Points must be between ${range.min} and ${range.max}`);
    return n;
  }

  /** FR-55: overrule anything, before or after results. */
  private hostOverride(submissionId: string, decision: 'approve' | 'reject', points: number | undefined, reason: string): HostActionResult {
    const submission = this.doc.submissions.find((s) => s.id === submissionId);
    if (!submission) throw notFound('Submission not found');
    const inst = this.getInstance(submission.challengeInstanceId);
    if (this.moduleFor(inst).manifest.results !== 'immediate') throw invalidState('Use adjust-score for aggregate challenges');
    const why = String(reason ?? '').trim();
    if (!why) throw validationError('A reason is required');
    if (decision !== 'approve' && decision !== 'reject') throw validationError('Decision must be approve or reject');
    const now = this.deps.clock();
    for (const a of this.doc.assignments) {
      if (a.submissionId !== submission.id) continue;
      if (a.status === 'pending') this.clearAssignmentTimer(a.id);
      a.status = 'overridden';
    }
    this.doc.assignments.push({
      id: newId('e'),
      challengeInstanceId: inst.id,
      submissionId: submission.id,
      judgePlayerId: null,
      status: decision === 'approve' ? 'approved' : 'rejected',
      reason: 'host-override',
      assignedAt: now,
      deadlineAt: null,
      decidedAt: now,
      decidedBy: 'host',
      decision,
      points: this.validateHostPoints(inst, points),
      note: why.slice(0, 200),
      reassignments: 0,
    });
    if (submission.scoredAt) {
      this.reverseAwards(inst, `submission:${submission.id}`, 'override-reversal');
      submission.scoredAt = null;
    }
    const attempt = this.attemptById(submission.attemptId);
    if (attempt && attempt.status === 'in_progress') this.lockAttempt(inst, attempt);
    else this.scoreSubmission(inst, submission);
    this.settleBestAttempt(inst, submission.playerId);
    this.commit();
    return { ok: true };
  }

  /** Instance-level host resolution (onClose modules). */
  private hostResolve(instanceId: string, payload: Record<string, unknown>): HostActionResult {
    const inst = this.getInstance(instanceId);
    if (inst.phase !== 'EVALUATING') throw invalidState('Challenge is not awaiting resolution');
    const loaded = this.moduleFor(inst);
    if (!loaded.module.applyHostResolution) throw invalidState('This challenge does not use host resolution');
    let result: { complete: boolean; message?: string } = { complete: false };
    const ok = this.callModule(inst, () => {
      const r = loaded.module.applyHostResolution!(inst.moduleState, inst.evaluation, payload ?? {}, this.ctxFor(inst));
      inst.evaluation = r.evaluation;
      result = { complete: r.complete, message: r.message };
    });
    if (!ok) {
      this.commit();
      throw new EngineError(`Resolution failed: ${inst.error}`, 'invalid_state');
    }
    if (result.complete) this.finalizeAggregate(inst);
    this.commit();
    return { ok: true, message: result.message };
  }

  private retryEvaluation(instanceId: string): HostActionResult {
    const inst = this.getInstance(instanceId);
    inst.error = null;
    const loaded = this.moduleFor(inst);
    if (loaded.manifest.results === 'onClose') {
      if (inst.phase === 'LOCKED') this.runAggregate(inst);
      else if (inst.phase === 'EVALUATING') this.finalizeAggregate(inst);
    } else {
      for (const s of this.doc.submissions) {
        if (s.challengeInstanceId !== inst.id || s.supersededBy || s.scoredAt) continue;
        const attempt = this.attemptById(s.attemptId);
        const hasPending =this.doc.assignments.some((a) => a.submissionId === s.id && a.status === 'pending');
        if (attempt && attempt.status !== 'in_progress' && !hasPending) this.beginEvaluation(inst, s);
      }
      this.maybeFinalizeImmediate(inst);
    }
    this.commit();
    return { ok: true };
  }

  /** FR-43 */
  private adjustScore(playerId: string, points: number, reason: string): HostActionResult {
    const player = this.getPlayer(playerId);
    if (!player || player.removedAt !== null) throw notFound('Player not found');
    const pts = Number(points);
    if (!Number.isFinite(pts) || pts === 0) throw validationError('Points must be a non-zero number');
    const why = String(reason ?? '').trim();
    if (!why) throw validationError('A reason is required');
    this.doc.ledger.push({
      id: newId('a'),
      gameId: this.doc.id,
      challengeInstanceId: null,
      playerId,
      points: Math.round(pts * 100) / 100,
      source: 'manual',
      reason: why,
      createdAt: this.deps.clock(),
    });
    this.activity('scored', `${player.displayName} ${pts > 0 ? 'received' : 'lost'} ${fmtPoints(Math.abs(pts))}: ${why}`, { playerId, points: pts });
    this.queueEvent('LEADERBOARD_UPDATED', 'all', { manual: true });
    this.commit();
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Phase & timers
  // ---------------------------------------------------------------------------

  private setPhase(inst: PersistedInstance, phase: ChallengePhase): void {
    inst.phase = phase;
    const loaded = this.moduleFor(inst);
    if (loaded.module.onPhaseChange && inst.moduleState !== null) {
      this.callModule(inst, () => {
        inst.moduleState = loaded.module.onPhaseChange!(inst.moduleState, phase, this.ctxFor(inst));
      });
    }
    this.queueEvent('CHALLENGE_PHASE_CHANGED', 'all', { instanceId: inst.id, phase });
  }

  private scheduleTimer(inst: PersistedInstance, playerId: string | null, tag: string, seconds: number): void {
    const ms = Math.max(0, Math.round(seconds * 1000));
    const now = this.deps.clock();
    this.cancelTimer(inst, playerId, tag);
    inst.timers.push({ tag, playerId, startedAt: now, endsAt: now + ms, remainingMs: this.doc.paused ? ms : null });
    if (!this.doc.paused) this.armInstanceTimer(inst, playerId, tag, ms);
  }

  private armInstanceTimer(inst: PersistedInstance, playerId: string | null, tag: string, ms: number): void {
    const key = timerKey(inst.id, playerId, tag);
    this.clearHandle(key);
    this.timerHandles.set(key, this.deps.setTimer(() => this.onTimerFired(inst.id, playerId, tag), Math.max(0, ms)));
  }

  private clearHandle(key: string): void {
    const h = this.timerHandles.get(key);
    if (h !== undefined) this.deps.clearTimer(h);
    this.timerHandles.delete(key);
  }

  private cancelTimer(inst: PersistedInstance, playerId: string | null, tag: string): void {
    this.clearHandle(timerKey(inst.id, playerId, tag));
    inst.timers = inst.timers.filter((t) => !(t.tag === tag && t.playerId === playerId));
  }

  private cancelPlayerTimers(inst: PersistedInstance, playerId: string): void {
    for (const t of [...inst.timers]) if (t.playerId === playerId) this.cancelTimer(inst, playerId, t.tag);
  }

  private cancelInstanceTimers(inst: PersistedInstance, includePlayers = true): void {
    for (const t of [...inst.timers]) if (includePlayers || t.playerId === null) this.cancelTimer(inst, t.playerId, t.tag);
  }

  private onTimerFired(instanceId: string, playerId: string | null, tag: string): void {
    if (this.disposed) return;
    const inst = this.doc.instances.find((i) => i.id === instanceId);
    if (!inst) return;
    this.timerHandles.delete(timerKey(inst.id, playerId, tag));
    inst.timers = inst.timers.filter((t) => !(t.tag === tag && t.playerId === playerId));
    if (this.doc.paused) return;

    const loaded = this.moduleFor(inst);
    if (playerId) {
      const attempt = this.attemptOf(inst.id, playerId);
      if (!attempt || attempt.status !== 'in_progress') return;
      if (loaded.module.onTimer) {
        this.callModule(inst, () => {
          inst.moduleState = loaded.module.onTimer!(inst.moduleState, tag, this.ctxFor(inst), playerId);
        });
      }
      if (tag === 'lock') this.lockAttempt(inst, attempt);
    } else {
      if (loaded.module.onTimer) {
        this.callModule(inst, () => {
          inst.moduleState = loaded.module.onTimer!(inst.moduleState, tag, this.ctxFor(inst));
        });
      }
      if (tag === 'lock' && (inst.phase === 'ACTIVE' || inst.phase === 'PENDING') && inst.moduleState !== null) this.closeInstance(inst);
    }
    this.commit();
  }

  // ---------------------------------------------------------------------------
  // Module plumbing
  // ---------------------------------------------------------------------------

  private moduleFor(inst: PersistedInstance): LoadedModule {
    const loaded = this.deps.registry.get(inst.moduleId, inst.moduleVersion);
    if (!loaded) {
      throw new EngineError(`Module ${inst.moduleId}@${inst.moduleVersion} is not installed (pinned by this game)`, 'not_found');
    }
    return loaded;
  }

  private ctxFor(inst: PersistedInstance): InstanceContext {
    return {
      gameId: this.doc.id,
      instanceId: inst.id,
      rng: this.rngFor(inst),
      now: () => this.deps.clock(),
      players: () => this.doc.players.filter((p) => p.removedAt === null).map((p) => this.playerRef(p)),
      schedule: (tag, seconds, playerId) => this.scheduleTimer(inst, playerId ?? null, tag, seconds),
      cancel: (tag, playerId) => this.cancelTimer(inst, playerId ?? null, tag),
      emit: (audience, payload) => this.queueEvent('MODULE_EVENT', audience, { instanceId: inst.id, data: payload }),
      mediaUrl: (ref) => this.deps.mediaUrl(ref),
    };
  }

  private rngFor(inst: PersistedInstance): () => number {
    let rng = this.rngs.get(inst.id);
    if (!rng) {
      rng = createSeededRng(inst.seed);
      this.rngs.set(inst.id, rng);
    }
    return rng;
  }

  private playerRef(p: PersistedPlayer): PlayerRef {
    return { id: p.id, displayName: p.displayName, connected: this.isPlayerConnected(p.id), color: this.colorOf(p) };
  }

  /** Join order decides the colour; players who left keep theirs, so nobody's colour changes. */
  private colorOf(p: PersistedPlayer): string {
    return playerColor(Math.max(0, this.doc.players.indexOf(p)));
  }

  /** Run a module function, converting exceptions into a host-visible error (FR-52). */
  private callModule(inst: PersistedInstance, fn: () => void): boolean {
    try {
      fn();
      return true;
    } catch (err) {
      this.recordModuleError(inst, err);
      return false;
    }
  }

  private recordModuleError(inst: PersistedInstance, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    inst.error = message;
    this.queueEvent('MODULE_ERROR', 'host', { instanceId: inst.id, moduleId: inst.moduleId, message });
  }

  private safeView<T>(inst: PersistedInstance, fn: () => T): T | null {
    try {
      return fn();
    } catch (err) {
      this.recordModuleError(inst, err);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Snapshots (FR-36, FR-38)
  // ---------------------------------------------------------------------------

  snapshotFor(audience: SnapshotAudience): GameSnapshot {
    const isHost = audience.role === 'host';
    const player = audience.role === 'player' ? this.getPlayer(audience.playerId) : undefined;
    const activePlayers = this.doc.players.filter((p) => p.removedAt === null);
    const leaderboard = this.liveLeaderboard();
    const visibleInstances = player ? this.doc.instances.filter((i) => this.eligibility(i, player.id).visible) : this.doc.instances;
    // Until the host reveals results, everyone but the host sees progress only: no points, ranks or results.
    const reveal = isHost || this.doc.resultsRevealed;

    const results: Record<string, ChallengeResults> = {};
    for (const inst of reveal ? visibleInstances : []) {
      if (inst.phase === 'RESULTS') {
        const r = this.buildResults(inst, player ?? null);
        if (r) results[inst.id] = r;
      }
    }

    const activity = audience.role === 'player' ? [] : [...this.doc.activity].reverse();
    return {
      serverTime: this.deps.clock(),
      seq: this.doc.seq,
      game: this.gameSummary(),
      players: activePlayers.map((p) => this.playerPublic(p)),
      challenges: visibleInstances.map((i) => this.instanceSummary(i, isHost, reveal, audience.role === 'main')),
      leaderboard: reveal ? leaderboard : hideLeaderboardPoints(leaderboard),
      joinUrl: this.deps.joinUrl(this.doc.code),
      me: player ? { playerId: player.id, displayName: player.displayName } : null,
      board: player ? visibleInstances.map((i) => this.boardEntry(i, player, reveal)) : [],
      judging: player ? this.judgeTasks(player) : [],
      activity: reveal ? activity : activity.filter((a) => a.kind !== 'scored' && a.kind !== 'results').map(({ points: _p, ...a }) => a),
      results,
      hostQueue: isHost ? this.hostQueue() : [],
      resolutions: isHost ? this.resolutions() : [],
      evaluations: isHost ? this.evaluationRecords() : [],
      scored: isHost ? this.scoredSummaries() : [],
      // The big screen shows what the host last published, whatever is revealed on phones.
      standings: player ? null : this.doc.standings,
      standingsFeed: player ? [] : [...this.doc.standingsFeed].reverse(),
      spotlight: player ? null : this.spotlightView(),
      spotlightChoices: isHost ? this.spotlightChoices() : [],
      presentation: player ? null : this.presentationView(),
      presentationDeck: isHost ? this.presentationDeck() : [],
    };
  }

  // ---------------------------------------------------------------------------
  // Big-screen spotlight (module `spotlight` items, one a minute)
  // ---------------------------------------------------------------------------

  /** Every item the open instances offer the spotlight right now. */
  private spotlightItems(): { key: string; inst: PersistedInstance; item: SpotlightItem }[] {
    const out: { key: string; inst: PersistedInstance; item: SpotlightItem }[] = [];
    for (const inst of this.doc.instances) {
      if (inst.phase !== 'ACTIVE' || inst.moduleState === null) continue;
      const loaded = this.deps.registry.get(inst.moduleId, inst.moduleVersion);
      if (!loaded?.module.spotlight) continue;
      const items = this.safeView(inst, () => loaded.module.spotlight!(inst.moduleState, this.ctxFor(inst)));
      for (const item of Array.isArray(items) ? items : []) {
        if (item && typeof item.id === 'string') out.push({ key: `${inst.id}/${item.id}`, inst, item });
      }
    }
    return out;
  }

  /**
   * Keep the spotlight going while the game runs: move on when the item's minute is up or it
   * went away (see `pickSpotlight`), and arm the timer for the next look. Returns whether
   * what is on screen changed (callers commit).
   */
  private updateSpotlight(): boolean {
    const s = this.doc.spotlight;
    this.clearHandle(SPOTLIGHT_TIMER);
    if (this.doc.status !== 'IN_PROGRESS') {
      const changed = s.current !== null;
      s.current = null;
      return changed;
    }
    if (this.doc.paused) {
      this.armSpotlight(SPOTLIGHT_IDLE_SECONDS * 1000);
      return false;
    }
    const now = this.deps.clock();
    const items = this.spotlightItems();
    const live = s.current ? items.find((i) => i.key === s.current!.key) : undefined;
    // Held by the host: it stays until released (or its challenge closes).
    if (s.current?.held && live) return false;
    if (s.current && live && now < s.current.endsAt) {
      this.armSpotlight(s.current.endsAt - now);
      return false;
    }
    // Answers given while it was on screen do not count as new next time.
    if (s.current && live) s.seen[s.current.key] = live.item.activity;
    const next = pickSpotlight(
      items.map((i) => ({ key: i.key, activity: i.item.activity })),
      s,
      live ? s.current!.key : null,
      this.deps.random ?? Math.random,
    );
    if (!next) {
      this.armSpotlight(SPOTLIGHT_IDLE_SECONDS * 1000);
      const changed = s.current !== null;
      s.current = null;
      return changed;
    }
    const chosen = items.find((i) => i.key === next.key)!;
    s.round = next.round;
    s.seen[next.key] = chosen.item.activity;
    s.current = { key: next.key, instanceId: chosen.inst.id, itemId: chosen.item.id, startedAt: now, endsAt: now + SPOTLIGHT_SECONDS * 1000, total: items.length };
    this.armSpotlight(SPOTLIGHT_SECONDS * 1000);
    return true;
  }

  /** The host puts one item on the big screen now; it counts as that item's turn. */
  private showSpotlight(instanceId: string, itemId: string, hold: boolean): HostActionResult {
    this.assertInProgress();
    const s = this.doc.spotlight;
    const items = this.spotlightItems();
    const chosen = items.find((i) => i.inst.id === instanceId && i.item.id === itemId);
    if (!chosen) throw notFound('That item is not available for the big screen (is its challenge open?)');
    const previous = s.current ? items.find((i) => i.key === s.current!.key) : undefined;
    if (previous) s.seen[previous.key] = previous.item.activity;
    const now = this.deps.clock();
    s.seen[chosen.key] = chosen.item.activity;
    s.round = [...s.round.filter((k) => k !== chosen.key && items.some((i) => i.key === k)), chosen.key];
    s.current = {
      key: chosen.key,
      instanceId,
      itemId,
      startedAt: now,
      endsAt: now + SPOTLIGHT_SECONDS * 1000,
      total: items.length,
      held: hold,
    };
    this.clearHandle(SPOTLIGHT_TIMER);
    if (!hold) this.armSpotlight(SPOTLIGHT_SECONDS * 1000);
    this.commit();
    return { ok: true };
  }

  /** Back to rotating after a held item: the next one comes up right away. */
  private releaseSpotlight(): HostActionResult {
    this.assertInProgress();
    const current = this.doc.spotlight.current;
    if (current?.held) {
      current.held = false;
      current.endsAt = this.deps.clock();
      this.updateSpotlight();
      this.commit();
    }
    return { ok: true };
  }

  /** Host only: everything that can be put in the spotlight, in board order. */
  private spotlightChoices(): SpotlightChoice[] {
    return this.spotlightItems().map(({ inst, item }) => ({
      instanceId: inst.id,
      title: this.titleOf(inst),
      itemId: item.id,
      label: typeof item.label === 'string' ? item.label : item.id,
      activity: item.activity,
    }));
  }

  private armSpotlight(ms: number): void {
    this.clearHandle(SPOTLIGHT_TIMER);
    this.timerHandles.set(
      SPOTLIGHT_TIMER,
      this.deps.setTimer(() => {
        if (this.disposed) return;
        this.timerHandles.delete(SPOTLIGHT_TIMER);
        if (this.updateSpotlight()) this.commit();
      }, Math.max(0, ms)),
    );
  }

  /** The item on screen, drawn from the module's current state (answers keep coming in). */
  private spotlightView(): SpotlightView | null {
    const c = this.doc.spotlight.current;
    if (!c || this.doc.status !== 'IN_PROGRESS') return null;
    const inst = this.doc.instances.find((i) => i.id === c.instanceId);
    const loaded = inst ? this.deps.registry.get(inst.moduleId, inst.moduleVersion) : undefined;
    if (!inst || inst.phase !== 'ACTIVE' || inst.moduleState === null || !loaded?.module.spotlight) return null;
    const items = this.safeView(inst, () => loaded.module.spotlight!(inst.moduleState, this.ctxFor(inst)));
    const item = Array.isArray(items) ? items.find((i) => i?.id === c.itemId) : undefined;
    if (!item) return null;
    return {
      instanceId: inst.id,
      title: this.titleOf(inst),
      category: inst.category,
      itemId: item.id,
      ui: item.ui,
      startedAt: c.startedAt,
      endsAt: c.endsAt,
      total: c.total,
      held: c.held === true,
    };
  }

  // ---------------------------------------------------------------------------
  // Results presentation (module `presentation` slides, run by the host)
  // ---------------------------------------------------------------------------

  /** A closed challenge's slides; empty when it has none (or is not closed). */
  private slidesOf(inst: PersistedInstance): PresentationSlide[] {
    if (inst.phase !== 'RESULTS' || inst.moduleState === null) return [];
    const loaded = this.deps.registry.get(inst.moduleId, inst.moduleVersion);
    if (!loaded?.module.presentation) return [];
    if (this.slideCache.seq !== this.doc.seq) this.slideCache = { seq: this.doc.seq, slides: new Map() };
    const cached = this.slideCache.slides.get(inst.id);
    if (cached) return cached;
    const built = this.safeView(inst, () => loaded.module.presentation!(inst.moduleState, this.evaluationsOf(inst), this.ctxFor(inst)));
    const slides = Array.isArray(built) ? built.filter((s) => s && Array.isArray(s.steps) && s.steps.length > 0) : [];
    this.slideCache.slides.set(inst.id, slides);
    return slides;
  }

  /** The running order of the given challenges' slides (board order). */
  private deckOf(instanceIds: string[]): { deck: DeckSlide[]; slides: Map<string, PresentationSlide[]> } {
    const deck: DeckSlide[] = [];
    const slides = new Map<string, PresentationSlide[]>();
    for (const inst of this.doc.instances) {
      if (!instanceIds.includes(inst.id)) continue;
      const own = this.slidesOf(inst);
      slides.set(inst.id, own);
      own.forEach((s, slide) => {
        const seconds = typeof s.stepSeconds === 'number' && Number.isFinite(s.stepSeconds) ? s.stepSeconds : PRESENTATION_STEP_SECONDS;
        deck.push({ instanceId: inst.id, slide, steps: s.steps.length, stepSeconds: Math.min(600, Math.max(1, seconds)) });
      });
    }
    return { deck, slides };
  }

  private startPresentation(instanceIds: string[] | undefined, autoplay: boolean): HostActionResult {
    const presentable = this.doc.instances.filter((i) => this.slidesOf(i).length > 0).map((i) => i.id);
    let ids = presentable;
    if (instanceIds !== undefined) {
      if (!Array.isArray(instanceIds) || instanceIds.some((id) => typeof id !== 'string')) throw validationError('instanceIds must be a list of challenge ids');
      for (const id of instanceIds) {
        const inst = this.getInstance(id);
        if (!presentable.includes(id)) throw invalidState(`${this.titleOf(inst)} has nothing to present (is it closed?)`);
      }
      ids = presentable.filter((id) => instanceIds.includes(id));
    }
    const { deck } = this.deckOf(ids);
    if (deck.length === 0) throw invalidState('No closed challenge has anything to present yet');
    const first = deck[0]!;
    this.presentation = { instanceIds: ids, at: { instanceId: first.instanceId, slide: first.slide, step: 0, index: 0 }, autoplay, startedAt: 0, endsAt: null };
    this.showPresentationStep(deck);
    this.commitScreens();
    return { ok: true };
  }

  private movePresentation(to: PresentationMove): HostActionResult {
    const p = this.presentation;
    if (!p) throw invalidState('No presentation is running');
    const { deck } = this.deckOf(p.instanceIds);
    const at = locate(deck, p.at);
    if (!at) return this.stopPresentation();
    const next = move(deck, at, to);
    if (!next) {
      if (typeof to === 'object') throw notFound('That slide is not in the presentation');
      return { ok: true };
    }
    p.at = next;
    this.showPresentationStep(deck);
    this.commitScreens();
    return { ok: true };
  }

  private autoplayPresentation(on: boolean): HostActionResult {
    const p = this.presentation;
    if (!p) throw invalidState('No presentation is running');
    const { deck } = this.deckOf(p.instanceIds);
    const at = locate(deck, p.at);
    if (!at) return this.stopPresentation();
    p.at = at;
    p.autoplay = on;
    // Playing from the very end starts over.
    const last = deck[deck.length - 1]!;
    if (on && at.index === deck.length - 1 && at.step === last.steps - 1) p.at = { instanceId: deck[0]!.instanceId, slide: deck[0]!.slide, step: 0, index: 0 };
    this.showPresentationStep(deck);
    this.commitScreens();
    return { ok: true };
  }

  private stopPresentation(): HostActionResult {
    this.presentation = null;
    this.clearHandle(PRESENTATION_TIMER);
    this.commitScreens();
    return { ok: true };
  }

  /** The step at `presentation.at` starts now; while playing by itself, the next one follows in its time. */
  private showPresentationStep(deck: DeckSlide[]): void {
    const p = this.presentation!;
    this.clearHandle(PRESENTATION_TIMER);
    const now = this.deps.clock();
    const current = deck[p.at.index];
    // Playing stops on the last step, which stays on screen.
    if (current && p.at.index === deck.length - 1 && p.at.step === current.steps - 1) p.autoplay = false;
    p.startedAt = now;
    p.endsAt = p.autoplay && current ? now + current.stepSeconds * 1000 : null;
    if (p.endsAt === null) return;
    this.timerHandles.set(
      PRESENTATION_TIMER,
      this.deps.setTimer(() => {
        if (this.disposed) return;
        this.timerHandles.delete(PRESENTATION_TIMER);
        if (this.presentation !== p || !p.autoplay) return;
        const { deck: latest } = this.deckOf(p.instanceIds);
        const at = locate(latest, p.at);
        if (!at) {
          this.stopPresentation();
          return;
        }
        p.at = move(latest, at, 'next') ?? at;
        this.showPresentationStep(latest);
        this.commitScreens();
      }, p.endsAt - now),
    );
  }

  private presentationView(): PresentationView | null {
    const p = this.presentation;
    if (!p) return null;
    const { deck, slides } = this.deckOf(p.instanceIds);
    const at = locate(deck, p.at);
    if (!at) return null;
    const inst = this.doc.instances.find((i) => i.id === at.instanceId)!;
    const own = slides.get(at.instanceId)!;
    const slide = own[at.slide]!;
    return {
      instanceId: inst.id,
      title: this.titleOf(inst),
      category: inst.category,
      caption: typeof slide.caption === 'string' && slide.caption ? slide.caption : null,
      slide: at.slide,
      slideCount: own.length,
      step: at.step,
      stepCount: slide.steps.length,
      index: at.index,
      total: deck.length,
      ui: slide.steps[at.step]!,
      autoplay: p.autoplay,
      startedAt: p.startedAt,
      endsAt: p.endsAt,
    };
  }

  /** Host only: every closed challenge with slides, and which ones the running presentation shows. */
  private presentationDeck(): PresentationDeckEntry[] {
    const out: PresentationDeckEntry[] = [];
    for (const inst of this.doc.instances) {
      const slides = this.slidesOf(inst).length;
      if (slides === 0) continue;
      out.push({ instanceId: inst.id, title: this.titleOf(inst), category: inst.category, slides, included: this.presentation?.instanceIds.includes(inst.id) ?? false });
    }
    return out;
  }

  gameSummary(): GameSummary {
    return {
      id: this.doc.id,
      name: this.doc.name,
      code: this.doc.code,
      status: this.doc.status,
      settings: this.doc.settings,
      branding: this.doc.branding,
      createdAt: this.doc.createdAt,
      startedAt: this.doc.startedAt,
      finishedAt: this.doc.finishedAt,
      paused: this.doc.paused,
      resultsRevealed: this.doc.resultsRevealed,
    };
  }

  private playerPublic(p: PersistedPlayer): PlayerPublic {
    const index = Math.max(0, this.doc.players.indexOf(p));
    return {
      id: p.id,
      displayName: p.displayName,
      connected: this.isPlayerConnected(p.id),
      joinedAt: p.joinedAt,
      color: this.colorOf(p),
      icon: playerIcon(index),
      avatar: p.avatar ?? null,
    };
  }

  private moduleName(inst: PersistedInstance): string {
    return this.deps.registry.get(inst.moduleId, inst.moduleVersion)?.manifest.name ?? inst.moduleId;
  }

  private stats(inst: PersistedInstance, showPoints: boolean): ChallengeStats {
    const attempts = this.doc.attempts.filter((a) => a.challengeInstanceId === inst.id);
    const subs = this.doc.submissions.filter((s) => s.challengeInstanceId === inst.id && !s.supersededBy);
    const totals = new Map<string, number>();
    for (const r of this.doc.ledger) {
      if (r.challengeInstanceId === inst.id && r.source === 'module') totals.set(r.playerId, (totals.get(r.playerId) ?? 0) + r.points);
    }
    const scoredPlayers = new Set(attempts.filter((a) => a.status === 'scored').map((a) => a.playerId));
    const scoredPoints = [...scoredPlayers].map((id) => totals.get(id) ?? 0);
    return {
      started: new Set(attempts.map((a) => a.playerId)).size,
      attempts: attempts.length,
      submitted: new Set(subs.map((s) => s.playerId)).size,
      scored: scoredPlayers.size,
      // Every locked-but-unscored submission is waiting for evaluation (automatic pending, peer or host).
      pendingEvaluations: subs.filter((s) => !s.scoredAt && this.attemptById(s.attemptId)?.status === 'locked').length,
      averagePoints: showPoints && scoredPoints.length ? Math.round((scoredPoints.reduce((a, b) => a + b, 0) / scoredPoints.length) * 10) / 10 : null,
      bestPoints: showPoints && scoredPoints.length ? Math.max(...scoredPoints) : null,
    };
  }

  instanceSummary(inst: PersistedInstance, includeConfig: boolean, showPoints = true, withPanel = false): ChallengeInstanceSummary {
    const loaded = this.deps.registry.get(inst.moduleId, inst.moduleVersion);
    const manifest = loaded?.manifest;
    const firstString = Object.values(inst.configuration).find((v) => typeof v === 'string' && !v.startsWith('media://')) as string | undefined;
    return {
      id: inst.id,
      title: this.titleOf(inst),
      customTitle: includeConfig ? inst.title : undefined,
      category: inst.category,
      moduleId: inst.moduleId,
      moduleVersion: inst.moduleVersion,
      moduleName: manifest?.name ?? inst.moduleId,
      moduleCategory: manifest?.category ?? 'other',
      moduleDescription: manifest?.description ?? '',
      evaluationMode: loaded ? this.effectiveMode(inst) : 'automatic',
      evaluationModeOverride: includeConfig ? inst.evaluationMode : undefined,
      results: manifest?.results ?? 'immediate',
      typicalSeconds: manifest?.duration.typicalSeconds ?? 60,
      sortOrder: inst.sortOrder,
      phase: inst.phase,
      availability: inst.availability,
      allowReplay: inst.allowReplay,
      assignedPlayerIds: includeConfig || inst.availability === 'assigned' ? inst.assignedPlayerIds : undefined,
      stats: this.stats(inst, showPoints),
      configuration: includeConfig ? inst.configuration : undefined,
      error: includeConfig ? inst.error : undefined,
      summary: includeConfig ? firstString : undefined,
      closedFor: includeConfig ? this.closedFor(inst) : undefined,
      displayPanel: withPanel ? this.displayPanelOf(inst) : undefined,
      displayBanner: withPanel ? this.displayBannerOf(inst) : undefined,
    };
  }

  /** Players the module closed this (open) instance for; the host may reopen it for them. */
  private closedFor(inst: PersistedInstance): string[] {
    const loaded = this.deps.registry.get(inst.moduleId, inst.moduleVersion);
    if (!loaded?.module.closedFor || !loaded.module.reopenFor || inst.moduleState === null || inst.phase !== 'ACTIVE') return [];
    const ids = this.safeView(inst, () => loaded.module.closedFor!(inst.moduleState, this.ctxFor(inst))) ?? [];
    const present = new Set(this.doc.players.filter((p) => p.removedAt === null).map((p) => p.id));
    return ids.filter((id) => present.has(id));
  }

  private reopenForPlayer(instanceId: string, playerId: string): HostActionResult {
    const inst = this.getInstance(instanceId);
    const player = this.getPlayer(playerId);
    if (!player || player.removedAt !== null) throw notFound('Player not found');
    if (!this.closedFor(inst).includes(player.id)) throw invalidState(`${player.displayName} can already play this challenge`);
    const loaded = this.moduleFor(inst);
    const ok = this.callModule(inst, () => {
      inst.moduleState = loaded.module.reopenFor!(inst.moduleState, this.playerRef(player), this.ctxFor(inst));
    });
    if (!ok) {
      this.commit();
      throw invalidState('The challenge could not reopen for this player');
    }
    // Not in the (public) activity feed: why it was closed for them is their business.
    this.commit();
    return { ok: true };
  }

  /** The module's live big-screen panel (null when it has none or has not started). */
  private displayBannerOf(inst: PersistedInstance): string | null {
    const loaded = this.deps.registry.get(inst.moduleId, inst.moduleVersion);
    if (!loaded?.module.displayBanner || inst.moduleState === null || inst.phase !== 'ACTIVE') return null;
    const text = this.safeView(inst, () => loaded.module.displayBanner!(inst.moduleState, this.ctxFor(inst)));
    return typeof text === 'string' && text.trim() ? text.trim().slice(0, 160) : null;
  }

  private displayPanelOf(inst: PersistedInstance): UINode | null {
    const loaded = this.deps.registry.get(inst.moduleId, inst.moduleVersion);
    if (!loaded?.module.displayPanel || inst.moduleState === null || inst.phase === 'PENDING') return null;
    return this.safeView(inst, () => loaded.module.displayPanel!(inst.moduleState, this.ctxFor(inst))) ?? null;
  }

  private boardEntry(inst: PersistedInstance, player: PersistedPlayer, reveal: boolean): BoardEntry {
    const loaded = this.deps.registry.get(inst.moduleId, inst.moduleVersion);
    const manifest = loaded?.manifest;
    const attempts = this.attemptsOf(inst.id, player.id);
    const attempt = attempts.at(-1);
    const submission = attempt ? this.submissionOf(attempt) : undefined;
    const { canStart } = this.eligibility(inst, player.id);
    const ctx = loaded ? this.ctxFor(inst) : null;
    const ref = this.playerRef(player);

    const live = attempt?.status === 'in_progress';
    const note = loaded?.module.playerNote && ctx && inst.moduleState !== null ? (this.safeView(inst, () => loaded.module.playerNote!(inst.moduleState, ref, ctx)) ?? null) : null;
    // The module's own gate (e.g. turn-taking) applies only where the engine would allow a start.
    const check = canStart && !live && loaded ? this.moduleStartCheck(inst, player) : null;
    const blocked = check !== null && !check.ok;
    const finished = check !== null && !check.ok && check.finished === true;
    // "Your turn": asked while the player may start, and while their attempt runs.
    const urgentCheck = live && inst.phase === 'ACTIVE' && loaded ? this.moduleStartCheck(inst, player) : check;
    const urgent = urgentCheck !== null && urgentCheck.ok && urgentCheck.urgent === true;
    const repeat = manifest?.attempts === 'repeat';

    // With replays the tile reflects the best outcome so far, not just the latest attempt.
    // Repeat modules are about the next contribution: playable or waiting while they are open.
    let status: AttemptStatus;
    if (live) status = 'in_progress';
    else if (repeat && canStart && !finished) status = blocked ? 'waiting' : 'available';
    else if (attempts.some((a) => a.status === 'scored')) status = 'scored';
    else if (attempts.some((a) => a.status === 'locked' && this.submissionOf(a))) status = 'submitted';
    else if (attempt) status = 'missed';
    else if (canStart) status = blocked ? 'waiting' : 'available';
    else if (inst.phase === 'PENDING') status = 'locked';
    else status = 'closed';
    // Until results are revealed a finished attempt looks the same whether or not it has been scored.
    if (!reveal && status === 'scored') status = 'submitted';
    const canReplay = attempt !== undefined && !live && canStart && !blocked && this.replayAllowed(inst);

    let intro: UINode | null = null;
    let view: UINode | null = null;
    let canSubmit = false;
    let statusText: string | null = check ? (check.ok ? (check.hint ?? null) : check.reason) : null;
    let result: UINode | null = null;

    if (loaded && ctx && inst.moduleState !== null) {
      if (status === 'available') {
        intro = this.safeView(inst, () => loaded.module.introView?.(inst.moduleState, ref, ctx) ?? null) ?? null;
      } else if (status === 'in_progress') {
        const vm = this.safeView(inst, () => loaded.module.guestView(inst.moduleState, ref, ctx));
        if (vm) {
          view = vm.ui;
          canSubmit = Boolean(vm.canSubmit) && !this.doc.paused;
          statusText = vm.status ?? null;
        }
      } else if (!reveal || status === 'waiting') {
        // Nothing about the outcome until the host reveals results.
      } else if (status === 'scored' || inst.phase === 'RESULTS') {
        result = this.personalResult(inst, player);
      } else if (status === 'submitted' && statusText === null) {
        statusText = this.effectiveMode(inst) === 'automatic' ? 'Waiting for results' : 'Waiting for a judge';
      }
    }

    const points = this.doc.ledger
      .filter((r) => r.challengeInstanceId === inst.id && r.playerId === player.id && r.source === 'module')
      .reduce((a, r) => a + r.points, 0);

    return {
      instanceId: inst.id,
      title: this.titleOf(inst),
      category: inst.category,
      moduleName: manifest?.name ?? inst.moduleId,
      moduleCategory: manifest?.category ?? 'other',
      description: manifest?.description ?? '',
      evaluationMode: loaded ? this.effectiveMode(inst) : 'automatic',
      results: manifest?.results ?? 'immediate',
      typicalSeconds: manifest?.duration.typicalSeconds ?? 60,
      phase: inst.phase,
      status,
      points: status === 'scored' || (repeat && reveal && attempts.some((a) => a.status === 'scored')) ? Math.round(points * 100) / 100 : null,
      startedAt: attempt?.startedAt ?? null,
      attempts: attempts.length,
      canReplay,
      repeat,
      note: typeof note === 'string' ? note : (note?.text ?? null),
      noteTone: typeof note === 'object' && note !== null ? (note.tone ?? null) : null,
      urgent,
      intro,
      view,
      canSubmit,
      statusText,
      result,
      timers: inst.timers
        .filter((t) => t.playerId === null || t.playerId === player.id)
        .map((t): TimerInfo => ({ tag: t.tag, startedAt: t.startedAt, endsAt: t.endsAt, playerId: t.playerId ?? undefined })),
      canFinish: status === 'in_progress' && manifest?.resubmission === 'replace' && submission !== undefined,
    };
  }

  private personalResult(inst: PersistedInstance, player: PersistedPlayer): UINode | null {
    const loaded = this.deps.registry.get(inst.moduleId, inst.moduleVersion);
    if (!loaded || inst.moduleState === null) return null;
    const ctx = this.ctxFor(inst);
    const evaluations = this.evaluationsOf(inst);
    const vm = this.safeView(inst, () => loaded.module.resultsView(inst.moduleState, evaluations, ctx));
    if (!vm) return null;
    if (vm.guestUi) {
      try {
        return vm.guestUi(this.playerRef(player));
      } catch (err) {
        this.recordModuleError(inst, err);
      }
    }
    return vm.ui;
  }

  /** Shared results for an instance (main display / host), with generic statistics. */
  buildResults(inst: PersistedInstance, player: PersistedPlayer | null): ChallengeResults | null {
    const loaded = this.deps.registry.get(inst.moduleId, inst.moduleVersion);
    if (!loaded || inst.moduleState === null) return null;
    const ctx = this.ctxFor(inst);
    const vm = this.safeView(inst, () => loaded.module.resultsView(inst.moduleState, this.evaluationsOf(inst), ctx));
    let uiNode: UINode = vm?.ui ?? ui.text('Results unavailable', { tone: 'muted' });
    if (vm?.guestUi && player) {
      try {
        uiNode = vm.guestUi(this.playerRef(player));
      } catch {
        /* fall back to shared results */
      }
    }
    const scores = inst.results?.scores ?? [];
    return {
      ui: uiNode,
      scores,
      statistics: inst.results?.statistics ?? {},
      generic: computeGenericStatistics({
        participantIds: this.doc.players.filter((p) => p.removedAt === null).map((p) => p.id),
        attempts: this.doc.attempts.filter((a) => a.challengeInstanceId === inst.id),
        submissions: this.doc.submissions.filter((s) => s.challengeInstanceId === inst.id),
        scores,
      }),
    };
  }

  resultsFor(instanceId: string, audience: SnapshotAudience): ChallengeResults | null {
    const inst = this.getInstance(instanceId);
    const player = audience.role === 'player' ? (this.getPlayer(audience.playerId) ?? null) : null;
    return this.buildResults(inst, player);
  }

  /** How a submission is shown to a judge (module-provided or generic from the evidence declaration). */
  private presentSubmission(inst: PersistedInstance, submission: PersistedSubmission): UINode {
    const loaded = this.deps.registry.get(inst.moduleId, inst.moduleVersion);
    if (!loaded || inst.moduleState === null) return ui.text('Submission unavailable', { tone: 'muted' });
    if (loaded.module.presentSubmission) {
      const node = this.safeView(inst, () => loaded.module.presentSubmission!(inst.moduleState, this.toSubmission(inst, submission), this.ctxFor(inst)));
      if (node) return node;
    }
    const evidence = loaded.manifest.evaluation.evidence;
    const payload = (submission.payload ?? {}) as Record<string, unknown>;
    if (!evidence || evidence.kind === 'none') return ui.caption('This submission carries no evidence to review.');
    const value = payload[evidence.field];
    const label = evidence.label ? [ui.caption(evidence.label)] : [];
    switch (evidence.kind) {
      case 'text':
        return ui.stack([...label, ui.card([ui.title(String(value ?? ''))], 'primary')], { gap: 'sm' });
      case 'number':
        return ui.stack([...label, ui.display(String(value ?? '–'))], { gap: 'sm' });
      case 'image':
        return ui.stack([...label, ui.image(this.deps.mediaUrl(String(value ?? '')), { maxHeight: '50vh' })], { gap: 'sm' });
      case 'video':
        return ui.stack([...label, ui.video(this.deps.mediaUrl(String(value ?? '')), { maxHeight: '50vh' })], { gap: 'sm' });
      case 'audio':
        return ui.stack([...label, ui.audio(this.deps.mediaUrl(String(value ?? '')))], { gap: 'sm' });
    }
  }

  private judgeTasks(player: PersistedPlayer): JudgeTask[] {
    const tasks: JudgeTask[] = [];
    for (const a of this.doc.assignments) {
      if (a.status !== 'pending' || a.judgePlayerId !== player.id) continue;
      const inst = this.doc.instances.find((i) => i.id === a.challengeInstanceId);
      const submission = this.doc.submissions.find((s) => s.id === a.submissionId);
      if (!inst || !submission) continue;
      const manifest = this.deps.registry.get(inst.moduleId, inst.moduleVersion)?.manifest;
      tasks.push({
        assignmentId: a.id,
        instanceId: inst.id,
        title: this.titleOf(inst),
        moduleName: manifest?.name ?? inst.moduleId,
        criteria: manifest?.evaluation.criteria ?? 'Does this submission meet the challenge?',
        deadlineAt: a.deadlineAt ?? 0,
        presentation: this.presentSubmission(inst, submission),
      });
    }
    return tasks.sort((a, b) => a.deadlineAt - b.deadlineAt);
  }

  private hostQueue(): HostQueueItem[] {
    const items: HostQueueItem[] = [];
    for (const a of this.doc.assignments) {
      if (a.status !== 'pending' || a.judgePlayerId !== null) continue;
      const inst = this.doc.instances.find((i) => i.id === a.challengeInstanceId);
      const submission = this.doc.submissions.find((s) => s.id === a.submissionId);
      if (!inst || !submission) continue;
      const manifest = this.deps.registry.get(inst.moduleId, inst.moduleVersion)?.manifest;
      items.push({
        assignmentId: a.id,
        instanceId: inst.id,
        title: this.titleOf(inst),
        moduleName: manifest?.name ?? inst.moduleId,
        submissionId: submission.id,
        playerId: submission.playerId,
        displayName: this.getPlayer(submission.playerId)?.displayName ?? 'Unknown',
        criteria: manifest?.evaluation.criteria ?? '',
        presentation: this.presentSubmission(inst, submission),
        status: a.status,
        reason: a.reason,
        hostScoring: manifest?.evaluation.hostScoring ?? null,
        priorJudgements: this.judgementsFor(submission),
        submittedAt: submission.submittedAt,
      });
    }
    return items.sort((a, b) => a.submittedAt - b.submittedAt);
  }

  private resolutions(): GameSnapshot['resolutions'] {
    return this.doc.instances
      .filter((i) => i.phase === 'EVALUATING')
      .map((inst) => {
        const loaded = this.deps.registry.get(inst.moduleId, inst.moduleVersion);
        const form =
          loaded?.module.hostResolutionView && inst.moduleState !== null
            ? this.safeView(inst, () => loaded.module.hostResolutionView!(inst.moduleState, inst.evaluation, this.ctxFor(inst)))
            : null;
        return { instanceId: inst.id, title: this.titleOf(inst), moduleName: this.moduleName(inst), form: form ?? null };
      });
  }

  private evaluationRecords(): EvaluationRecord[] {
    return [...this.doc.assignments]
      .sort((a, b) => b.assignedAt - a.assignedAt)
      .map((a) => {
        const inst = this.doc.instances.find((i) => i.id === a.challengeInstanceId);
        const submission = this.doc.submissions.find((s) => s.id === a.submissionId);
        return {
          assignmentId: a.id,
          instanceId: a.challengeInstanceId,
          title: inst ? this.titleOf(inst) : '',
          moduleName: inst ? this.moduleName(inst) : '',
          submissionId: a.submissionId,
          playerId: submission?.playerId ?? '',
          displayName: submission ? (this.getPlayer(submission.playerId)?.displayName ?? 'Unknown') : 'Unknown',
          judgePlayerId: a.judgePlayerId,
          judgeName: a.judgePlayerId ? (this.getPlayer(a.judgePlayerId)?.displayName ?? 'Unknown') : null,
          status: a.status,
          decidedBy: a.decidedBy,
          decision: a.decision,
          points: a.points,
          note: a.note,
          assignedAt: a.assignedAt,
          deadlineAt: a.deadlineAt !== null && a.deadlineAt > 0 ? a.deadlineAt : null,
          decidedAt: a.decidedAt,
        };
      });
  }

  private scoredSummaries(): ScoredSubmissionSummary[] {
    const out: ScoredSubmissionSummary[] = [];
    for (const s of this.doc.submissions) {
      if (s.supersededBy || s.scoredAt === null) continue;
      const inst = this.doc.instances.find((i) => i.id === s.challengeInstanceId);
      if (!inst) continue;
      const manifest = this.deps.registry.get(inst.moduleId, inst.moduleVersion)?.manifest;
      // Immediate results: this submission's own points (a replayed attempt may not be the one that counts).
      const points =
        manifest?.results === 'immediate'
          ? this.submissionPoints(inst, s)
          : this.doc.ledger
              .filter((r) => r.challengeInstanceId === inst.id && r.playerId === s.playerId && r.source === 'module')
              .reduce((a, r) => a + r.points, 0);
      out.push({
        submissionId: s.id,
        instanceId: inst.id,
        title: this.titleOf(inst),
        moduleName: manifest?.name ?? inst.moduleId,
        playerId: s.playerId,
        displayName: this.getPlayer(s.playerId)?.displayName ?? 'Unknown',
        points: Math.round(points * 100) / 100,
        scoredAt: s.scoredAt,
        presentation: manifest?.results === 'immediate' ? this.presentSubmission(inst, s) : null,
      });
    }
    return out.sort((a, b) => b.scoredAt - a.scoredAt);
  }

  // ---------------------------------------------------------------------------
  // Activity, events & persistence
  // ---------------------------------------------------------------------------

  private activity(kind: ActivityItem['kind'], text: string, extra: Partial<ActivityItem> = {}): void {
    this.doc.activity.push({ id: newId('act'), at: this.deps.clock(), kind, text, ...extra });
    if (this.doc.activity.length > ACTIVITY_LIMIT) this.doc.activity.splice(0, this.doc.activity.length - ACTIVITY_LIMIT);
  }

  private queueEvent(type: GameEventType, audience: EventAudience, payload: unknown): void {
    this.queue.push({ type, audience, payload });
  }

  /**
   * Flush queued events (each with a fresh sequence number, FR-37), then push a fresh
   * audience-scoped snapshot to every connected client (FR-36/FR-38), then persist.
   */
  /** Coalesce the commits caused by live actions (see ACTION_COMMIT_MS). */
  private commitSoon(): void {
    if (this.actionCommitTimer !== null || this.disposed) return;
    this.actionCommitTimer = this.deps.setTimer(() => {
      this.actionCommitTimer = null;
      this.commit(true);
    }, ACTION_COMMIT_MS);
  }

  private commit(fromActions = false): void {
    if (this.disposed) return;
    // The spotlight moves on at once when its challenge was closed, hidden or reset.
    const shown = this.doc.spotlight.current;
    if (shown && this.doc.instances.find((i) => i.id === shown.instanceId)?.phase !== 'ACTIVE') this.updateSpotlight();
    const at = new Date(this.deps.clock()).toISOString();
    const events = this.queue;
    this.queue = [];
    for (const e of events) {
      this.doc.seq += 1;
      this.deps.emit({ gameId: this.doc.id, seq: this.doc.seq, at, type: e.type, audience: e.audience, payload: e.payload });
    }
    this.doc.seq += 1;
    const seq = this.doc.seq;
    const emitSnapshot = (audience: SnapshotAudience, to: EventAudience) => {
      this.deps.emit({ gameId: this.doc.id, seq, at, type: 'GAME_STATE_SNAPSHOT', audience: to, payload: this.snapshotFor(audience) });
    };
    if (this.hostConnections > 0) emitSnapshot({ role: 'host' }, 'host');
    if (this.mainConnections > 0) emitSnapshot({ role: 'main' }, 'main');
    for (const [playerId, n] of this.playerConnections) {
      if (n > 0) emitSnapshot({ role: 'player', playerId }, `player:${playerId}`);
    }
    if (fromActions) this.persistSoon();
    else this.persist();
  }

  /**
   * A change only the host and the big screen show (the results presentation, which lives in
   * memory): their snapshots only, nothing to save. A step must reach the screen on time even
   * with a room full of connected phones.
   */
  private commitScreens(): void {
    if (this.disposed) return;
    this.doc.seq += 1;
    const seq = this.doc.seq;
    const at = new Date(this.deps.clock()).toISOString();
    if (this.hostConnections > 0) this.deps.emit({ gameId: this.doc.id, seq, at, type: 'GAME_STATE_SNAPSHOT', audience: 'host', payload: this.snapshotFor({ role: 'host' }) });
    if (this.mainConnections > 0) this.deps.emit({ gameId: this.doc.id, seq, at, type: 'GAME_STATE_SNAPSHOT', audience: 'main', payload: this.snapshotFor({ role: 'main' }) });
  }

  /** Saving the whole document on every batch of taps is wasteful: save live-action changes every few seconds. */
  private persistSoon(): void {
    if (this.actionPersistTimer !== null) return;
    this.actionPersistTimer = this.deps.setTimer(() => {
      this.actionPersistTimer = null;
      this.persist();
    }, ACTION_PERSIST_MS);
  }

  private persist(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      void this.flush();
    });
  }

  async flush(): Promise<void> {
    try {
      await this.deps.repo.saveGame(structuredClone(this.doc));
    } catch (err) {
      console.error(`[engine] failed to persist game ${this.doc.id}:`, err);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const h of this.timerHandles.values()) this.deps.clearTimer(h);
    this.timerHandles.clear();
    if (this.actionCommitTimer !== null) this.deps.clearTimer(this.actionCommitTimer);
    if (this.actionPersistTimer !== null) this.deps.clearTimer(this.actionPersistTimer);
  }

  // ---------------------------------------------------------------------------
  // Guards
  // ---------------------------------------------------------------------------

  private assertNotFinished(): void {
    if (this.doc.status === 'FINISHED') throw invalidState('This game is finished and read-only');
  }

  private assertInProgress(): void {
    if (this.doc.status !== 'IN_PROGRESS') throw invalidState('The game is not in progress');
  }
}

/** Players and the main display before results are revealed: who completed how much, no points or ranks. */
function hideLeaderboardPoints(entries: LeaderboardEntry[]): LeaderboardEntry[] {
  return entries
    .map((e) => ({ ...e, rank: 0, total: 0, lastDelta: 0, wins: 0, series: [] }))
    .sort((a, b) => b.completed - a.completed || a.displayName.localeCompare(b.displayName));
}

function fmtPoints(n: number): string {
  const r = Math.round(n * 10) / 10;
  return `${r} pt${r === 1 ? '' : 's'}`;
}

export { generateGameCode };
export type { Availability };
