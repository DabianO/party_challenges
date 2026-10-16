import type { Branding, GameEvent, GameSettings } from '@challenge/contract';
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
}

/**
 * Engine façade: owns all game runtimes, code lookup and persistence bootstrapping.
 */
export class Engine {
  readonly registry: ModuleRegistry;
  private readonly repo: Repository;
  private readonly runtimes = new Map<string, GameRuntime>();
  private readonly deps: RuntimeDeps;

  constructor(opts: EngineOptions) {
    this.registry = opts.registry;
    this.repo = opts.repo;
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
    if (!rt.verifyHostToken(token)) throw new EngineError('Host authentication required', 'forbidden');
    return rt;
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
