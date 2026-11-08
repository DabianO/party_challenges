import { createHmac, timingSafeEqual } from 'node:crypto';
import { SETUP_FORMAT, SETUP_VERSION } from '@challenge/contract';
import type { Branding, EvaluationPreference, GameEvent, GameSettings, GameSetup, TieBreak } from '@challenge/contract';
import { EngineError, notFound } from './errors.ts';
import { generateGameCode, newToken, normalizeGameCode } from './ids.ts';
import type { PersistedGame, Repository } from './persistence.ts';
import { ModuleRegistry } from './registry.ts';
import { GameRuntime, type RuntimeDeps } from './runtime.ts';

export interface EngineSink {
  emit(event: GameEvent): void;
  kickPlayer(gameId: string, playerId: string): void;
}

export interface EngineOptions {
  registry: ModuleRegistry;
  repo: Repository;
  sink: EngineSink;
  joinUrl: (code: string) => string;
  mediaUrl: (ref: string) => string;
  clock?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Randomness for engine decisions such as judge selection (injectable for tests). */
  random?: () => number;
  /**
   * Server secret for `localHostToken()`: a second, stable host token per game that the
   * server hands to the host machine itself, so stored games stay reachable after the
   * browser lost its saved token. Without it only the token issued at creation works.
   */
  hostKey?: string;
}

/**
 * Engine façade: owns all game runtimes, code lookup and persistence bootstrapping.
 */
export class Engine {
  readonly registry: ModuleRegistry;
  private readonly repo: Repository;
  private readonly runtimes = new Map<string, GameRuntime>();
  private readonly deps: RuntimeDeps;
  private readonly hostKey: string | null;

  constructor(opts: EngineOptions) {
    this.registry = opts.registry;
    this.repo = opts.repo;
    this.hostKey = opts.hostKey || null;
    this.deps = {
      registry: opts.registry,
      repo: opts.repo,
      clock: opts.clock ?? (() => Date.now()),
      setTimer: opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout)),
      emit: (e) => opts.sink.emit(e),
      kickPlayer: (g, p) => opts.sink.kickPlayer(g, p),
      joinUrl: opts.joinUrl,
      mediaUrl: opts.mediaUrl,
      random: opts.random ?? Math.random,
      reclaimCode: (current, gameId) => {
        const holder = this.findByCode(current);
        return holder && holder.id !== gameId ? this.uniqueCode() : current;
      },
    };
  }

  /** Load persisted games (FR-51). */
  async init(): Promise<{ restored: number }> {
    const docs = await this.repo.loadGames();
    for (const doc of docs) {
      const rt = new GameRuntime(doc, this.deps);
      this.runtimes.set(doc.id, rt);
      if (doc.status === 'IN_PROGRESS' || doc.status === 'LOBBY') rt.restoreAfterRestart();
    }
    return { restored: docs.length };
  }

  createGame(input: { name: string; settings?: Partial<GameSettings>; branding?: Branding }): { runtime: GameRuntime; hostToken: string } {
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 80) throw new EngineError('Game name must be 1–80 characters', 'validation');
    const hostToken = newToken();
    const doc = GameRuntime.createDocument({
      name,
      code: this.uniqueCode(),
      hostToken,
      settings: input.settings,
      branding: input.branding,
      now: this.deps.clock(),
    });
    const runtime = new GameRuntime(doc, this.deps);
    this.runtimes.set(doc.id, runtime);
    void runtime.flush();
    return { runtime, hostToken };
  }

  /**
   * Create a new DRAFT game from a setup file (see `GameRuntime.exportSetup`). Media refs
   * must already point at media stored on this server. Challenges whose module is missing
   * or whose configuration no longer validates are skipped and reported as warnings.
   */
  importSetup(raw: unknown): { runtime: GameRuntime; hostToken: string; warnings: string[] } {
    const setup = parseSetup(raw);
    const warnings: string[] = [];
    const { runtime, hostToken } = this.createGame({ name: setup.game.name });
    try {
      runtime.updateGame({ settings: pickSettings(setup.game.settings), branding: pickBranding(setup.game.branding) });
    } catch (err) {
      warnings.push(`Game settings were reset to defaults: ${(err as Error).message}`);
    }
    setup.challenges.forEach((c, i) => {
      const label = `Challenge ${i + 1}${typeof c.title === 'string' && c.title ? ` "${c.title}"` : ''} (${c.moduleId})`;
      try {
        const options = {
          title: typeof c.title === 'string' ? c.title : undefined,
          category: typeof c.category === 'string' ? c.category : undefined,
          availability: c.availability,
          evaluationMode: c.evaluationMode ?? null,
          allowReplay: c.allowReplay === true,
          inPresentation: c.inPresentation !== false,
        };
        try {
          runtime.addChallenge(c.moduleId, c.configuration, options);
        } catch (err) {
          // An evaluation override the installed version no longer supports is not worth losing the challenge for.
          if (!options.evaluationMode) throw err;
          runtime.addChallenge(c.moduleId, c.configuration, { ...options, evaluationMode: null });
          warnings.push(`${label}: evaluation override "${options.evaluationMode}" is not supported any more; using the module default`);
        }
        if (c.availability === 'assigned') warnings.push(`${label}: assigned challenge imported with nobody assigned yet`);
      } catch (err) {
        warnings.push(`${label} was skipped: ${(err as Error).message}`);
      }
    });
    return { runtime, hostToken, warnings };
  }

  /**
   * A fresh DRAFT game with another game's configuration (board, titles, options,
   * settings, branding; media is shared on this server) and no players or scores. The
   * original game is left as it is.
   */
  duplicateGame(gameId: string): { runtime: GameRuntime; hostToken: string; warnings: string[] } {
    return this.importSetup(this.getGame(gameId).exportSetup());
  }

  private uniqueCode(): string {
    for (let i = 0; i < 50; i++) {
      const code = generateGameCode();
      if (!this.findByCode(code)) return code;
    }
    throw new EngineError('Could not allocate a game code', 'invalid_state');
  }

  getGame(id: string): GameRuntime {
    const rt = this.runtimes.get(id);
    if (!rt) throw notFound('Game not found');
    return rt;
  }

  hasGame(id: string): boolean {
    return this.runtimes.has(id);
  }

  /** SR-7: finished games no longer resolve by code. */
  findByCode(code: string): GameRuntime | undefined {
    const normalized = normalizeGameCode(code);
    for (const rt of this.runtimes.values()) {
      if (rt.code === normalized && rt.status !== 'FINISHED') return rt;
    }
    return undefined;
  }

  requireByCode(code: string): GameRuntime {
    const rt = this.findByCode(code);
    if (!rt) throw notFound('No game with that code');
    return rt;
  }

  authorizeHost(gameId: string, token: string | undefined): GameRuntime {
    const rt = this.getGame(gameId);
    if (!rt.verifyHostToken(token) && !this.isLocalHostToken(gameId, token)) throw new EngineError('Host authentication required', 'forbidden');
    return rt;
  }

  /** Stable host token for a game derived from the server's host key (null when none is configured). */
  localHostToken(gameId: string): string | null {
    return this.hostKey ? createHmac('sha256', this.hostKey).update(`host:${gameId}`).digest('base64url') : null;
  }

  private isLocalHostToken(gameId: string, token: string | undefined): boolean {
    const expected = this.localHostToken(gameId);
    if (!expected || typeof token !== 'string' || token.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  }

  async deleteGame(gameId: string): Promise<void> {
    const rt = this.getGame(gameId);
    rt.dispose();
    this.runtimes.delete(gameId);
    await this.repo.deleteGame(gameId);
  }

  listGames(): GameRuntime[] {
    return [...this.runtimes.values()];
  }

  async shutdown(): Promise<void> {
    for (const rt of this.runtimes.values()) {
      rt.dispose();
      await rt.flush();
    }
  }

  /** Test/debug helper: raw persisted document. */
  exportGame(gameId: string): PersistedGame {
    return structuredClone(this.getGame(gameId).doc);
  }
}

function parseSetup(raw: unknown): GameSetup {
  const bad = (why: string) => new EngineError(`Not a valid setup file: ${why}`, 'validation');
  if (!raw || typeof raw !== 'object') throw bad('expected a JSON object');
  const s = raw as Partial<GameSetup>;
  if (s.format !== SETUP_FORMAT) throw bad(`"format" must be "${SETUP_FORMAT}"`);
  if (typeof s.version !== 'number' || s.version > SETUP_VERSION) throw bad(`version ${String(s.version)} is newer than this server understands (${SETUP_VERSION})`);
  if (!s.game || typeof s.game !== 'object' || typeof s.game.name !== 'string') throw bad('game.name is missing');
  if (!Array.isArray(s.challenges)) throw bad('challenges must be a list');
  for (const [i, c] of s.challenges.entries()) {
    if (!c || typeof c !== 'object' || typeof c.moduleId !== 'string') throw bad(`challenge ${i + 1} has no moduleId`);
    if (!c.configuration || typeof c.configuration !== 'object') throw bad(`challenge ${i + 1} has no configuration`);
  }
  return s as GameSetup;
}

const TIE_BREAKS: TieBreak[] = ['shared', 'wins', 'earliest'];
const PREFERENCES: EvaluationPreference[] = ['module-default', 'automatic', 'peer', 'host', 'hybrid'];

/** Only the known, well-typed settings from a setup file. */
function pickSettings(raw: unknown): Partial<GameSettings> {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Partial<GameSettings> = {};
  if (typeof s.allowLateJoin === 'boolean') out.allowLateJoin = s.allowLateJoin;
  if (TIE_BREAKS.includes(s.tieBreak as TieBreak)) out.tieBreak = s.tieBreak as TieBreak;
  if (PREFERENCES.includes(s.evaluationPreference as EvaluationPreference)) out.evaluationPreference = s.evaluationPreference as EvaluationPreference;
  if (typeof s.judgeDeadlineSeconds === 'number') out.judgeDeadlineSeconds = s.judgeDeadlineSeconds;
  if (typeof s.maxReassignments === 'number') out.maxReassignments = s.maxReassignments;
  return out;
}

const BRANDING_TEXT = ['hostName', 'accentColor', 'logo', 'background', 'introText', 'finalText'] as const;

function pickBranding(raw: unknown): Branding {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Branding = {};
  for (const key of BRANDING_TEXT) if (typeof b[key] === 'string') out[key] = (b[key] as string).slice(0, 2000);
  if (b.theme === 'dark' || b.theme === 'light') out.theme = b.theme;
  return out;
}
