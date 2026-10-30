import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { GameSnapshot, ServerMessage } from '@challenge/contract';
import { ModuleRegistry } from '@challenge/engine';
import closestNumber from '../../../challenges/closest-number/server/index.ts';
import captionThis from '../../../challenges/caption-this/server/index.ts';
import { buildApp } from '../src/app.ts';
import { SqliteRepository } from '../src/sqlite.ts';

let baseUrl = '';
let wsUrl = '';
let close: () => Promise<void>;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'challenge-test-'));
  const registry = new ModuleRegistry();
  registry.register(closestNumber as never, null);
  registry.register(captionThis as never, null);
  const repo = new SqliteRepository(join(dataDir, 'test.sqlite'));
  const { app, engine } = await buildApp({
    registry,
    repo,
    dataDir,
    publicUrl: 'http://party.test',
    mediaBaseUrl: '',
    mediaMaxBytes: 1024 * 1024,
    hostCreatePassword: null,
    webDistDir: null,
    webDevPort: 5999,
    hostKey: 'test-host-key-0123456789abcdefghijklmnop',
    localHostAccess: true,
  });
  await engine.init();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}`;
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

async function api<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers as Record<string, string>) };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
  return { status: res.status, body: (await res.json()) as T };
}

function connect(query: string) {
  return new Promise<{
    ws: WebSocket;
    messages: ServerMessage[];
    next: (pred: (m: ServerMessage) => boolean) => Promise<ServerMessage>;
    send: (m: Record<string, unknown>) => void;
    closeCode: () => number | null;
  }>((resolve, reject) => {
    const ws = new WebSocket(`${wsUrl}/ws?${query}`);
    const messages: ServerMessage[] = [];
    const waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
    let code: number | null = null;
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as ServerMessage;
      messages.push(msg);
      for (const w of [...waiters]) {
        if (w.pred(msg)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    });
    ws.on('close', (c) => (code = c));
    ws.on('error', reject);
    ws.on('open', () =>
      resolve({
        ws,
        messages,
        send: (m) => ws.send(JSON.stringify(m)),
        closeCode: () => code,
        next: (pred) =>
          new Promise((res, rej) => {
            const existing = messages.find(pred);
            if (existing) return res(existing);
            const t = setTimeout(() => rej(new Error('timeout waiting for message')), 3000);
            waiters.push({
              pred,
              resolve: (m) => {
                clearTimeout(t);
                res(m);
              },
            });
          }),
      }),
    );
  });
}

/** Wait (up to 3 s) for a socket to close and return its close code. */
async function closedWith(sock: { closeCode: () => number | null }): Promise<number | null> {
  for (let i = 0; i < 60 && sock.closeCode() === null; i++) await new Promise((r) => setTimeout(r, 50));
  return sock.closeCode();
}

const snapshotOf = (m: ServerMessage): GameSnapshot | null =>
  m.type === 'EVENT' && m.event.type === 'GAME_STATE_SNAPSHOT' ? (m.event.payload as GameSnapshot) : null;
const ackOf = (clientId: string) => (m: ServerMessage) => m.type === 'ACK' && m.clientId === clientId;

describe('REST + WebSocket API', () => {
  it('runs a board game end-to-end, including peer judging over WebSocket', async () => {
    const created = await api<{ game: { id: string; code: string }; hostToken: string }>('/api/games', {
      method: 'POST',
      body: JSON.stringify({ name: 'API party', settings: { judgeDeadlineSeconds: 30 } }),
    });
    expect(created.status).toBe(201);
    const { game, hostToken } = created.body;
    expect((await api('/api/games/' + game.id)).status).toBe(401); // SR-6

    const act = (action: Record<string, unknown>) =>
      api<{ ok: boolean; message?: string; error?: string }>(`/api/games/${game.id}/actions`, { method: 'POST', token: hostToken, body: JSON.stringify(action) });

    const closest = await api<{ challenge: { id: string; availability: string } }>(`/api/games/${game.id}/challenges`, {
      method: 'POST',
      token: hostToken,
      body: JSON.stringify({ moduleId: 'closest-number', configuration: { question: 'Jelly beans?', correctAnswer: 500, timeLimit: 60 } }),
    });
    expect(closest.status).toBe(201);
    const gated = await api<{ challenge: { id: string; availability: string; evaluationMode: string } }>(`/api/games/${game.id}/challenges`, {
      method: 'POST',
      token: hostToken,
      body: JSON.stringify({
        moduleId: 'caption-this',
        configuration: { image: 'media://x', prompt: 'Caption it', timeLimit: 60 },
        availability: 'host-unlocked',
        evaluationMode: 'peer',
      }),
    });
    expect(gated.body.challenge).toMatchObject({ availability: 'host-unlocked', evaluationMode: 'peer' });
    const bad = await api<{ error: string }>(`/api/games/${game.id}/challenges/${closest.body.challenge.id}`, {
      method: 'PATCH',
      token: hostToken,
      body: JSON.stringify({ evaluationMode: 'peer' }),
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/supports evaluation modes/);

    expect((await act({ action: 'open-lobby' })).status).toBe(200);
    const host = await connect(`role=host&gameId=${game.id}&token=${hostToken}`);
    await host.next((m) => m.type === 'HELLO');
    expect(snapshotOf(await host.next((m) => snapshotOf(m) !== null))!.joinUrl).toBe(`http://party.test/join/${game.code}`);

    const joinAs = async (name: string) => {
      const r = await api<{ playerId: string; sessionToken: string; displayName: string }>('/api/join', { method: 'POST', body: JSON.stringify({ code: game.code, displayName: name }) });
      expect(r.status).toBe(201);
      const socket = await connect(`role=player&code=${game.code}&token=${r.body.sessionToken}`);
      await socket.next((m) => snapshotOf(m) !== null);
      return { ...r.body, socket };
    };
    const ada = await joinAs('Ada');
    const bea = await joinAs('Bea');
    const display = await connect(`role=main&code=${game.code}`);
    await display.next((m) => snapshotOf(m) !== null);

    // Wrong session token is refused with 4003.
    const badSock = await connect(`role=player&code=${game.code}&token=bogus`);
    await badSock.next((m) => m.type === 'ERROR');
    expect(await closedWith(badSock)).toBe(4003);

    expect((await act({ action: 'start-game' })).status).toBe(200);
    const board = snapshotOf(await ada.socket.next((m) => snapshotOf(m)?.game.status === 'IN_PROGRESS'))!;
    expect(board.board.map((b) => b.status)).toEqual(['available', 'locked']);
    expect(board.challenges[0]?.configuration).toBeUndefined(); // FR-38
    expect(board.me).toEqual({ playerId: ada.playerId, displayName: 'Ada' });

    // Display cannot act.
    display.send({ type: 'START', instanceId: closest.body.challenge.id, clientId: 'x' });
    expect(await display.next(ackOf('x'))).toMatchObject({ ok: false });

    // Ada plays Closest Number at her own pace.
    ada.socket.send({ type: 'START', instanceId: closest.body.challenge.id, clientId: 'c1' });
    expect(await ada.socket.next(ackOf('c1'))).toMatchObject({ ok: true });
    const inProgress = snapshotOf(await ada.socket.next((m) => snapshotOf(m)?.board[0]?.status === 'in_progress'))!;
    expect(inProgress.board[0]!.timers[0]).toMatchObject({ tag: 'lock', playerId: ada.playerId });
    // The answer (500) must not reach the big screen; ids and timestamps may contain those digits.
    expect(JSON.stringify(snapshotOf(await display.next((m) => snapshotOf(m) !== null))!)).not.toMatch(/(?<![\w.])500(?![\w.])/);
    ada.socket.send({ type: 'SUBMIT', instanceId: closest.body.challenge.id, payload: { answer: 480 }, clientId: 'c2' });
    expect(await ada.socket.next(ackOf('c2'))).toMatchObject({ ok: true });
    ada.socket.send({ type: 'FINISH', instanceId: closest.body.challenge.id, clientId: 'c3' });
    expect(await ada.socket.next(ackOf('c3'))).toMatchObject({ ok: true });
    await host.next((m) => m.type === 'EVENT' && m.event.type === 'PLAYER_SUBMITTED');

    // Host unlocks the gated peer challenge; Bea plays it; Ada judges it.
    expect((await act({ action: 'unlock-challenge', instanceId: gated.body.challenge.id })).status).toBe(200);
    await bea.socket.next((m) => snapshotOf(m)?.board[1]?.status === 'available');
    bea.socket.send({ type: 'START', instanceId: gated.body.challenge.id, clientId: 'b1' });
    await bea.socket.next(ackOf('b1'));
    // One tap: `final` locks the answer in straight away.
    bea.socket.send({ type: 'SUBMIT', instanceId: gated.body.challenge.id, payload: { caption: 'Cheese!' }, clientId: 'b2', final: true });
    await bea.socket.next(ackOf('b2'));
    await bea.socket.next((m) => snapshotOf(m)?.board[1]?.status === 'submitted');

    const judging = snapshotOf(await ada.socket.next((m) => (snapshotOf(m)?.judging.length ?? 0) > 0))!.judging[0]!;
    expect(JSON.stringify(judging.presentation)).toContain('Cheese!');
    // Bea never sees who judges her (FR-63); the display never sees assignments.
    expect(JSON.stringify(snapshotOf(await bea.socket.next((m) => snapshotOf(m) !== null))!)).not.toContain(judging.assignmentId);
    bea.socket.send({ type: 'JUDGE', assignmentId: judging.assignmentId, decision: 'approve', clientId: 'b4' });
    expect(await bea.socket.next(ackOf('b4'))).toMatchObject({ ok: false }); // SR-11
    const beforeJudge = bea.socket.messages.length;
    ada.socket.send({ type: 'JUDGE', assignmentId: judging.assignmentId, decision: 'approve', note: 'ha', clientId: 'c4' });
    expect(await ada.socket.next(ackOf('c4'))).toMatchObject({ ok: true });
    // Scored, but Bea and the display learn nothing until the host reveals results.
    const beaHidden = snapshotOf(await bea.socket.next((m) => bea.socket.messages.indexOf(m) >= beforeJudge && snapshotOf(m) !== null))!;
    expect(beaHidden.board[1]).toMatchObject({ status: 'submitted', points: null });
    expect(beaHidden.leaderboard.every((l) => l.total === 0)).toBe(true);
    expect(bea.socket.messages.some((m) => m.type === 'EVENT' && m.event.type === 'PLAYER_SCORED')).toBe(false);
    expect((await act({ action: 'reveal-results' })).status).toBe(200);
    const beaScored = snapshotOf(await bea.socket.next((m) => snapshotOf(m)?.board[1]?.status === 'scored'))!;
    expect(beaScored.board[1]!.points).toBe(10);
    expect(beaScored.leaderboard[0]).toMatchObject({ displayName: 'Bea', total: 10 });

    // Host closes Closest Number → aggregate scoring.
    expect((await act({ action: 'close-challenge', instanceId: closest.body.challenge.id })).status).toBe(200);
    const results = snapshotOf(await host.next((m) => snapshotOf(m)?.challenges[0]?.phase === 'RESULTS'))!;
    expect(results.results[closest.body.challenge.id]!.scores).toEqual([{ playerId: ada.playerId, points: 10 }]);
    expect(results.activity[0]?.text).toMatch(/Results are in/);

    // Host override reverses Bea's approval.
    const scored = results.scored.find((s) => s.playerId === bea.playerId)!;
    expect((await act({ action: 'override', submissionId: scored.submissionId, decision: 'reject', reason: 'Not a caption' })).status).toBe(200);
    expect(snapshotOf(await bea.socket.next((m) => snapshotOf(m)?.board[1]?.points === 0))!.leaderboard.find((l) => l.playerId === bea.playerId)?.total).toBe(0);

    // PING/PONG and RESYNC still work.
    ada.socket.send({ type: 'PING', t: 7 });
    expect(await ada.socket.next((m) => m.type === 'PONG')).toMatchObject({ t: 7 });
    const before = ada.socket.messages.length;
    ada.socket.send({ type: 'RESYNC' });
    await ada.socket.next((m) => ada.socket.messages.indexOf(m) >= before && snapshotOf(m) !== null);

    expect((await act({ action: 'end-game' })).status).toBe(200);
    const finished = snapshotOf(await display.next((m) => snapshotOf(m)?.game.status === 'GAME_RESULTS'))!;
    expect(finished.leaderboard).toHaveLength(2);
    const publicResults = await api<{ leaderboard: unknown[] }>(`/api/games/${game.id}/results`);
    expect(publicResults.status).toBe(200);
    expect((await act({ action: 'close-game' })).status).toBe(200);
    expect((await api(`/api/games/by-code/${game.code}`)).status).toBe(404); // SR-7
    const exported = await api<Record<string, unknown>>(`/api/games/${game.id}/export`, { token: hostToken });
    expect(JSON.stringify(exported.body)).not.toContain('TokenHash');

    // Start over with the same setup, or continue the closed game.
    expect((await api(`/api/games/${game.id}/duplicate`, { method: 'POST', body: '{}' })).status).toBe(401);
    const copy = await api<{ game: { id: string; status: string }; hostToken: string; warnings: string[] }>(`/api/games/${game.id}/duplicate`, { method: 'POST', token: hostToken, body: '{}' });
    expect(copy.status).toBe(201);
    expect(copy.body.game.status).toBe('DRAFT');
    const copySnap = (await api<{ snapshot: GameSnapshot }>(`/api/games/${copy.body.game.id}`, { token: copy.body.hostToken })).body.snapshot;
    expect(copySnap.challenges).toHaveLength(2);
    expect(copySnap.players).toEqual([]);
    expect((await act({ action: 'reopen-game' })).status).toBe(200);
    expect((await api(`/api/games/by-code/${game.code}`)).status).toBe(200);
    const resumed = await api<{ playerId: string }>('/api/join/resume', { method: 'POST', body: JSON.stringify({ code: game.code, sessionToken: ada.sessionToken }) });
    expect(resumed.body.playerId).toBe(ada.playerId); // players keep their place

    for (const s of [host, ada.socket, bea.socket, display]) s.ws.close();
  });

  it('exports a setup with its media and imports it as a new game', async () => {
    const created = await api<{ game: { id: string }; hostToken: string }>('/api/games', { method: 'POST', body: JSON.stringify({ name: 'Backup me' }) });
    const { game, hostToken } = created.body;
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 7)]);
    const form = new FormData();
    form.append('file', new Blob([png], { type: 'image/png' }), 'cat.png');
    const uploaded = (await (await fetch(`${baseUrl}/api/games/${game.id}/media`, { method: 'POST', headers: { authorization: `Bearer ${hostToken}` }, body: form })).json()) as { ref: string };
    const added = await api<{ challenge: { title: string; customTitle: string; category: string; allowReplay: boolean } }>(`/api/games/${game.id}/challenges`, {
      method: 'POST',
      token: hostToken,
      body: JSON.stringify({ moduleId: 'caption-this', configuration: { image: uploaded.ref, prompt: 'Caption it', timeLimit: 60 }, title: 'Cat caption', category: 'Creativity', allowReplay: true }),
    });
    expect(added.body.challenge).toMatchObject({ title: 'Cat caption', customTitle: 'Cat caption', category: 'Creativity', allowReplay: true });

    expect((await api(`/api/games/${game.id}/setup`)).status).toBe(401);
    const exported = await fetch(`${baseUrl}/api/games/${game.id}/setup`, { headers: { authorization: `Bearer ${hostToken}` } });
    expect(exported.headers.get('content-disposition')).toContain('Backup-me-setup.json');
    const setup = (await exported.json()) as { challenges: { configuration: { image: string } }[]; media: Record<string, { data: string }> };
    expect(Buffer.from(setup.media[uploaded.ref]!.data, 'base64').equals(png)).toBe(true);

    const imported = await api<{ game: { id: string; name: string; status: string }; hostToken: string; warnings: string[] }>('/api/games/import', {
      method: 'POST',
      body: JSON.stringify({ setup }),
    });
    expect(imported.status).toBe(201);
    expect(imported.body.game).toMatchObject({ name: 'Backup me', status: 'DRAFT' });
    expect(imported.body.warnings).toEqual([]);
    const copy = (await api<{ snapshot: GameSnapshot }>(`/api/games/${imported.body.game.id}`, { token: imported.body.hostToken })).body.snapshot;
    const image = String(copy.challenges[0]!.configuration!.image);
    expect(copy.challenges[0]).toMatchObject({ title: 'Cat caption', allowReplay: true });
    expect(image).toMatch(/^media:\/\//);
    expect(image).not.toBe(uploaded.ref); // a fresh copy of the file on this server
    expect(Buffer.from(await (await fetch(`${baseUrl}/media/${image.slice('media://'.length)}`)).arrayBuffer()).equals(png)).toBe(true);

    const invalid = await api<{ error: string }>('/api/games/import', { method: 'POST', body: JSON.stringify({ setup: { hello: 'world' } }) });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toMatch(/Not a valid setup file/);
  });

  it('in dev, sends pages opened on the game server to the dev web server', async () => {
    const page = await fetch(`${baseUrl}/join/ABC123?x=1`, { redirect: 'manual' });
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe('http://127.0.0.1:5999/join/ABC123?x=1');
    const missing = await api<{ error: string }>('/api/no-such-route');
    expect(missing.status).toBe(404);
  });

  it('lists stored games with a host token only for the host machine', async () => {
    const created = await api<{ game: { id: string }; hostToken: string }>('/api/games', { method: 'POST', body: JSON.stringify({ name: 'Lost token' }) });
    const local = await api<{ games: { game: { id: string }; hostToken: string; challengeCount: number }[] }>('/api/local/games');
    expect(local.status).toBe(200);
    const entry = local.body.games.find((g) => g.game.id === created.body.game.id)!;
    expect(entry.hostToken).not.toBe(created.body.hostToken);
    expect((await api(`/api/games/${created.body.game.id}`, { token: entry.hostToken })).status).toBe(200);
    expect((await api(`/api/games/${created.body.game.id}`, { token: `${entry.hostToken}x` })).status).toBe(401);
    // Through a proxy that reports another device (as the Vite dev proxy does for phones) it is refused…
    expect((await api('/api/local/games', { headers: { 'x-forwarded-for': '203.0.113.7' } })).status).toBe(403);
    // …and so is a spoofed header when the proxy appends the real address last.
    expect((await api('/api/local/games', { headers: { 'x-forwarded-for': '127.0.0.1, 192.0.2.4' } })).status).toBe(403);
    expect((await api('/api/local/games', { headers: { 'x-forwarded-for': '127.0.0.1' } })).status).toBe(200);
    // A foreign Host header (DNS rebinding) is refused too. (fetch cannot set Host, so use node:http.)
    const { request } = await import('node:http');
    const rebound = await new Promise<number>((resolve, reject) => {
      const req = request(`${baseUrl}/api/local/games`, { headers: { host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(rebound).toBe(403);
  });

  it('kicks removed players and rejects malformed messages', async () => {
    const created = await api<{ game: { id: string; code: string }; hostToken: string }>('/api/games', { method: 'POST', body: JSON.stringify({ name: 'Kick party' }) });
    const { game, hostToken } = created.body;
    await api(`/api/games/${game.id}/actions`, { method: 'POST', token: hostToken, body: JSON.stringify({ action: 'open-lobby' }) });
    const joined = await api<{ playerId: string; sessionToken: string }>('/api/join', { method: 'POST', body: JSON.stringify({ code: game.code, displayName: 'Mallory' }) });
    const player = await connect(`role=player&code=${game.code}&token=${joined.body.sessionToken}`);
    await player.next((m) => snapshotOf(m) !== null);
    player.ws.send('not json');
    expect(await player.next((m) => m.type === 'ERROR')).toMatchObject({ message: 'Malformed message' });
    const removed = await api(`/api/games/${game.id}/actions`, { method: 'POST', token: hostToken, body: JSON.stringify({ action: 'remove-player', playerId: joined.body.playerId }) });
    expect(removed.status).toBe(200);
    await player.next((m) => m.type === 'ERROR' && m.fatal === true);
    expect(await closedWith(player)).toBe(4001);
    const resume = await api('/api/join/resume', { method: 'POST', body: JSON.stringify({ code: game.code, sessionToken: joined.body.sessionToken }) });
    expect(resume.status).toBe(401);
  });

  it('validates host media uploads and player evidence uploads', async () => {
    const created = await api<{ game: { id: string; code: string }; hostToken: string }>('/api/games', { method: 'POST', body: JSON.stringify({ name: 'Media' }) });
    const { game, hostToken } = created.body;
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
    const form = () => {
      const f = new FormData();
      f.append('file', new Blob([png], { type: 'image/png' }), 'pic.png');
      return f;
    };
    const ok = await fetch(`${baseUrl}/api/games/${game.id}/media`, { method: 'POST', headers: { authorization: `Bearer ${hostToken}` }, body: form() });
    expect(ok.status).toBe(201);
    const meta = (await ok.json()) as { id: string; ref: string; url: string };
    const served = await fetch(`${baseUrl}${meta.url}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-security-policy')).toContain('sandbox');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');

    const evil = new FormData();
    evil.append('file', new Blob([Buffer.from('<script>alert(1)</script>')], { type: 'image/png' }), 'evil.png');
    expect((await fetch(`${baseUrl}/api/games/${game.id}/media`, { method: 'POST', headers: { authorization: `Bearer ${hostToken}` }, body: evil })).status).toBe(400);

    // Evidence uploads need a valid player session and a running game.
    await api(`/api/games/${game.id}/actions`, { method: 'POST', token: hostToken, body: JSON.stringify({ action: 'open-lobby' }) });
    const joined = await api<{ sessionToken: string }>('/api/join', { method: 'POST', body: JSON.stringify({ code: game.code, displayName: 'Eve' }) });
    const headers = { 'x-game-code': game.code, 'x-session-token': joined.body.sessionToken };
    expect((await fetch(`${baseUrl}/api/evidence`, { method: 'POST', headers, body: form() })).status).toBe(409); // not running yet
    expect((await fetch(`${baseUrl}/api/evidence`, { method: 'POST', headers: { ...headers, 'x-session-token': 'nope' }, body: form() })).status).toBe(401);
    await api(`/api/games/${game.id}/challenges`, {
      method: 'POST',
      token: hostToken,
      body: JSON.stringify({ moduleId: 'closest-number', configuration: { question: 'Q', correctAnswer: 1, timeLimit: 10 } }),
    });
    await api(`/api/games/${game.id}/actions`, { method: 'POST', token: hostToken, body: JSON.stringify({ action: 'start-game' }) });
    const evidence = await fetch(`${baseUrl}/api/evidence`, { method: 'POST', headers, body: form() });
    expect(evidence.status).toBe(201);
    expect(((await evidence.json()) as { ref: string }).ref).toMatch(/^media:\/\//);

    // A selfie becomes the player's picture everywhere; the host can take it off again.
    const playerOf = async () => (await api<{ snapshot: { players: { displayName: string; icon: string; avatar: string | null }[] } }>(`/api/games/${game.id}`, { token: hostToken })).body.snapshot.players.find((p) => p.displayName === 'Eve')!;
    expect(await playerOf()).toMatchObject({ icon: expect.any(String), avatar: null });
    expect((await fetch(`${baseUrl}/api/avatar`, { method: 'POST', headers: { ...headers, 'x-session-token': 'nope' }, body: form() })).status).toBe(401);
    const notAPicture = new FormData();
    notAPicture.append('file', new Blob([Buffer.from('%PDF-1.4')], { type: 'application/pdf' }), 'doc.pdf');
    expect((await fetch(`${baseUrl}/api/avatar`, { method: 'POST', headers, body: notAPicture })).status).toBe(415);
    expect((await fetch(`${baseUrl}/api/avatar`, { method: 'POST', headers, body: evil })).status).toBe(400);
    const selfie = await fetch(`${baseUrl}/api/avatar`, { method: 'POST', headers, body: form() });
    expect(selfie.status).toBe(201);
    const { ref } = (await selfie.json()) as { ref: string };
    expect((await playerOf()).avatar).toBe(ref);
    expect((await fetch(`${baseUrl}/api/avatar`, { method: 'DELETE', headers })).status).toBe(200);
    expect((await playerOf()).avatar).toBeNull();
    await fetch(`${baseUrl}/api/avatar`, { method: 'POST', headers, body: form() });
    const eveId = (await api<{ snapshot: { players: { id: string; displayName: string }[] } }>(`/api/games/${game.id}`, { token: hostToken })).body.snapshot.players.find((p) => p.displayName === 'Eve')!.id;
    await api(`/api/games/${game.id}/actions`, { method: 'POST', token: hostToken, body: JSON.stringify({ action: 'clear-avatar', playerId: eveId }) });
    expect((await playerOf()).avatar).toBeNull();
  });
});
