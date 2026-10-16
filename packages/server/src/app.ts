import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RawData, WebSocket } from 'ws';
import type {
  ClientMessage,
  ClientRole,
  CreateGameRequest,
  EventAudience,
  GameEvent,
  HostAction,
  InstanceOptions,
  JoinRequest,
  ResumeRequest,
  ServerMessage,
} from '@challenge/contract';
import { Engine, EngineError, type GameRuntime, type ModuleRegistry, type SnapshotAudience } from '@challenge/engine';
import { MediaError, MediaService } from './media.ts';
import type { SqliteRepository } from './sqlite.ts';

export interface AppConfig {
  registry: ModuleRegistry;
  repo: SqliteRepository;
  dataDir: string;
  publicUrl: string;
  mediaBaseUrl: string;
  mediaMaxBytes: number;
  /** Optional shared secret required to create games (simple host gate for public deployments). */
  hostCreatePassword: string | null;
  webDistDir: string | null;
  logger?: boolean;
}

interface Conn {
  socket: WebSocket;
  gameId: string;
  audience: SnapshotAudience;
}

class ConnectionHub {
  private readonly byGame = new Map<string, Set<Conn>>();

  add(conn: Conn): void {
    let set = this.byGame.get(conn.gameId);
    if (!set) {
      set = new Set();
      this.byGame.set(conn.gameId, set);
    }
    set.add(conn);
  }

  remove(conn: Conn): void {
    const set = this.byGame.get(conn.gameId);
    set?.delete(conn);
    if (set && set.size === 0) this.byGame.delete(conn.gameId);
  }

  deliver(event: GameEvent): void {
    const set = this.byGame.get(event.gameId);
    if (!set) return;
    const msg = JSON.stringify({ type: 'EVENT', event } satisfies ServerMessage);
    for (const conn of set) {
      if (matches(event.audience, conn.audience)) safeSend(conn.socket, msg);
    }
  }

  kick(gameId: string, playerId: string): void {
    const set = this.byGame.get(gameId);
    if (!set) return;
    for (const conn of set) {
      if (conn.audience.role === 'player' && conn.audience.playerId === playerId) {
        safeSend(conn.socket, JSON.stringify({ type: 'ERROR', message: 'You were removed from the game', fatal: true } satisfies ServerMessage));
        try {
          conn.socket.close(4001, 'removed');
        } catch {
          /* ignore */
        }
      }
    }
  }
}

function matches(audience: EventAudience, target: SnapshotAudience): boolean {
  if (audience === 'all') return true;
  if (audience === 'host') return target.role === 'host';
  if (audience === 'main') return target.role === 'main';
  if (audience === 'players') return target.role === 'player';
  if (audience.startsWith('player:')) return target.role === 'player' && target.playerId === audience.slice('player:'.length);
  return false;
}

function safeSend(socket: WebSocket, data: string): void {
  if (socket.readyState === socket.OPEN) {
    try {
      socket.send(data);
    } catch {
      /* connection is going away */
    }
  }
}

function statusFor(err: EngineError): number {
  switch (err.code) {
    case 'validation':
      return 400;
    case 'forbidden':
      return 401;
    case 'not_found':
      return 404;
    case 'rate_limited':
      return 429;
    default:
      return 409;
  }
}

function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (typeof h === 'string' && h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  const q = (req.query as Record<string, unknown>)?.hostToken;
  return typeof q === 'string' ? q : undefined;
}

function pickOptions(body: Record<string, unknown>): Partial<InstanceOptions> {
  const out: Partial<InstanceOptions> = {};
  if ('availability' in body) out.availability = body.availability as InstanceOptions['availability'];
  if ('assignedPlayerIds' in body) out.assignedPlayerIds = body.assignedPlayerIds as string[];
  if ('evaluationMode' in body) out.evaluationMode = body.evaluationMode as InstanceOptions['evaluationMode'];
  return out;
}

export async function buildApp(config: AppConfig): Promise<{ app: FastifyInstance; engine: Engine; hub: ConnectionHub }> {
  const hub = new ConnectionHub();
  const media = new MediaService(join(config.dataDir, 'media'), config.repo, config.mediaMaxBytes);
  const engine = new Engine({
    registry: config.registry,
    repo: config.repo,
    sink: { emit: (e) => hub.deliver(e), kickPlayer: (g, p) => hub.kick(g, p) },
    joinUrl: (code) => `${config.publicUrl}/join/${code}`,
    mediaUrl: (ref) => MediaService.resolveUrl(ref, config.mediaBaseUrl),
  });

  const app = Fastify({ logger: config.logger ?? false, bodyLimit: 1024 * 1024 });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  await app.register(multipart, { limits: { fileSize: config.mediaMaxBytes, files: 1 } });

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof EngineError) return reply.status(statusFor(err)).send({ error: err.message, code: err.code });
    if (err instanceof MediaError) return reply.status(err.status).send({ error: err.message });
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.status(status).send({ error: status >= 500 ? 'Internal server error' : e.message ?? 'Request failed' });
  });

  const hostGame = (req: FastifyRequest): GameRuntime => engine.authorizeHost((req.params as { id: string }).id, bearer(req));

  /** Guest authentication for REST uploads: game code + session token headers. */
  const playerGame = (req: FastifyRequest): { game: GameRuntime; playerId: string } => {
    const code = req.headers['x-game-code'];
    const token = req.headers['x-session-token'];
    if (typeof code !== 'string' || typeof token !== 'string') throw new EngineError('Player session required', 'forbidden');
    const game = engine.requireByCode(code);
    const player = game.findPlayerBySessionToken(token);
    if (!player) throw new EngineError('Session expired', 'forbidden');
    return { game, playerId: player.id };
  };

  // ---------------------------------------------------------------------------
  // Library
  // ---------------------------------------------------------------------------
  app.get('/api/health', async () => ({ ok: true, modules: config.registry.size, games: engine.listGames().length }));

  app.get('/api/modules', async () => ({ modules: config.registry.info() }));

  // ---------------------------------------------------------------------------
  // Games (host)
  // ---------------------------------------------------------------------------
  app.post('/api/games', async (req, reply) => {
    const body = (req.body ?? {}) as CreateGameRequest & { hostPassword?: string };
    if (config.hostCreatePassword && body.hostPassword !== config.hostCreatePassword) {
      return reply.status(401).send({ error: 'Host password required' });
    }
    const { runtime, hostToken } = engine.createGame({ name: body.name, settings: body.settings, branding: body.branding });
    return reply.status(201).send({ game: runtime.gameSummary(), hostToken });
  });

  app.get('/api/games/:id', async (req) => {
    const game = hostGame(req);
    return { snapshot: game.snapshotFor({ role: 'host' }) };
  });

  app.patch('/api/games/:id', async (req) => {
    const game = hostGame(req);
    const body = (req.body ?? {}) as { name?: string; settings?: Record<string, unknown>; branding?: Record<string, unknown> };
    game.updateGame({ name: body.name, settings: body.settings as never, branding: body.branding as never });
    return { game: game.gameSummary() };
  });

  app.delete('/api/games/:id', async (req) => {
    const game = hostGame(req);
    await engine.deleteGame(game.id);
    return { ok: true };
  });

  app.get('/api/games/:id/ledger', async (req) => {
    const game = hostGame(req);
    return { ledger: game.ledger };
  });

  app.get('/api/games/:id/export', async (req) => {
    const game = hostGame(req);
    const doc = engine.exportGame(game.id);
    const { hostTokenHash: _h, ...rest } = doc;
    return { ...rest, players: rest.players.map(({ sessionTokenHash: _s, ...p }) => p) };
  });

  app.post('/api/games/:id/challenges', async (req, reply) => {
    const game = hostGame(req);
    const body = (req.body ?? {}) as Record<string, unknown> & { moduleId?: string; configuration?: unknown };
    if (!body.moduleId) throw new EngineError('moduleId is required', 'validation');
    const inst = game.addChallenge(body.moduleId, body.configuration ?? {}, pickOptions(body));
    return reply.status(201).send({ challenge: game.instanceSummary(inst, true) });
  });

  app.patch('/api/games/:id/challenges/:instanceId', async (req) => {
    const game = hostGame(req);
    const { instanceId } = req.params as { instanceId: string };
    const body = (req.body ?? {}) as Record<string, unknown> & { configuration?: unknown };
    const inst = game.updateChallenge(instanceId, body.configuration, pickOptions(body));
    return { challenge: game.instanceSummary(inst, true) };
  });

  app.delete('/api/games/:id/challenges/:instanceId', async (req) => {
    const game = hostGame(req);
    game.removeChallenge((req.params as { instanceId: string }).instanceId);
    return { ok: true };
  });

  app.post('/api/games/:id/challenges/reorder', async (req) => {
    const game = hostGame(req);
    const body = (req.body ?? {}) as { order?: unknown };
    if (!Array.isArray(body.order) || body.order.some((x) => typeof x !== 'string')) {
      throw new EngineError('order must be an array of challenge ids', 'validation');
    }
    game.reorderChallenges(body.order as string[]);
    return { ok: true };
  });

  app.get('/api/games/:id/challenges/:instanceId/results', async (req) => {
    const game = hostGame(req);
    return { results: game.resultsFor((req.params as { instanceId: string }).instanceId, { role: 'host' }) };
  });

  app.post('/api/games/:id/actions', async (req) => {
    const game = hostGame(req);
    const action = req.body as HostAction;
    if (!action || typeof action !== 'object' || typeof action.action !== 'string') {
      throw new EngineError('action is required', 'validation');
    }
    const result = game.performHostAction(action);
    return { ...result, game: game.gameSummary() };
  });

  // ---------------------------------------------------------------------------
  // Media (§15)
  // ---------------------------------------------------------------------------
  const storeUpload = async (req: FastifyRequest, gameId: string, owner: 'game' | 'submission') => {
    const file = await req.file();
    if (!file) throw new MediaError('No file uploaded');
    const data = await file.toBuffer();
    if (file.file.truncated) throw new MediaError(`File exceeds ${Math.round(config.mediaMaxBytes / 1024 / 1024)} MB limit`, 413);
    const record = await media.store({ data, mimeType: file.mimetype, originalName: file.filename, gameId, owner });
    return {
      id: record.id,
      ref: MediaService.ref(record.id),
      url: MediaService.resolveUrl(MediaService.ref(record.id), config.mediaBaseUrl),
      mimeType: record.mimeType,
      size: record.size,
    };
  };

  /** Host uploads for challenge configuration (FR-56). */
  app.post('/api/games/:id/media', async (req, reply) => {
    const game = hostGame(req);
    return reply.status(201).send(await storeUpload(req, game.id, 'game'));
  });

  /** Guest evidence uploads (FR-57, §14.6). Authenticated with X-Game-Code + X-Session-Token headers. */
  app.post('/api/evidence', async (req, reply) => {
    const { game } = playerGame(req);
    if (game.status !== 'IN_PROGRESS') throw new EngineError('The game is not running', 'invalid_state');
    return reply.status(201).send(await storeUpload(req, game.id, 'submission'));
  });

  app.get('/media/:id', async (req, reply) => {
    const found = media.get((req.params as { id: string }).id);
    if (!found) return reply.status(404).send({ error: 'Not found' });
    reply
      .header('Content-Type', found.record.mimeType)
      .header('Content-Length', found.record.size)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "sandbox; default-src 'none'")
      .header('Content-Disposition', 'inline')
      .header('Cache-Control', 'public, max-age=31536000, immutable');
    return reply.send(found.stream());
  });

  // ---------------------------------------------------------------------------
  // Guests (§8)
  // ---------------------------------------------------------------------------
  app.get('/api/games/by-code/:code', async (req) => {
    const game = engine.requireByCode((req.params as { code: string }).code);
    const s = game.gameSummary();
    return {
      id: s.id,
      name: s.name,
      status: s.status,
      joinable: s.status === 'LOBBY' || (s.status === 'IN_PROGRESS' && s.settings.allowLateJoin),
      playerCount: game.snapshotFor({ role: 'main' }).players.length,
      branding: s.branding,
    };
  });

  app.post('/api/join', async (req, reply) => {
    const body = (req.body ?? {}) as JoinRequest;
    if (typeof body.code !== 'string') throw new EngineError('Game code is required', 'validation');
    const game = engine.requireByCode(body.code);
    const { player, sessionToken } = game.join(body.displayName);
    return reply.status(201).send({
      gameId: game.id,
      gameName: game.gameSummary().name,
      playerId: player.id,
      displayName: player.displayName,
      sessionToken,
    });
  });

  app.post('/api/join/resume', async (req) => {
    const body = (req.body ?? {}) as ResumeRequest;
    if (typeof body.code !== 'string' || typeof body.sessionToken !== 'string') {
      throw new EngineError('code and sessionToken are required', 'validation');
    }
    const game = engine.requireByCode(body.code);
    const player = game.findPlayerBySessionToken(body.sessionToken);
    if (!player) throw new EngineError('Session expired', 'forbidden');
    return { gameId: game.id, gameName: game.gameSummary().name, playerId: player.id, displayName: player.displayName, sessionToken: body.sessionToken };
  });

  /** FR-47: read-only results for finished games (id is unguessable). */
  app.get('/api/games/:id/results', async (req) => {
    const game = engine.getGame((req.params as { id: string }).id);
    const status = game.status;
    if (status !== 'GAME_RESULTS' && status !== 'FINISHED') throw new EngineError('Results are not available yet', 'invalid_state');
    const snap = game.snapshotFor({ role: 'main' });
    return { game: snap.game, leaderboard: snap.leaderboard, challenges: snap.challenges, players: snap.players, results: snap.results };
  });

  // ---------------------------------------------------------------------------
  // Real-time channel (§9)
  // ---------------------------------------------------------------------------
  app.get('/ws', { websocket: true }, (socket, req) => {
    const q = req.query as Record<string, string | undefined>;
    const role = q.role as ClientRole | undefined;
    let game: GameRuntime;
    let audience: SnapshotAudience;
    try {
      if (role === 'host') {
        if (!q.gameId) throw new EngineError('gameId required', 'validation');
        game = engine.authorizeHost(q.gameId, q.token);
        audience = { role: 'host' };
      } else if (role === 'main') {
        game = q.gameId && q.token ? engine.authorizeHost(q.gameId, q.token) : engine.requireByCode(q.code ?? '');
        audience = { role: 'main' };
      } else if (role === 'player') {
        game = engine.requireByCode(q.code ?? '');
        const player = game.findPlayerBySessionToken(q.token ?? '');
        if (!player) throw new EngineError('Session expired', 'forbidden');
        audience = { role: 'player', playerId: player.id };
      } else {
        throw new EngineError('role must be host | main | player', 'validation');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unauthorized';
      safeSend(socket, JSON.stringify({ type: 'ERROR', message, fatal: true } satisfies ServerMessage));
      socket.close(4003, message.slice(0, 100));
      return;
    }

    const conn: Conn = { socket, gameId: game.id, audience };
    hub.add(conn);
    safeSend(
      socket,
      JSON.stringify({
        type: 'HELLO',
        role: audience.role,
        playerId: audience.role === 'player' ? audience.playerId : null,
        serverTime: Date.now(),
      } satisfies ServerMessage),
    );
    try {
      game.connect(audience); // pushes a fresh snapshot to every connected client, including this one (FR-36)
    } catch (err) {
      hub.remove(conn);
      safeSend(socket, JSON.stringify({ type: 'ERROR', message: (err as Error).message, fatal: true } satisfies ServerMessage));
      socket.close(4003);
      return;
    }

    const ack = (clientId: unknown, result: { ok: true } | { ok: false; reason: string }) =>
      safeSend(
        socket,
        JSON.stringify({ type: 'ACK', clientId: String(clientId ?? ''), ok: result.ok, reason: result.ok ? undefined : result.reason } satisfies ServerMessage),
      );
    const requirePlayer = (clientId: unknown): string | null => {
      if (audience.role !== 'player') {
        ack(clientId, { ok: false, reason: 'Only players can do that' });
        return null;
      }
      return audience.playerId;
    };

    socket.on('message', (raw: RawData) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        safeSend(socket, JSON.stringify({ type: 'ERROR', message: 'Malformed message' } satisfies ServerMessage));
        return;
      }
      try {
        switch (msg.type) {
          case 'PING':
            safeSend(socket, JSON.stringify({ type: 'PONG', t: msg.t, serverTime: Date.now() } satisfies ServerMessage));
            break;
          case 'RESYNC':
            safeSend(
              socket,
              JSON.stringify({
                type: 'EVENT',
                event: {
                  gameId: game.id,
                  seq: game.doc.seq,
                  at: new Date().toISOString(),
                  type: 'GAME_STATE_SNAPSHOT',
                  audience: audience.role === 'player' ? `player:${audience.playerId}` : audience.role,
                  payload: game.snapshotFor(audience),
                },
              } satisfies ServerMessage),
            );
            break;
          case 'START': {
            const pid = requirePlayer(msg.clientId);
            if (pid) ack(msg.clientId, game.startAttempt(pid, String(msg.instanceId)));
            break;
          }
          case 'SUBMIT': {
            const pid = requirePlayer(msg.clientId);
            if (pid) ack(msg.clientId, game.submit(pid, String(msg.instanceId), msg.payload));
            break;
          }
          case 'FINISH': {
            const pid = requirePlayer(msg.clientId);
            if (pid) ack(msg.clientId, game.finishAttempt(pid, String(msg.instanceId)));
            break;
          }
          case 'JUDGE': {
            const pid = requirePlayer(msg.clientId);
            if (pid) ack(msg.clientId, game.judge(pid, String(msg.assignmentId), msg.decision, typeof msg.note === 'string' ? msg.note : undefined));
            break;
          }
          default:
            safeSend(socket, JSON.stringify({ type: 'ERROR', message: 'Unknown message type' } satisfies ServerMessage));
        }
      } catch (err) {
        safeSend(socket, JSON.stringify({ type: 'ERROR', message: (err as Error).message } satisfies ServerMessage));
      }
    });

    socket.on('close', () => {
      hub.remove(conn);
      if (engine.hasGame(game.id)) {
        try {
          game.disconnect(audience);
        } catch {
          /* game may have been deleted */
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Static web client (production) with SPA fallback
  // ---------------------------------------------------------------------------
  if (config.webDistDir && existsSync(join(config.webDistDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: config.webDistDir, prefix: '/', wildcard: false });
    app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/media/') || req.url.startsWith('/ws')) {
        return reply.status(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return { app, engine, hub };
}
