import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { ServerMessage } from '@challenge/contract';
import { ModuleRegistry } from '@challenge/engine';
import photoHunt from '../../../challenges/photo-hunt/server/index.ts';
import { buildApp } from '../src/app.ts';
import { SqliteRepository } from '../src/sqlite.ts';
import { RateLimiter, isPublicRequest } from '../src/surface.ts';

describe('the public surface allow-list', () => {
  it('serves guests and the big screen, nothing for the host', () => {
    const allowed: [string, string][] = [
      ['GET', '/'],
      ['GET', '/join'],
      ['GET', '/join/ABC123'],
      ['GET', '/display/ABC123'],
      ['GET', '/results/g_123'],
      ['GET', '/assets/index-abc123.js'],
      ['GET', '/favicon.ico'],
      ['HEAD', '/join/ABC123'],
      ['GET', '/api/health'],
      ['GET', '/api/games/by-code/ABC123'],
      ['POST', '/api/join'],
      ['POST', '/api/join/resume'],
      ['GET', '/api/games/g_123/results'],
      ['POST', '/api/evidence'],
      ['POST', '/api/avatar'],
      ['DELETE', '/api/avatar'],
      ['GET', '/media/m_123'],
      ['GET', '/ws?role=player&code=ABC123&token=t'],
      ['GET', '/ws?role=main&code=ABC123'],
    ];
    const blocked: [string, string][] = [
      ['GET', '/host'],
      ['GET', '/host/g_123'],
      ['GET', '/api/local/games'],
      ['GET', '/api/modules'],
      ['POST', '/api/games'],
      ['POST', '/api/games/import'],
      ['GET', '/api/games/g_123'],
      ['PATCH', '/api/games/g_123'],
      ['DELETE', '/api/games/g_123'],
      ['POST', '/api/games/g_123/actions'],
      ['GET', '/api/games/g_123/setup'],
      ['POST', '/api/games/g_123/media'],
      ['POST', '/api/games/g_123/challenges'],
      ['GET', '/ws?role=host&gameId=g_1&token=t'],
      ['GET', '/ws?role=main&gameId=g_1&token=t'],
      ['GET', '/ws?role=main&code=ABC&token=t'],
      ['POST', '/join/ABC123'],
      ['GET', '/display/../host'],
      ['GET', '/join/%2e%2e/host'],
      ['GET', '//host'],
      ['GET', '/media/..%2fplatform.sqlite'],
      ['GET', '/anything-else'],
    ];
    for (const [m, u] of allowed) expect(isPublicRequest(m, u), `${m} ${u}`).toBe(true);
    for (const [m, u] of blocked) expect(isPublicRequest(m, u), `${m} ${u}`).toBe(false);
  });

  it('limits requests per client and kind in one-minute windows', () => {
    let now = 0;
    const limiter = new RateLimiter({ join: 3 }, () => now);
    expect([1, 2, 3].map(() => limiter.hit('1.2.3.4', 'join'))).toEqual([0, 0, 0]);
    expect(limiter.hit('1.2.3.4', 'join')).toBe(60);
    expect(limiter.hit('5.6.7.8', 'join')).toBe(0); // someone else
    now = 30_000;
    expect(limiter.hit('1.2.3.4', 'join')).toBe(30);
    now = 60_000;
    expect(limiter.hit('1.2.3.4', 'join')).toBe(0); // a new minute
    expect(limiter.hit('1.2.3.4', 'unknown-kind')).toBe(0);
  });
});

describe('internet mode: a public and an admin server', () => {
  let publicUrl = '';
  let adminUrl = '';
  let adminPort = 0;
  let publicPort = 0;
  let close: () => Promise<void>;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'challenge-surface-'));
    const registry = new ModuleRegistry();
    registry.register(photoHunt as never, null);
    const repo = new SqliteRepository(join(dataDir, 'test.sqlite'));
    const { app, engine, adminServer } = await buildApp({
      registry,
      repo,
      dataDir,
      publicUrl: 'https://party.test',
      mediaBaseUrl: '',
      mediaMaxBytes: 1024 * 1024,
      mediaMaxPerGameBytes: 5000,
      hostCreatePassword: 'correct horse',
      webDistDir: null,
      hostKey: 'test-host-key-0123456789abcdefghijklmnop',
      localHostAccess: true,
      adminSurface: true,
    });
    expect(adminServer).not.toBeNull();
    await engine.init();
    await app.listen({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => adminServer!.listen(0, '127.0.0.1', () => resolve()));
    const port = (s: { address(): unknown }) => (s.address() as { port: number }).port;
    publicPort = port(app.server);
    adminPort = port(adminServer!);
    publicUrl = `http://127.0.0.1:${publicPort}`;
    adminUrl = `http://localhost:${adminPort}`;
    close = async () => {
      await engine.shutdown();
      await app.close();
      repo.close();
    };
  });

  afterAll(async () => {
    await close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function call(base: string, path: string, init: RequestInit & { token?: string; ip?: string } = {}) {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers as Record<string, string>) };
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    if (init.ip) headers['cf-connecting-ip'] = init.ip;
    const res = await fetch(`${base}${path}`, { ...init, headers });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: (text ? JSON.parse(text) : null) as Record<string, unknown> };
  }

  /** A game made on the admin server, open and running, with one player joined on the public one. */
  async function runningGame(ip: string) {
    const created = await call(adminUrl, '/api/games', { method: 'POST', body: JSON.stringify({ name: 'Online party', hostPassword: 'correct horse' }) });
    expect(created.status).toBe(201);
    const id = (created.body.game as { id: string }).id;
    const code = (created.body.game as { code: string }).code;
    const token = created.body.hostToken as string;
    await call(adminUrl, `/api/games/${id}/challenges`, { method: 'POST', token, body: JSON.stringify({ moduleId: 'photo-hunt', configuration: { task: 'Something red' } }) });
    await call(adminUrl, `/api/games/${id}/actions`, { method: 'POST', token, body: JSON.stringify({ action: 'open-lobby' }) });
    const joined = await call(publicUrl, '/api/join', { method: 'POST', ip, body: JSON.stringify({ code, displayName: 'Ada' }) });
    expect(joined.status).toBe(201);
    await call(adminUrl, `/api/games/${id}/actions`, { method: 'POST', token, body: JSON.stringify({ action: 'start-game' }) });
    return { id, code, token, session: joined.body.sessionToken as string };
  }

  function wsOutcome(url: string): Promise<{ hello: boolean; error?: string }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(url);
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as ServerMessage;
        if (msg.type === 'HELLO') {
          ws.close();
          resolve({ hello: true });
        }
      });
      ws.on('unexpected-response', (_req, res) => {
        resolve({ hello: false, error: `HTTP ${res.statusCode}` });
        ws.terminate();
      });
      ws.on('error', (err) => resolve({ hello: false, error: err.message }));
    });
  }

  it('keeps everything for the host off the public server, even with a valid host token', async () => {
    const { id, token } = await runningGame('10.0.0.1');
    for (const [method, path] of [
      ['GET', '/api/local/games'],
      ['POST', '/api/games'],
      ['POST', '/api/games/import'],
      ['GET', `/api/games/${id}`],
      ['GET', `/api/games/${id}/setup`],
      ['POST', `/api/games/${id}/actions`],
      ['GET', '/host'],
    ] as const) {
      const res = await call(publicUrl, path, { method, token, body: method === 'POST' ? JSON.stringify({ action: 'end-game', hostPassword: 'correct horse' }) : undefined });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect(await wsOutcome(`ws://127.0.0.1:${publicPort}/ws?role=host&gameId=${id}&token=${token}`)).toEqual({ hello: false, error: 'HTTP 404' });
    // The same on the admin server works.
    expect((await call(adminUrl, `/api/games/${id}`, { token })).status).toBe(200);
    expect((await call(adminUrl, '/api/local/games')).status).toBe(200);
    expect(await wsOutcome(`ws://localhost:${adminPort}/ws?role=host&gameId=${id}&token=${token}`)).toEqual({ hello: true });
  });

  it('lets guests and the big screen do everything they need on the public server', async () => {
    const { id, code, session } = await runningGame('10.0.0.2');
    expect((await call(publicUrl, `/api/games/by-code/${code}`, { ip: '10.0.0.2' })).body).toMatchObject({ id, joinable: true });
    expect(await wsOutcome(`ws://127.0.0.1:${publicPort}/ws?role=player&code=${code}&token=${session}`)).toEqual({ hello: true });
    expect(await wsOutcome(`ws://127.0.0.1:${publicPort}/ws?role=main&code=${code}`)).toEqual({ hello: true });
    expect((await call(publicUrl, '/api/health')).body).toEqual({ ok: true });
  });

  it('only answers the admin server by the host machine’s own name', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: adminPort, path: '/api/local/games', headers: { host: `evil.example:${adminPort}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('sends security headers', async () => {
    const res = await call(publicUrl, '/api/health');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('slows down floods of joins from one address', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await call(publicUrl, '/api/join', { method: 'POST', ip: '10.9.9.9', body: JSON.stringify({ code: 'NOPE00', displayName: 'X' }) })).status);
    expect(statuses.slice(0, 60).every((s) => s === 404)).toBe(true); // unknown code, but answered
    expect(statuses[60]).toBe(429);
    // Someone else is not affected.
    expect((await call(publicUrl, '/api/join', { method: 'POST', ip: '10.9.9.10', body: JSON.stringify({ code: 'NOPE00', displayName: 'X' }) })).status).toBe(404);
  });

  it('stops a game’s uploads at its storage limit', async () => {
    const { code, session } = await runningGame('10.0.0.3');
    // A PNG signature and padding: 3 kB each, the game may store 5 kB.
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(3000)]);
    const upload = async () => {
      const form = new FormData();
      form.append('file', new Blob([png], { type: 'image/png' }), 'photo.png');
      const res = await fetch(`${publicUrl}/api/evidence`, { method: 'POST', headers: { 'x-game-code': code, 'x-session-token': session, 'cf-connecting-ip': '10.0.0.3' }, body: form });
      return res.status;
    };
    expect(await upload()).toBe(201);
    expect(await upload()).toBe(413);
  });
});
