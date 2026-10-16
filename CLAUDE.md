# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A modular, real-time party challenge platform. The host builds a **board** of challenges;
guests join on their phones and play any available challenge at their own pace; a main
display shows the leaderboard, board stats, live activity and results. Submissions are
evaluated automatically, by a random fellow player (peer), by the host, or hybrid.

Guiding principle: **a challenge is a plugin, not a feature of the engine.** The engine
never inspects module config, state, input or evaluation payloads.

- Spec: `challenge-platform-spec.md` (v0.3). §14 evaluation modes is implemented as written.
  §5 still describes the old host-stepped sequence; the code implements the self-paced board
  (see `docs/architecture.md` §1). Treat the architecture doc as authoritative for lifecycle.
- Module SDK guide: `docs/module-authoring.md`. API reference: `docs/api.md`.

## Commands

```bash
npm install
npm run dev          # server (tsx watch, :3000) + Vite (:5173) with proxy
npm run demo         # seed a demo game with every module (needs dev running); prints host/display/join URLs
npm test             # vitest: engine, server API/WebSocket, all module tests
npm run typecheck    # every package + challenges/
npm run build        # web client → packages/web/dist (served by `npm start`)
```

Run a subset: `npx vitest run packages/engine`, `npx vitest run challenges/caption-this`.

Before committing, `npm run typecheck` and `npm test` must both pass.

If port 5173 is taken, run Vite elsewhere and tell the server so QR/join URLs match:
`PUBLIC_PORT=5174 npm run dev:server` plus `npm exec -w @challenge/web -- vite --port 5174 --strictPort`.
(`npm run dev:web -- --port …` does not forward flags through the nested `npm run`.)

## Layout

```text
packages/contract   Module contract v2 (module.ts), declarative UI nodes + builders (ui.ts), wire protocol (protocol.ts)
packages/engine     GameRuntime (runtime.ts): board, attempts, evaluation pipeline, ledger, timers, snapshots
                    registry.ts (manifest validation + discovery), leaderboard.ts, statistics.ts, validation.ts
packages/server     Fastify REST + WebSocket (app.ts), SQLite repository (sqlite.ts), media service (media.ts)
packages/web        React client: /host, /display/:code, /join/:code, /results/:id
challenges/<id>/    One module per folder: manifest.json, config.schema.json, server/index.ts, test/
scripts/demo.ts     Demo seeder
```

TypeScript runs directly via `tsx` (no build step for backend packages). Imports use explicit
`.ts` extensions; JSON imports use `with { type: 'json' }`. Node ≥ 22.13 (built-in `node:sqlite`).

## Core model (read before changing the engine)

- **Instance phases:** `PENDING` (not available) → `ACTIVE` (players may start) → `LOCKED`
  (host closed it) → [`EVALUATING`, host resolution for onClose modules] → `RESULTS`.
- **Availability:** `open` (opens at game start), `host-unlocked` (hidden until the host unlocks),
  `assigned` (only listed players see it).
- **Attempts:** one per player per instance. Start → input → locked (submit with
  `resubmission: none`, `lock` timer, Finish, or instance closed) → evaluated → scored.
- **Results timing** (`manifest.results`): `immediate` evaluates each submission alone;
  `onClose` evaluates all submissions when the host closes the challenge (must be automatic).
- **Evaluation pipeline (§14)** lives entirely in the engine: judge picking (never self, avoid
  reciprocal pairs, fewest pending), hidden assignments, deadlines → reassign → escalate to
  host queue, hybrid rejection escalation, host decide/override, game-level preference
  (`effectiveMode`). Modules only read `submission.judgements` (use the last one).
- **Every mutation ends in `commit()`**, which emits events with a fresh `seq`, pushes an
  audience-scoped `GAME_STATE_SNAPSHOT` to each connected client, then persists. Clients
  replace state with each snapshot.
- **Ledger is append-only.** Resets and overrides append reversal rows; never delete rows.

## Rules

**Engine must stay generic.** Never add module-specific logic to `packages/engine`. If a module
needs something, add a generic capability to the contract (and update `docs/module-authoring.md`).
The acceptance test (`packages/engine/test/acceptance.test.ts`) drives every discovered module
through a full game; adding a module means adding its scenario there.

**Modules:**
- Import only from `@challenge/contract` and their own JSON. No I/O, no other modules.
- Deterministic: `ctx.rng()` / `ctx.now()`, never `Math.random()` / `Date.now()`.
- State and Evaluation are plain JSON; return new objects.
- Per-player data keyed by `player.id`; schedule time limits in `onAttemptStart` with
  `ctx.schedule('lock', seconds, player.id)`.
- `guestView` shows only that player's data; `mainView`/`presentSubmission` never leak answers
  or the submitter's name to judges.
- Non-automatic modes require `evaluation.criteria` in the manifest. Never implement judging,
  queues or deadlines in a module.
- Bump `version` when behaviour changes; games pin `id@version`.

**Security invariants** (covered by tests; keep them passing): host routes require the bearer
host token; assignments are visible only to the judge and host; `judge()` accepts only the
assigned judge while pending and before the deadline; UI text is rendered as React text
(no `dangerouslySetInnerHTML`); media is type/magic-byte checked and served with a sandbox CSP.

**Persistence:** `sqlite.ts` stores the game document in normalized tables. When you change
`PersistedGame` or any table, bump `SCHEMA_VERSION` and add a step in
`SqliteRepository.migrate()`. `CREATE TABLE IF NOT EXISTS` does not add columns to existing
databases. Update the round-trip test in `packages/server/test/sqlite.test.ts`.

**Protocol changes** touch three places: `packages/contract/src/protocol.ts`, the engine
snapshot builders in `runtime.ts`, and the web client. Run `npm run typecheck` to find all users.

## Testing notes

- Engine tests use a fake clock/timer (`packages/engine/test/helpers.ts`) and an injectable
  `random` for deterministic judge selection.
- Server tests start a real Fastify instance on port 0 with a temp SQLite file and talk to it
  over HTTP and WebSocket. Wait for socket closes by polling (`closedWith`), not fixed sleeps.
- Module tests call module functions directly with a small fake `InstanceContext`.

## Known gaps

`hostScoring` ranges are static per module; no image re-encoding/responsive sizes (FR-58/59);
no reaction-time latency compensation; strings are English only (NFR-9); modules run
in-process (SR-10 isolation later). See `docs/architecture.md` §6.
