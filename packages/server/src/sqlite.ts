/**
 * SQLite persistence (spec §12) using Node's built-in `node:sqlite` — no native build step.
 *
 * The engine hands over the whole game document after each mutation; we store it in
 * normalized tables inside one transaction so the data stays queryable (results pages,
 * exports, analytics) while the engine keeps a simple write-through model.
 */
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  PersistedAssignment,
  PersistedAttempt,
  PersistedGame,
  PersistedInstance,
  PersistedPlayer,
  PersistedSubmission,
  Repository,
} from '@challenge/engine';
import type { ActivityItem, ScoreLedgerEntry } from '@challenge/contract';

/** Bump when the tables change; add a migration step in SqliteRepository.migrate(). */
const SCHEMA_VERSION = 5;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  host_token_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  settings TEXT NOT NULL,
  branding TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  paused INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL DEFAULT 0,
  activity TEXT NOT NULL DEFAULT '[]',
  results_revealed INTEGER NOT NULL DEFAULT 0,
  standings TEXT,
  standings_feed TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS games_code ON games(code);

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  session_token_hash TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  removed_at INTEGER,
  reclaimable INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS players_game ON players(game_id);

CREATE TABLE IF NOT EXISTS challenge_instances (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL,
  module_version TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  allow_replay INTEGER NOT NULL DEFAULT 0,
  configuration TEXT NOT NULL,
  module_state TEXT,
  phase TEXT NOT NULL,
  availability TEXT NOT NULL,
  assigned_player_ids TEXT NOT NULL,
  evaluation_mode TEXT,
  seed INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  opened_at INTEGER,
  closed_at INTEGER,
  timers TEXT NOT NULL,
  evaluation TEXT,
  results TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS instances_game ON challenge_instances(game_id);

CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  challenge_instance_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  locked_at INTEGER,
  status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attempts_game ON attempts(game_id);

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  challenge_instance_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  attempt_id TEXT,
  payload TEXT NOT NULL,
  submitted_at INTEGER NOT NULL,
  superseded_by TEXT,
  evaluation TEXT,
  scored_at INTEGER
);
CREATE INDEX IF NOT EXISTS submissions_game ON submissions(game_id);

CREATE TABLE IF NOT EXISTS evaluation_assignments (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  challenge_instance_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  judge_player_id TEXT,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  assigned_at INTEGER NOT NULL,
  deadline_at INTEGER,
  decided_at INTEGER,
  decided_by TEXT,
  decision TEXT,
  points REAL,
  note TEXT,
  reassignments INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS assignments_game ON evaluation_assignments(game_id);

CREATE TABLE IF NOT EXISTS score_awards (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  challenge_instance_id TEXT,
  player_id TEXT NOT NULL,
  points REAL NOT NULL,
  source TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS awards_game ON score_awards(game_id);

CREATE TABLE IF NOT EXISTS media_assets (
  id TEXT PRIMARY KEY,
  game_id TEXT,
  owner TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  storage_ref TEXT NOT NULL,
  size INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  original_name TEXT,
  created_at INTEGER NOT NULL
);
`;

/** v2 → v3: challenge titles, replays, the results reveal and submission → attempt links. */
const MIGRATE_TO_V3 = `
  ALTER TABLE games ADD COLUMN results_revealed INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE challenge_instances ADD COLUMN title TEXT NOT NULL DEFAULT '';
  ALTER TABLE challenge_instances ADD COLUMN allow_replay INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE submissions ADD COLUMN attempt_id TEXT;
  UPDATE submissions SET attempt_id = (
    SELECT a.id FROM attempts a
    WHERE a.game_id = submissions.game_id AND a.challenge_instance_id = submissions.challenge_instance_id AND a.player_id = submissions.player_id
    ORDER BY a.started_at DESC LIMIT 1
  );
`;

/** v3 → v4: standings published to the big screen and their change feed. */
const MIGRATE_TO_V4 = `
  ALTER TABLE games ADD COLUMN standings TEXT;
  ALTER TABLE games ADD COLUMN standings_feed TEXT NOT NULL DEFAULT '[]';
`;

/** v4 → v5: challenge categories (players' boards group by them). */
const MIGRATE_TO_V5 = `
  ALTER TABLE challenge_instances ADD COLUMN category TEXT NOT NULL DEFAULT '';
`;

type Row = Record<string, unknown>;

const json = (v: unknown): string => JSON.stringify(v ?? null);
const parse = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export interface MediaRecord {
  id: string;
  gameId: string | null;
  owner: string;
  mimeType: string;
  storageRef: string;
  size: number;
  checksum: string;
  originalName: string | null;
  createdAt: number;
}

export class SqliteRepository implements Repository {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate(path);
  }

  /**
   * Schema versioning via SQLite's user_version. Version 1 was the sequential game model
   * (contract v1); its games cannot run on the board engine (different tables, module
   * versions no longer installed), so a legacy database is backed up and rebuilt.
   * Versions 2 to 4 are upgraded in place (MIGRATE_TO_V3 … MIGRATE_TO_V5).
   */
  private migrate(path: string): void {
    const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (version === SCHEMA_VERSION) return;
    const hasTables = (this.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'games'").get() as { n: number }).n > 0;
    if (version >= 2 && version < SCHEMA_VERSION && hasTables) {
      // Upgrade in place, one step at a time, inside one transaction.
      this.backup(path, `v${version}`);
      this.db.exec('BEGIN');
      try {
        if (version <= 2) this.db.exec(MIGRATE_TO_V3);
        if (version <= 3) this.db.exec(MIGRATE_TO_V4);
        this.db.exec(MIGRATE_TO_V5);
        this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
      return;
    }
    if (version === 0 && hasTables) {
      this.backup(path, 'v1');
      if (path !== ':memory:') {
        console.warn(`[sqlite] legacy database detected and rebuilt for schema v${SCHEMA_VERSION}. Old games were not migrated.`);
      }
      const tables = (this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name);
      this.db.exec('PRAGMA foreign_keys = OFF');
      for (const t of tables) this.db.exec(`DROP TABLE IF EXISTS "${t}"`);
      this.db.exec('PRAGMA foreign_keys = ON');
    }
    this.db.exec(SCHEMA);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /** Copy the database file aside before a migration touches it. */
  private backup(path: string, label: string): void {
    if (path === ':memory:') return;
    const target = `${path}.${label}-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    copyFileSync(path, target);
    console.warn(`[sqlite] migrating to schema v${SCHEMA_VERSION}; previous database backed up to ${target}`);
  }

  saveGame(game: PersistedGame): void {
    const db = this.db;
    db.exec('BEGIN');
    try {
      db.prepare(
        `INSERT INTO games (id, name, code, host_token_hash, status, settings, branding, created_at, started_at, finished_at, paused, seq, activity, results_revealed,
           standings, standings_feed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, code=excluded.code, host_token_hash=excluded.host_token_hash, status=excluded.status,
           settings=excluded.settings, branding=excluded.branding, started_at=excluded.started_at, finished_at=excluded.finished_at,
           paused=excluded.paused, seq=excluded.seq, activity=excluded.activity, results_revealed=excluded.results_revealed,
           standings=excluded.standings, standings_feed=excluded.standings_feed`,
      ).run(
        game.id,
        game.name,
        game.code,
        game.hostTokenHash,
        game.status,
        json(game.settings),
        json(game.branding),
        game.createdAt,
        game.startedAt,
        game.finishedAt,
        game.paused ? 1 : 0,
        game.seq,
        json(game.activity ?? []),
        game.resultsRevealed ? 1 : 0,
        json(game.standings ?? null),
        json(game.standingsFeed ?? []),
      );

      // Children: replace wholesale (documents are small; correctness over cleverness).
      for (const table of ['players', 'challenge_instances', 'attempts', 'submissions', 'evaluation_assignments', 'score_awards']) {
        db.prepare(`DELETE FROM ${table} WHERE game_id = ?`).run(game.id);
      }
      const insPlayer = db.prepare(
        `INSERT INTO players (id, game_id, display_name, session_token_hash, joined_at, removed_at, reclaimable) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const p of game.players) {
        insPlayer.run(p.id, game.id, p.displayName, p.sessionTokenHash, p.joinedAt, p.removedAt, p.reclaimable ? 1 : 0);
      }
      const insInst = db.prepare(
        `INSERT INTO challenge_instances (id, game_id, module_id, module_version, sort_order, title, category, allow_replay, configuration, module_state, phase, availability,
           assigned_player_ids, evaluation_mode, seed, created_at, opened_at, closed_at, timers, evaluation, results, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const i of game.instances) {
        insInst.run(
          i.id,
          game.id,
          i.moduleId,
          i.moduleVersion,
          i.sortOrder,
          i.title ?? '',
          i.category ?? '',
          i.allowReplay ? 1 : 0,
          json(i.configuration),
          json(i.moduleState),
          i.phase,
          i.availability,
          json(i.assignedPlayerIds),
          i.evaluationMode,
          i.seed,
          i.createdAt,
          i.openedAt,
          i.closedAt,
          json(i.timers),
          json(i.evaluation),
          json(i.results),
          i.error,
        );
      }
      const insAttempt = db.prepare(
        `INSERT INTO attempts (id, game_id, challenge_instance_id, player_id, started_at, locked_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const a of game.attempts) insAttempt.run(a.id, game.id, a.challengeInstanceId, a.playerId, a.startedAt, a.lockedAt, a.status);
      const insSub = db.prepare(
        `INSERT INTO submissions (id, game_id, challenge_instance_id, player_id, attempt_id, payload, submitted_at, superseded_by, evaluation, scored_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const s of game.submissions) {
        insSub.run(s.id, game.id, s.challengeInstanceId, s.playerId, s.attemptId, json(s.payload), s.submittedAt, s.supersededBy, json(s.evaluation), s.scoredAt);
      }
      const insAssign = db.prepare(
        `INSERT INTO evaluation_assignments (id, game_id, challenge_instance_id, submission_id, judge_player_id, status, reason, assigned_at, deadline_at,
           decided_at, decided_by, decision, points, note, reassignments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const a of game.assignments) {
        insAssign.run(
          a.id,
          game.id,
          a.challengeInstanceId,
          a.submissionId,
          a.judgePlayerId,
          a.status,
          a.reason,
          a.assignedAt,
          a.deadlineAt,
          a.decidedAt,
          a.decidedBy,
          a.decision,
          a.points,
          a.note,
          a.reassignments,
        );
      }
      const insAward = db.prepare(
        `INSERT INTO score_awards (id, game_id, challenge_instance_id, player_id, points, source, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const a of game.ledger) {
        insAward.run(a.id, game.id, a.challengeInstanceId, a.playerId, a.points, a.source, a.reason, a.createdAt);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  loadGames(): PersistedGame[] {
    const games = this.db.prepare('SELECT * FROM games').all() as Row[];
    return games.map((g) => this.loadGame(g));
  }

  private loadGame(g: Row): PersistedGame {
    const id = String(g.id);
    const players = (this.db.prepare('SELECT * FROM players WHERE game_id = ? ORDER BY joined_at').all(id) as Row[]).map(
      (p): PersistedPlayer => ({
        id: String(p.id),
        gameId: id,
        displayName: String(p.display_name),
        sessionTokenHash: String(p.session_token_hash),
        joinedAt: Number(p.joined_at),
        removedAt: num(p.removed_at),
        reclaimable: Boolean(p.reclaimable),
      }),
    );
    const instances = (this.db.prepare('SELECT * FROM challenge_instances WHERE game_id = ? ORDER BY sort_order').all(id) as Row[]).map(
      (i): PersistedInstance => ({
        id: String(i.id),
        gameId: id,
        moduleId: String(i.module_id),
        moduleVersion: String(i.module_version),
        sortOrder: Number(i.sort_order),
        title: String(i.title ?? ''),
        category: String(i.category ?? ''),
        allowReplay: Boolean(i.allow_replay),
        configuration: parse(i.configuration, {}),
        moduleState: parse(i.module_state, null),
        phase: i.phase as PersistedInstance['phase'],
        availability: i.availability as PersistedInstance['availability'],
        assignedPlayerIds: parse(i.assigned_player_ids, []),
        evaluationMode: str(i.evaluation_mode) as PersistedInstance['evaluationMode'],
        seed: Number(i.seed),
        createdAt: Number(i.created_at),
        openedAt: num(i.opened_at),
        closedAt: num(i.closed_at),
        timers: parse(i.timers, []),
        evaluation: parse(i.evaluation, null),
        results: parse(i.results, null),
        error: str(i.error),
      }),
    );
    const attempts = (this.db.prepare('SELECT * FROM attempts WHERE game_id = ? ORDER BY started_at').all(id) as Row[]).map(
      (a): PersistedAttempt => ({
        id: String(a.id),
        challengeInstanceId: String(a.challenge_instance_id),
        playerId: String(a.player_id),
        startedAt: Number(a.started_at),
        lockedAt: num(a.locked_at),
        status: a.status as PersistedAttempt['status'],
      }),
    );
    const submissions = (this.db.prepare('SELECT * FROM submissions WHERE game_id = ? ORDER BY submitted_at').all(id) as Row[]).map(
      (s): PersistedSubmission => ({
        id: String(s.id),
        challengeInstanceId: String(s.challenge_instance_id),
        playerId: String(s.player_id),
        attemptId: str(s.attempt_id) ?? '',
        payload: parse(s.payload, null),
        submittedAt: Number(s.submitted_at),
        supersededBy: str(s.superseded_by),
        evaluation: parse(s.evaluation, null),
        scoredAt: num(s.scored_at),
      }),
    );
    const assignments = (this.db.prepare('SELECT * FROM evaluation_assignments WHERE game_id = ? ORDER BY assigned_at').all(id) as Row[]).map(
      (a): PersistedAssignment => ({
        id: String(a.id),
        challengeInstanceId: String(a.challenge_instance_id),
        submissionId: String(a.submission_id),
        judgePlayerId: str(a.judge_player_id),
        status: a.status as PersistedAssignment['status'],
        reason: String(a.reason),
        assignedAt: Number(a.assigned_at),
        deadlineAt: num(a.deadline_at),
        decidedAt: num(a.decided_at),
        decidedBy: str(a.decided_by) as PersistedAssignment['decidedBy'],
        decision: str(a.decision) as PersistedAssignment['decision'],
        points: num(a.points),
        note: str(a.note),
        reassignments: Number(a.reassignments ?? 0),
      }),
    );
    const ledger = (this.db.prepare('SELECT * FROM score_awards WHERE game_id = ? ORDER BY created_at').all(id) as Row[]).map(
      (a): ScoreLedgerEntry => ({
        id: String(a.id),
        gameId: id,
        challengeInstanceId: str(a.challenge_instance_id),
        playerId: String(a.player_id),
        points: Number(a.points),
        source: a.source as ScoreLedgerEntry['source'],
        reason: str(a.reason),
        createdAt: Number(a.created_at),
      }),
    );
    return {
      id,
      name: String(g.name),
      code: String(g.code),
      hostTokenHash: String(g.host_token_hash),
      status: g.status as PersistedGame['status'],
      settings: parse(g.settings, {} as PersistedGame['settings']),
      branding: parse(g.branding, {}),
      createdAt: Number(g.created_at),
      startedAt: num(g.started_at),
      finishedAt: num(g.finished_at),
      paused: Boolean(g.paused),
      resultsRevealed: Boolean(g.results_revealed),
      standings: parse(g.standings, null),
      standingsFeed: parse(g.standings_feed, []),
      seq: Number(g.seq),
      players,
      instances,
      attempts,
      submissions,
      assignments,
      ledger,
      activity: parse<ActivityItem[]>(g.activity, []),
    };
  }

  deleteGame(id: string): void {
    this.db.prepare('DELETE FROM games WHERE id = ?').run(id);
  }

  // --- media index ------------------------------------------------------------

  insertMedia(m: MediaRecord): void {
    this.db
      .prepare(
        `INSERT INTO media_assets (id, game_id, owner, mime_type, storage_ref, size, checksum, original_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(m.id, m.gameId, m.owner, m.mimeType, m.storageRef, m.size, m.checksum, m.originalName, m.createdAt);
  }

  getMedia(id: string): MediaRecord | null {
    const r = this.db.prepare('SELECT * FROM media_assets WHERE id = ?').get(id) as Row | undefined;
    if (!r) return null;
    return {
      id: String(r.id),
      gameId: str(r.game_id),
      owner: String(r.owner),
      mimeType: String(r.mime_type),
      storageRef: String(r.storage_ref),
      size: Number(r.size),
      checksum: String(r.checksum),
      originalName: str(r.original_name),
      createdAt: Number(r.created_at),
    };
  }

  close(): void {
    this.db.close();
  }
}
