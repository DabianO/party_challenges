# Modular Challenge Platform

A configurable, real-time, multiplayer challenge-game system. A **host** assembles a
**board** of challenges from a library of **challenge modules**; **guests** join from their
phones with a code or QR and play any available challenge whenever they like, at their own
pace; a shared **main display** shows the leaderboard, the board, live activity and results.
Submissions are evaluated automatically, by a randomly assigned fellow player, by the host,
or a hybrid of both (spec §14). The server is authoritative for all state, scores and timing.

> **A challenge is a plugin, not a feature of the game engine.**
> The engine knows how to *run* challenges. It never knows what a specific challenge *does*.

Specification: [`challenge-platform-spec.md`](challenge-platform-spec.md) ·
Architecture & requirement traceability: [`docs/architecture.md`](docs/architecture.md) ·
Writing a module: [`docs/module-authoring.md`](docs/module-authoring.md)

## Quick start

Requirements: Node.js ≥ 22.13 (uses the built-in `node:sqlite`; no native builds).

```bash
npm install
npm run dev
```

- Web client (host, display, guests): http://localhost:5173
- Game server (REST + WebSocket): http://localhost:3000

If port 5173 is busy on your machine, start Vite on another port and tell the server so
QR codes point to the right place, e.g. `PUBLIC_PORT=5174 npm run dev:server` together with
`npm exec -w @challenge/web -- vite --port 5174 --strictPort`.

Open http://localhost:5173/host, create a game, add challenges from the library (open to
everyone, unlocked by you later, or assigned to specific players), open the lobby, start the
game, and put `/display/<CODE>` on the TV. Guests scan the QR code (the join URL uses your
LAN address so phones on the same Wi-Fi can reach it) or go to `/join/<CODE>`, then pick
challenges from their board. Peer-judged challenges send judging tasks to other guests'
phones; host-judged ones appear in your Run tab.

To try everything quickly, seed a demo game containing all ten modules while `npm run dev`
is running. It prints the host, display and join URLs:

```bash
npm run demo
```

Production-style run (serves the built web client from the game server on one port):

```bash
npm run build
npm start
```

### Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Game server bind address |
| `PUBLIC_URL` | `http://<lan-ip>:<port>` | Base URL encoded in join links / QR codes |
| `DATA_DIR` | `./data` | SQLite database + uploaded media |
| `CHALLENGES_DIR` | `./challenges` | Module discovery directory |
| `MEDIA_MAX_BYTES` | `10485760` | Upload size limit |
| `MEDIA_BASE_URL` | *(same origin)* | Serve media from a separate origin (SR-8 hardening) |
| `HOST_CREATE_PASSWORD` | *(unset)* | Require a shared password to create games |
| `LOG` | *(unset)* | `1` enables request logging |

## Repository layout

```text
packages/contract   @challenge/contract  Module contract (SDK types + ui helpers) and wire protocol
packages/engine     @challenge/engine    Core engine: games, players, lifecycle, submissions,
                                         score ledger, leaderboard, timers, module registry/loader
packages/server     @challenge/server    Fastify REST + WebSocket API, SQLite persistence, media service
packages/web        @challenge/web       React client: host interface, main display, guest interface
challenges/<id>/                         Challenge modules (manifest, config schema, server logic, tests)
docs/                                    Architecture and module-authoring documentation
```

## Challenge modules (initial library)

| Module | Category | Results | Evaluation | Exercises |
|---|---|---|---|---|
| `multiple-choice` | knowledge | immediate | automatic | schema config, fixed scoring + speed bonus |
| `numeric-answer` | knowledge | immediate | automatic | exact-match evaluation with tolerance |
| `closest-number` | knowledge | on close | automatic | aggregate ranked scoring (reference module) |
| `timed-reaction` | skill | immediate | automatic | server-side per-player timing (SR-5) |
| `image-memory` | memory | immediate | automatic | media, per-player reveal/hide phases |
| `majority-vote` | social | on close | automatic | no correct answer, social scoring |
| `caption-this` | social | immediate | peer (host, hybrid) | peer approval with text evidence (reference module) |
| `photo-hunt` | chaos | immediate | peer (host, hybrid) | evidence upload from the phone camera |
| `open-performance` | chaos | immediate | host (hybrid, peer) | host queue with points |
| `prediction` | social | on close | automatic + host resolution | outcome resolved later by the host |

All ten run on the same engine without engine changes (spec §21.3). Add your own by
creating a folder under `challenges/` — see the authoring guide.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Server (tsx watch) + Vite dev server with proxy |
| `npm test` | Vitest: engine lifecycle, server API/WebSocket, module tests |
| `npm run typecheck` | Type-check every package and all modules |
| `npm run build` | Build the web client into `packages/web/dist` |
| `npm start` | Run the game server (serves `packages/web/dist` if present) |

## Key design decisions

- **Declarative module UI.** Modules return view-model trees (`ui.*` nodes) that the platform
  renders with themed, accessible components. Modules ship zero frontend code, which gives
  consistent branding (FR-61), XSS safety (SR-9) and keeps modules sandbox-friendly.
- **In-process trusted modules (v1).** Modules are first-party and loaded in-process from the
  `challenges/` directory at startup; the contract keeps them free of I/O so isolation can be
  added later (SR-10) without changing modules.
- **Generic evaluation pipeline.** Judge assignment, deadlines, reassignment, escalation,
  the host queue and overrides live in the engine (§14); modules only declare a mode,
  criteria and evidence, and map the final judgement to points.
- **Snapshot-first real-time model.** Every mutation pushes an audience-scoped
  `GAME_STATE_SNAPSHOT` (host / main / each player) so clients never depend on event history
  (FR-36, FR-38). Semantic events (`PLAYER_JOINED`, `RESULTS_AVAILABLE`, …) ride alongside for
  toasts and animations and carry a per-game sequence number (FR-37).
- **Write-through SQLite persistence.** The engine persists each game document after every
  mutation; the server restores games on boot; in-flight attempts are discarded so those players
  simply start the challenge again (FR-51).
- **Append-only score ledger.** Scores enter the ledger only from module `calculateScores`
  output or host manual adjustments; restarts append reversals rather than deleting rows (FR-40).
