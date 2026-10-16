import { describe, expect, it } from 'vitest';
import { GameRuntime, type PersistedGame } from '@challenge/engine';
import { SqliteRepository } from '../src/sqlite.ts';

function sampleGame(): PersistedGame {
  const doc = GameRuntime.createDocument({ name: 'Round trip', code: 'ABCDEF', hostToken: 'tok', settings: { tieBreak: 'wins' }, now: 1_000 });
  doc.status = 'IN_PROGRESS';
  doc.paused = true;
  doc.seq = 42;
  doc.players.push({ id: 'p1', gameId: doc.id, displayName: 'Ada', sessionTokenHash: 'hash', joinedAt: 2_000, removedAt: null, reclaimable: false });
  doc.instances.push({
    id: 'c1',
    gameId: doc.id,
    moduleId: 'closest-number',
    moduleVersion: '2.0.0',
    sortOrder: 0,
    configuration: { question: 'Q', correctAnswer: 1, timeLimit: 30 },
    moduleState: { nested: { array: [1, 2, 3], flag: true } },
    phase: 'ACTIVE',
    availability: 'assigned',
    assignedPlayerIds: ['p1'],
    evaluationMode: 'hybrid',
    seed: 12345,
    createdAt: 2_500,
    openedAt: 3_000,
    closedAt: null,
    timers: [{ tag: 'lock', playerId: 'p1', startedAt: 3_500, endsAt: 33_500, remainingMs: 1_000 }],
    evaluation: { rows: [] },
    results: { scores: [{ playerId: 'p1', points: 7.5, reason: 'r' }], statistics: { x: 1 } },
    error: null,
  });
  doc.attempts.push({ id: 't1', challengeInstanceId: 'c1', playerId: 'p1', startedAt: 3_500, lockedAt: 3_900, status: 'scored' });
  doc.submissions.push({ id: 's1', challengeInstanceId: 'c1', playerId: 'p1', payload: { answer: 5 }, submittedAt: 3_600, supersededBy: null, evaluation: { ok: true }, scoredAt: 3_950 });
  doc.assignments.push({
    id: 'e1',
    challengeInstanceId: 'c1',
    submissionId: 's1',
    judgePlayerId: null,
    status: 'approved',
    reason: 'host-mode',
    assignedAt: 3_700,
    deadlineAt: null,
    decidedAt: 3_900,
    decidedBy: 'host',
    decision: 'approve',
    points: 7.5,
    note: 'nice',
    reassignments: 1,
  });
  doc.ledger.push({ id: 'a1', gameId: doc.id, challengeInstanceId: 'c1', playerId: 'p1', points: 7.5, source: 'module', reason: 'r [submission:s1]', createdAt: 4_100 });
  doc.ledger.push({ id: 'a2', gameId: doc.id, challengeInstanceId: null, playerId: 'p1', points: -2, source: 'manual', reason: 'penalty', createdAt: 4_200 });
  doc.activity.push({ id: 'act1', at: 4_000, kind: 'scored', text: 'Ada scored 7.5 pts', playerId: 'p1', instanceId: 'c1', points: 7.5 });
  return doc;
}

describe('SqliteRepository', () => {
  it('round-trips a full game document', () => {
    const repo = new SqliteRepository(':memory:');
    const doc = sampleGame();
    repo.saveGame(doc);
    doc.name = 'Round trip 2';
    doc.submissions.push({ id: 's2', challengeInstanceId: 'c1', playerId: 'p1', payload: { answer: 6 }, submittedAt: 3_700, supersededBy: null, evaluation: null, scoredAt: null });
    doc.submissions[0]!.supersededBy = 's2';
    repo.saveGame(doc);

    const loaded = repo.loadGames();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(doc);

    repo.deleteGame(doc.id);
    expect(repo.loadGames()).toEqual([]);
    repo.close();
  });

  it('stores and retrieves media records', () => {
    const repo = new SqliteRepository(':memory:');
    const record = { id: 'm1', gameId: null, owner: 'game', mimeType: 'image/png', storageRef: 'm1.png', size: 10, checksum: 'abc', originalName: 'pic.png', createdAt: 5 };
    repo.insertMedia(record);
    expect(repo.getMedia('m1')).toEqual(record);
    expect(repo.getMedia('nope')).toBeNull();
    repo.close();
  });
});

describe('SqliteRepository migration', () => {
  it('backs up and rebuilds a legacy (schema v1) database', async () => {
    const { mkdtempSync, readdirSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { DatabaseSync } = await import('node:sqlite');
    const dir = mkdtempSync(join(tmpdir(), 'challenge-migrate-'));
    const path = join(dir, 'platform.sqlite');
    // A v1-era database: games table without the `activity` column and no user_version.
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE games (id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL, host_token_hash TEXT NOT NULL, status TEXT NOT NULL,
      settings TEXT NOT NULL, branding TEXT NOT NULL, created_at INTEGER NOT NULL, current_index INTEGER, paused INTEGER, seq INTEGER);
      INSERT INTO games VALUES ('g_old', 'Old', 'ABCDEF', 'h', 'IN_PROGRESS', '{}', '{}', 1, 0, 0, 3);`);
    legacy.close();

    const repo = new SqliteRepository(path);
    expect(repo.loadGames()).toEqual([]); // legacy games are not carried over
    repo.saveGame(sampleGame()); // the new schema works
    expect(repo.loadGames()).toHaveLength(1);
    repo.close();
    expect(readdirSync(dir).some((f) => f.startsWith('platform.sqlite.v1-backup-'))).toBe(true);

    // Re-opening an up-to-date database is a no-op.
    const again = new SqliteRepository(path);
    expect(again.loadGames()).toHaveLength(1);
    again.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
