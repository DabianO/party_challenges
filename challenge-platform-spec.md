# Modular Challenge Platform

## Software Specification — v0.3

| | |
|---|---|
| **Status** | Draft |
| **Version** | 0.3 |
| **Supersedes** | v0.2 |
| **Audience** | Product owner, architects, developers |

---

## 1. Introduction

### 1.1 Purpose

The Modular Challenge Platform is a configurable, real-time, multiplayer challenge-game system. A **host** creates a game by selecting and configuring a sequence of **challenge modules**. **Guests** join from their phones via a game code or QR code and participate through a web-based interface, while a shared **main display** (TV/projector) shows the game to the room.

The platform automatically collects responses, evaluates them where possible, tracks scores and statistics, and maintains a live leaderboard.

### 1.2 Guiding Principle

> **A challenge is a plugin, not a feature of the game engine.**
>
> The engine knows how to *run* challenges. It never needs to know what a specific challenge *does*.

Every architectural decision in this document should be tested against this principle. A challenge module is a self-contained unit that ships everything it needs: configuration schema, host/main-display UI, guest UI, input validation, evaluation logic, scoring, statistics, and results presentation. The core engine provides generic infrastructure only.

### 1.3 Goals

- **G-1** — A host can assemble a complete game from a library of reusable challenge modules without writing code.
- **G-2** — Guests join in seconds from any modern phone browser, with no app install and no account.
- **G-3** — New challenge modules can be added without any modification to the core engine.
- **G-4** — The platform is generic enough to be distributed later as a standalone product (birthday parties, team building, pub quizzes, classrooms).
- **G-5** — The server is authoritative for all game state, scores, and timing.

### 1.4 Non-Goals (v1)

- **NG-1** — Native mobile apps. The guest experience is web-only.
- **NG-2** — Persistent guest accounts or cross-game player profiles (future work, §20).
- **NG-3** — A public marketplace for third-party modules (future work).
- **NG-4** — Games larger than ~100 concurrent participants.
- **NG-5** — Offline play.

### 1.5 Requirement Notation

Requirements are numbered for traceability:

- `FR-x` — functional requirement
- `MR-x` — module-contract requirement
- `SR-x` — security requirement
- `NFR-x` — non-functional requirement

Keywords **must**, **should**, and **may** are used in the RFC 2119 sense.

---

## 2. Glossary

| Term | Definition |
|---|---|
| **Game** | One complete competition instance (e.g., "Dabian's 35th Birthday"), consisting of a configured sequence of challenge instances, its participants, and its results. |
| **Challenge Module** | A versioned, reusable, self-contained plugin defining one type of activity (e.g., "Closest Number"). Lives in the Challenge Library. |
| **Challenge Instance** | A specific, configured occurrence of a module inside a specific game (e.g., "Closest Number, question: golf balls, answer: 137, 30 s"). |
| **Host** | The authenticated user who creates, configures, and controls a game. |
| **Guest / Player** | A participant who joins a game with a temporary identity. No account required. |
| **Main Display** | A passive, full-screen view for a TV/projector, connected to the game as a read-mostly client. |
| **Submission** | A single guest input for a challenge instance. Its payload is opaque to the engine. |
| **Challenge Library** | The catalog of installed challenge modules available to hosts. |
| **Capability** | A platform feature a module declares it needs (timer, media, camera, manual evaluation, …). |
| **Manifest** | A module's machine-readable metadata: id, version, capabilities, configuration schema reference. |
| **Evaluation Mode** | How a challenge's results are decided: `automatic`, `peer`, `host`, or `hybrid` (§14). |
| **Judge** | A participant (peer mode) or the host (host mode) who approves/rejects a submission. |
| **Evaluation Assignment** | An engine-managed task pairing one judge with one submission, with a deadline. |

---

## 3. Actors and Interfaces

The system exposes three client interfaces backed by one game server.

```text
                  ┌──────────────────┐
                  │   Game Server    │   authoritative state,
                  │  (core engine +  │   evaluation, scoring,
                  │  loaded modules) │   persistence
                  └────────┬─────────┘
                           │  real-time channel (§9)
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                 ▼
   Host interface     Main display      Guest interface
   (host's device)    (TV/projector)    (guests' phones)
```

### 3.1 Host Interface

Used by the game host on their own device (phone, tablet, or laptop), separate from the main display.

- **FR-1** — The host **must** be able to create a game, browse the Challenge Library, add challenge instances, configure them, and order them.
- **FR-2** — The host **must** be able to control game progression: open the lobby, start the game, start/lock/end each challenge, reveal results, advance to the next challenge, and end the game.
- **FR-3** — The host **must** see live participant status per challenge: joined, submitted, waiting, disconnected.
- **FR-4** — The host **must** be able to remove a player from the game.
- **FR-5** — The host **should** be able to pause the game, replay/restart a challenge (where the module permits it), and skip a challenge.
- **FR-6** — The host **must** be able to act as evaluator when a module's evaluation mode requires it, and to override any evaluation outcome (§14).
- **FR-7** — Host actions **must** require authentication and be authorized against the specific game (see SR-6).

### 3.2 Main Display

A large-format, read-mostly view intended for a TV or projector, opened as an ordinary browser client connected to the same game.

- **FR-8** — The main display **must** render: join instructions (URL, game code, QR), the lobby with joined players, the active challenge's main UI, timers, submission progress, per-challenge results, and the leaderboard.
- **FR-9** — The main display **must not** require interaction after being connected to a game. All progression is driven by the host interface.
- **FR-10** — The main display **must** never show information that would let players cheat (e.g., correct answers before lock, other players' pending submissions where secrecy matters). What is safe to show is decided by the module (§7.4).

### 3.3 Guest Interface

Mobile-first web interface for participants.

- **FR-11** — A guest **must** be able to join by scanning a QR code or entering a short game code, choosing a display name, and landing in the lobby — target under 15 seconds end to end.
- **FR-12** — During a challenge, the guest interface **must** render the module's guest UI: challenge-specific inputs, submit action, submission confirmation, and (where the module allows) personal results.
- **FR-13** — Between challenges, the guest interface **must** show game progress and, at game end, final results and personal placement.
- **FR-14** — The guest UI for the active challenge **must** be produced by the challenge module, not by hard-coded engine screens (see §7).

---

## 4. System Architecture Overview

### 4.1 Layers

```text
┌─────────────────────────────────────────────────────┐
│                 Challenge Modules                   │
│   closest-number/  multiple-choice/  reaction/ ...  │
├─────────────────────────────────────────────────────┤
│              Module Runtime & Contract              │
│   discovery · loading · sandboxing · versioning     │
├─────────────────────────────────────────────────────┤
│                    Core Engine                      │
│  games · players · lifecycle · submissions router · │
│  scoring ledger · leaderboard · timers · media      │
├─────────────────────────────────────────────────────┤
│                  Infrastructure                     │
│  real-time transport · persistence · auth · storage │
└─────────────────────────────────────────────────────┘
```

- **FR-15** — The core engine **must not** contain challenge-specific logic. Submissions, module state, and module configuration are opaque payloads to the engine; it stores and routes them.
- **FR-16** — Modules **must** be discovered/registered at startup (or install time) from a well-known location or registry, without engine code changes (see MR-1).
- **FR-17** — All authoritative game logic executes on the server. Clients render UI and forward inputs (see SR-1).

### 4.2 Ownership of State

| Owned by core engine | Owned by challenge module |
|---|---|
| Game record, game code, lifecycle phase | Challenge-internal phase and variables |
| Player roster, identities, connection status | Question/content data |
| Challenge sequence and current index | Received answers (payload interpretation) |
| Score ledger and leaderboard | Evaluation results before scoring |
| Server clock and timers (as a service) | Which statistics are meaningful |
| Persistence and real-time transport | UI definitions for all three surfaces |

The engine persists module state as an opaque, versioned blob attached to the challenge instance. Modules never write to core tables directly; they return data through the contract (§7), and the engine persists it.

---

## 5. Game Lifecycle

### 5.1 Game State Machine

The game as a whole moves through the following states. Transitions marked `(host)` are triggered by the host; transitions marked `(engine)` happen automatically.

```text
 DRAFT ──(host: open lobby)──▶ LOBBY ──(host: start game)──▶ IN_PROGRESS
                                                                 │
                              ┌──────────────────────────────────┘
                              ▼
                     [challenge loop, §5.2]
                              │
                              ▼ (host: end game / last challenge done)
                        GAME_RESULTS ──(host: close)──▶ FINISHED
```

- **DRAFT** — Game is being configured. Not joinable.
- **LOBBY** — Game code/QR is live; guests can join. Host sees roster fill up.
- **IN_PROGRESS** — The challenge loop is running. Late joining is allowed by default but **may** be disabled per game (FR-18).
- **GAME_RESULTS** — Final leaderboard, superlatives, per-challenge stats.
- **FINISHED** — Archived. Read-only.

- **FR-18** — Late joining during `IN_PROGRESS` **must** be a game-level configuration option (default: allowed; late joiners score 0 for completed challenges).
- **FR-19** — The host **must** be able to end the game early from any state; partial results are preserved.

### 5.2 Challenge Instance State Machine

Each challenge instance runs through its own lifecycle inside the game's challenge loop:

```text
 PENDING ─▶ INTRO ─▶ ACTIVE ─▶ LOCKED ─▶ EVALUATING ─▶ RESULTS ─▶ DONE
              │        │
              │        └─ (timer expiry or host action ─▶ LOCKED)
              └─ (modules may skip INTRO)
```

| State | Meaning | Typical trigger to advance |
|---|---|---|
| `PENDING` | Queued, not yet shown | Host advances to it |
| `INTRO` | Instructions shown, input closed | Host starts, or auto after N seconds |
| `ACTIVE` | Guests can submit | Timer expiry or host lock |
| `LOCKED` | Input closed, no submissions accepted | Automatic |
| `EVALUATING` | Evaluation runs: automatic, peer approval, and/or host queue (§14) | All evaluations resolved |
| `RESULTS` | Challenge results shown; leaderboard updated | Host advances |
| `DONE` | Finished; immutable | — |

- **FR-20** — Not every module needs every state: a module declares in its manifest which optional states it uses (`INTRO`; `EVALUATING` is implied for any non-automatic evaluation mode, §14). The engine **must** skip undeclared optional states.
- **FR-21** — The transition `ACTIVE → LOCKED` **must** be enforced server-side. Submissions arriving after lock **must** be rejected regardless of client-side timers (see SR-4).
- **FR-22** — Timers **must** run on the server clock; clients receive the authoritative end timestamp and render countdowns locally.

---

## 6. Challenge Library

- **FR-23** — The host **must** be able to browse installed modules by category, with name, description, player range, expected duration, and required capabilities.
- **FR-24** — Selecting a module creates a challenge instance in the game and opens its configuration form (§7.3).
- **FR-25** — The same module **may** be added to a game multiple times with different configurations.

Illustrative library layout:

```text
CHALLENGE LIBRARY

Knowledge          Skill              Social             Memory           Chaos
├─ Multiple Choice ├─ Reaction Time   ├─ Who Said It?    ├─ Memory Tray   ├─ Balloon Survival
├─ Closest Number  ├─ Precision Throw ├─ Majority Vote   └─ What's        └─ Don't React
├─ True or False   └─ Cup Stack       └─ Who Would…?        Missing?
└─ Image Quiz
```

---

## 7. Challenge Module Contract

This section is the heart of the platform. Every module implements the same contract; the engine treats all modules identically.

### 7.1 Module Anatomy

A module is a self-contained package:

```text
/challenges/closest-number/
├── manifest.json          # metadata, capabilities, versions
├── config.schema.json     # JSON Schema for host configuration
├── server/
│   └── logic              # validate, evaluate, score, statistics
├── ui/
│   ├── main               # main-display component
│   ├── guest              # guest input component
│   └── results            # results component
└── assets/                # bundled static assets (optional)
```

- **MR-1** — A module **must** be installable by placing/registering the package; no core-engine code changes are permitted.
- **MR-2** — A module **must not** import from or depend on other modules.
- **MR-3** — A module **must not** access the database, other players' private submissions, or the network directly; it interacts with the platform exclusively through the contract API and declared capabilities.

### 7.2 Manifest

```json
{
  "id": "closest-number",
  "name": "Closest Number",
  "version": "1.2.0",
  "apiVersion": "1",
  "category": "knowledge",
  "description": "Players estimate a numerical value; closest guesses score highest.",
  "players": { "min": 1, "max": null },
  "duration": { "typicalSeconds": 45 },
  "lifecycle": { "usesIntro": true, "usesEvaluating": false },
  "capabilities": ["timer", "numeric-input", "statistics"],
  "evaluation": "automatic"   // "automatic" | "peer" | "host" | "hybrid" (§14)
}
```

- **MR-4** — `id` + `version` **must** uniquely identify a module build. Versions follow SemVer.
- **MR-5** — `apiVersion` declares which platform contract version the module targets. The engine **must** refuse to load modules targeting an unsupported contract version.
- **MR-6** — A module **must** declare every capability it uses (§7.7). The engine **may** reject configuration or degrade gracefully if a capability is unavailable in the current deployment.

### 7.3 Configuration Schema

Modules define their configuration as a JSON Schema. The host interface **must** auto-generate the configuration form from this schema (FR-26), so the platform needs no bespoke configuration screens per module.

```json
{
  "type": "object",
  "required": ["question", "correctAnswer", "timeLimit"],
  "properties": {
    "question":      { "type": "string",  "title": "Question" },
    "correctAnswer": { "type": "number",  "title": "Correct answer" },
    "unit":          { "type": "string",  "title": "Unit", "default": "" },
    "timeLimit":     { "type": "integer", "title": "Time limit (s)", "minimum": 5, "default": 30 },
    "maxPoints":     { "type": "integer", "title": "Maximum points", "default": 10 },
    "media":         { "type": "string",  "format": "media-ref", "title": "Image (optional)" }
  }
}
```

- **MR-7** — Configuration **must** be validated server-side against the schema on save (never trust the generated form alone).
- **MR-8** — Fields of format `media-ref` reference uploaded media handled by the platform media service (§15).
- **FR-26** — For the rare module whose configuration cannot be expressed in JSON Schema, the contract **may** allow a custom configuration UI component as an escape hatch; schema-driven forms are the default.

### 7.4 Contract Interface

Conceptual TypeScript definition (final API fixed during technical design):

```typescript
interface ChallengeModule<Config, State, Input, Evaluation> {
  // Identity ------------------------------------------------------------
  manifest(): Manifest;
  configurationSchema(): JsonSchema;

  // Lifecycle -----------------------------------------------------------
  /** Called when the challenge instance starts. Returns initial module state. */
  createInstance(config: Config, ctx: InstanceContext): State;

  /** Optional hooks on lifecycle transitions (e.g., on ACTIVE, on LOCKED). */
  onPhaseChange?(state: State, phase: ChallengePhase, ctx: InstanceContext): State;

  // Input ---------------------------------------------------------------
  /** Fast, synchronous shape/business validation of a single input. */
  validateInput(state: State, player: PlayerRef, input: Input): ValidationResult;

  /** Applies an accepted input to module state (e.g., mark player as submitted). */
  handleInput(state: State, player: PlayerRef, input: Input): State;

  // Evaluation ----------------------------------------------------------
  /** Runs after LOCKED. Receives all stored submissions for this instance. */
  evaluate(state: State, submissions: Submission<Input>[]): Evaluation;

  /** Maps evaluation to points per player. Engine writes these to the ledger. */
  calculateScores(state: State, evaluation: Evaluation): ScoreAward[];

  /** Module-specific statistics for the results screen and analytics. */
  getStatistics(state: State, evaluation: Evaluation): Statistics;

  // Presentation --------------------------------------------------------
  /** Returns view models; the matching UI components render them. */
  mainView(state: State): MainViewModel;          // safe for the shared screen
  guestView(state: State, player: PlayerRef): GuestViewModel;
  resultsView(state: State, evaluation: Evaluation): ResultsViewModel;
}
```

Notes on the contract:

- **MR-9** — `mainView` **must** only expose data safe to show publicly while the challenge is active (never the correct answer before `RESULTS`, never secret submissions).
- **MR-10** — `guestView` receives the specific player, so modules can render per-player state (submitted/not, personal answer) without leaking other players' data.
- **MR-11** — Module functions **must** be deterministic given (state, inputs); any randomness or timing **must** come from the `InstanceContext` (seeded RNG, server clock), so games can be replayed/audited.
- **MR-12** — `calculateScores` returns only `{ playerId, points, reason? }`. The engine owns the ledger and the leaderboard; modules never write scores directly.
- **MR-13** — Where the engine cannot host module UI natively, view models **must** be renderable by platform-provided components; modules ship UI components matched to view models (exact frontend packaging decided in technical design — options include federated components or a declarative UI schema).

### 7.5 Submission Payloads

The engine treats submission payloads as opaque JSON, routed to the owning module:

```json
{ "answer": "B" }                    // multiple choice
{ "answer": 137 }                    // numeric / closest number
{ "answer": "The Matrix" }           // free text
{ "reactionTime": 384 }              // reaction test (see SR-5: server-timed!)
{ "image": "media://sub/abc123" }    // drawing / photo (uploaded via media service)
```

- **FR-27** — The engine **must** persist every accepted submission verbatim with a server-side timestamp before evaluation.
- **FR-28** — By default one submission per player per challenge; a module **may** declare `resubmission: "replace"` to allow updating an answer while `ACTIVE`.

### 7.6 Submission Lifecycle

```text
Guest device                     Server (engine)                Module
    │  submit(payload) ─────────────▶│                             │
    │                                │ phase == ACTIVE? ───────────┤ (else reject: SR-4)
    │                                │ player in game? rate-limit? │
    │                                │──── validateInput ─────────▶│
    │                                │◀─── accept / reject ────────│
    │                                │ persist submission (FR-27)  │
    │                                │──── handleInput ───────────▶│
    │◀─ ack / rejection ─────────────│ broadcast PLAYER_SUBMITTED  │
    │                                │        …on LOCKED…          │
    │                                │──── evaluate ──────────────▶│
    │                                │──── calculateScores ───────▶│
    │                                │ write ledger, leaderboard   │
    │◀─ RESULTS_AVAILABLE ───────────│ broadcast results           │
```

### 7.7 Capabilities

Modules declare capabilities so the platform knows what they require and can gate configuration/deployment accordingly:

```text
timer            image            video            audio
text-input       numeric-input    multiple-choice  drawing
camera           microphone       real-time-burst  anonymous
evidence-upload    media-upload

Evaluation *mode* is declared separately in the manifest (§14, MR-17), not as a capability.
```

- **MR-14** — Using an undeclared capability is a contract violation; the module loader **should** enforce this where technically possible (sandboxing).

### 7.8 Versioning

- **MR-15** — A game **must** pin the exact module version (`closest-number@1.2.0`) at the time the challenge instance is created. Upgrading an installed module **must not** change existing games.
- **MR-16** — Module state persisted for a game **must** be readable by the pinned version; modules **should** provide state migrations only for their own minor/patch upgrades if they opt in.

---

## 8. Joining and Identity

### 8.1 Join Flow

```text
Scan QR (or enter code at join URL)
        ↓
Enter display name  →  (optional: pick avatar/colour)
        ↓
Join game → session token issued, stored on device
        ↓
Lobby (waiting room)
```

- **FR-29** — Guests **must not** need an account. Identity is a per-game `playerId` (UUID) bound to a device session token.
- **FR-30** — Game codes **must** be short enough to type (5–6 characters) yet unpredictable (SR-7), excluding ambiguous characters (`0/O`, `1/I/L`).
- **FR-31** — Display names **must** be unique within a game (auto-suffix on collision) and pass a basic profanity/length filter.
- **FR-32** — The main display in `LOBBY` **must** show the join URL, game code, QR code, and joined players in real time.

### 8.2 Reconnection

- **FR-33** — A returning device (same session token) **must** be reattached to its existing player, with all prior submissions and scores intact.
- **FR-34** — The host **must** be able to see connection status per player (`connected / disconnected`) and manually free up a name/slot if a device is lost.

---

## 9. Real-Time Communication

### 9.1 Transport

- **FR-35** — All clients (host, main display, guests) **must** receive game state changes over a persistent real-time channel (WebSocket or equivalent), with automatic reconnection and state resynchronization on reconnect.
- **FR-36** — On (re)connect, the server **must** send a full snapshot of relevant current state before streaming incremental events, so clients never depend on having seen past events.

### 9.2 Event Envelope

All events share an envelope; module-specific payloads are opaque to the engine:

```json
{
  "gameId": "g_8f2…",
  "seq": 412,
  "at": "2026-09-05T19:32:11.482Z",
  "type": "PLAYER_SUBMITTED",
  "audience": "all | host | main | player:<id>",
  "payload": { }
}
```

Core event types:

```text
GAME_STATE_SNAPSHOT     PLAYER_JOINED          CHALLENGE_STARTED
GAME_STARTED            PLAYER_DISCONNECTED    CHALLENGE_PHASE_CHANGED
GAME_FINISHED           PLAYER_RECONNECTED     CHALLENGE_LOCKED
LEADERBOARD_UPDATED     PLAYER_REMOVED         RESULTS_AVAILABLE
EVALUATION_ASSIGNED     PLAYER_SUBMITTED       MODULE_EVENT (opaque)
EVALUATION_DECIDED      EVALUATION_ESCALATED
```

- **FR-37** — Events **must** carry a per-game sequence number so clients can detect gaps and request resync.
- **FR-38** — Events **must** be audience-scoped: a guest never receives another player's private data; the main display never receives spoilers (MR-9 applies to event payloads too).
- **FR-39** — Modules **may** emit `MODULE_EVENT`s through the context API for live interactions (e.g., "3…2…1…GO"); the engine routes them by audience without inspecting payloads.

---

## 10. Scoring and Leaderboard

- **FR-40** — The engine **must** maintain an append-only score ledger: one row per (game, challenge instance, player) award, written only from module `calculateScores` output or host manual evaluation.
- **FR-41** — The live leaderboard **must** show rank, total points, and per-challenge deltas, and update immediately when a challenge reaches `RESULTS`.
- **FR-42** — Tie-breaking **must** be configurable at game level (e.g., most challenge wins → earliest average submission → shared rank; default: shared rank).
- **FR-43** — The host **may** apply a manual score adjustment (bonus/penalty) with a reason; adjustments appear in the ledger like any other award.

Scoring *strategies* live in modules — fixed, ranked, distance-based, time-based, or fully custom. The engine only ever sees `{ playerId, points }`.

---

## 11. Statistics

- **FR-44** — Modules **must** be able to return arbitrary structured statistics from `getStatistics`; the results UI shipped by the module decides how to present them.
- **FR-45** — The engine **must** additionally compute generic statistics per challenge without module involvement: participation rate, submission times, points distribution.

Examples of module statistics:

| Module | Statistics |
|---|---|
| Closest Number | correct answer, average/median guess, closest & furthest guess, distribution |
| Reaction Time | fastest, slowest, average, median, standard deviation |
| Multiple Choice | % per option, correct-answer % |
| Prediction | prediction distribution, accuracy, average prediction |

---

## 12. Persistent Data Model

Core entities (engine-owned). Module data lives only in the opaque `configuration`, `module_state`, and submission `payload` fields.

```text
Game
  id, name, game_code, host_id, status, settings(json),
  branding(json), created_at, started_at, finished_at

Player
  id, game_id, display_name, session_token_hash,
  joined_at, connection_status, removed_at?

ChallengeInstance
  id, game_id, module_id, module_version, sort_order,
  configuration(json), module_state(json), phase,
  started_at, locked_at, finished_at

Submission
  id, challenge_instance_id, player_id,
  payload(json), evidence_media_id?, submitted_at(server), superseded_by?

EvaluationAssignment
  id, challenge_instance_id, submission_id, judge_player_id,
  status(pending|approved|rejected|expired|escalated|overridden),
  assigned_at, deadline_at, decided_at?, decided_by(peer|host), note?

ScoreAward
  id, game_id, challenge_instance_id?, player_id,
  points, source(module|manual), reason?, created_at

MediaAsset
  id, owner(game|challenge_instance|submission), mime_type,
  storage_ref, size, checksum, created_at
```

- **FR-46** — `ChallengeInstance` ≠ `ChallengeModule`: instances pin `module_id@module_version` (MR-15) and carry their own configuration.
- **FR-47** — Finished games **must** remain queryable read-only (results pages, exports) until deleted by the host.

---

## 13. Failure Handling

- **FR-48** — A guest disconnect **must not** lose prior submissions or scores; the player rejoins the same identity (FR-33).
- **FR-49** — The host view **must** summarize submission status live, e.g. `✓ 22 submitted · ○ 3 waiting · × 1 disconnected`.
- **FR-50** — If the *host* disconnects, the game **must** pause safely in place (active timers keep running server-side; no state is lost) and resume when the host reconnects.
- **FR-51** — A server restart **must** be recoverable for `IN_PROGRESS` games from persisted state; at minimum, no completed challenge results may be lost, and the current challenge **may** be restarted.
- **FR-52** — A module error during evaluation **must not** crash the game: the engine surfaces the failure to the host, who can retry, skip the challenge (0 points), or score it manually.

---

## 14. Evaluation Modes

Not every challenge can be judged by the machine. Evaluation is therefore a **generic engine capability** with four modes. A module never implements judging pipelines itself — it only declares which mode it uses:

```text
Challenge
├── Player interaction
├── Submission (+ optional evidence)
├── Evaluation mode
│   ├── automatic      — engine asks the module's evaluate()
│   ├── peer           — engine runs the peer-approval pipeline
│   ├── host           — engine queues submissions for the host
│   └── hybrid         — peer approval first, host can override
├── Scoring
└── Results
```

- **MR-17** — Every module **must** declare its evaluation mode in the manifest: `"evaluation": "automatic" | "peer" | "host" | "hybrid"`. Modules using `peer`, `host`, or `hybrid` **must** additionally provide human-readable **evaluation criteria** (what a judge should check) and declare what evidence, if any, a submission carries (§14.6).
- **MR-18** — Modules **must not** implement judge assignment, approval queues, deadlines, or escalation. These belong to the engine, so Caption This, Common Ground, Dabian Trivia, and any future subjective challenge all reuse the same mechanism.

### 14.1 Automatic

The module's `evaluate()` determines the result with no human input. Examples: reaction time, multiple choice, numeric answer, cup-stack timer.

- **FR-53** — In `automatic` mode the engine **must** run the standard pipeline of §7.6 unchanged.

### 14.2 Peer Approval

Each participant's submission is judged by another randomly assigned participant, who sees the submission (plus evidence) and the module's evaluation criteria, then approves or rejects it.

```text
Submit → engine assigns random judge → judge notified on their phone
      → judge sees evidence + criteria → approve / reject
      → (timeout ⇒ reassign / escalate) → module maps decisions to results
      → calculateScores → ledger
```

- **FR-54** — The engine **must** implement peer approval as a reusable pipeline available to any module that declares it. The judging UI is a generic engine screen fed by the module's criteria and evidence — not a module UI component.
- **FR-62** — **Assignment rules.** The engine **must**: never assign a player to judge their own submission; re-randomize assignments for every challenge (never a sticky pairing across the game); and avoid reciprocal pairs (A judges B while B judges A) unless the player count makes this unavoidable (e.g., 2 players).
- **FR-63** — **Hidden assignments.** Judges **must not** be publicly revealed — neither on the main display nor to the judged player — so participants cannot coordinate approvals. Assignment events are scoped `player:<judgeId>` only (FR-38 applies).
- **FR-64** — **Approval deadline.** Each assignment carries a deadline (default 60 s, configurable per game and overridable per module). On expiry the engine **must** automatically reassign to another eligible judge; if no eligible judge remains (or after a configurable number of reassignments), the assignment **must** escalate to the host queue.
- **FR-65** — A judge's decision is `approve` or `reject`, with an optional short note. The engine records the decision and hands the set of decisions to the module (as part of the `Evaluation` input) so the module maps them to results/points however it likes (pass/fail, per-approval points, etc.).
- **FR-66** — Players **must** be able to act as judge and submitter concurrently; the guest UI queues judging tasks alongside (or after) the player's own submission flow.

### 14.3 Host Approval

The host receives a queue of submissions and approves/rejects (or scores) each one. Useful for subjective challenges or when the host wants full control.

- **FR-67** — In `host` mode the engine **must** present the host a live queue: submission, evidence, criteria, per-item approve/reject or a points input within the module's declared range, plus an optional note. Decisions flow into the ledger exactly like automatic scores.

### 14.4 Hybrid

Peer approval runs first; the host supervises and can override. This is the recommended default for subjective challenges.

- **FR-68** — In `hybrid` mode, disputed, rejected, expired, or flagged assignments **must** surface in the host queue; everything else resolves via peers without host effort.

### 14.5 Host Override (all modes)

- **FR-55** — Regardless of mode, the host **must** be able to: view all pending and completed evaluations, approve/reject anything (overruling a peer decision), and manually change any result or score before or after `RESULTS`. Overrides are written to the ledger with `source: manual` and a reason (FR-43 applies).

### 14.6 Evidence

- **FR-69** — Where a module declares it, a submission **may** include evidence — photo, video, audio, number, or text — uploaded through the media service (§15) and referenced from the submission payload. The judging UI (peer or host) **must** display the evidence next to the module's evaluation criteria.

### 14.7 Game-Level Evaluation Preference

- **FR-70** — The host **may** set a game-level evaluation preference that constrains or remaps module defaults where the module supports multiple modes:

```text
Who evaluates challenges?
 ○ Automatic where possible
 ● Random players (peer approval)
 ○ Host
 ○ Automatic + random players + host override (hybrid)
```

This balance lets a host run a whole evening without judging every submission personally, while retaining the ability to step in when something goes wrong. Modules that support only one mode (e.g., a reaction test is inherently automatic) ignore the preference; the configuration UI **must** make this visible.

---

## 15. Media

- **FR-56** — Hosts **must** be able to upload media (images, video, audio, GIFs) during challenge configuration; media is stored by the platform media service and referenced from configuration via `media-ref` (MR-8), never hard-coded into modules.
- **FR-57** — Guest-generated media (drawings, photos) **must** be uploaded through the same service and referenced from submission payloads.
- **FR-58** — Uploads **must** be validated (type allow-list, size limits, image re-encoding) before being served to other clients (see SR-8).
- **FR-59** — Media **should** be served in device-appropriate sizes so a photo challenge doesn't stall on party Wi-Fi.

---

## 16. Security Requirements

- **SR-1** — The server is authoritative for all state, scores, rankings, and timing. Clients render and forward input only.
- **SR-2** — Every submission **must** be validated server-side (game membership, phase, rate limits, then module `validateInput`).
- **SR-3** — A player **must** only be able to read their own private submission data; audience scoping (FR-38) enforces this on the event stream, authorization enforces it on any request/response API.
- **SR-4** — Submissions after `LOCKED` **must** be rejected server-side, regardless of client clocks.
- **SR-5** — For time-sensitive challenges (reaction tests), authoritative timing **must** be derived server-side or via a server-signed timing protocol; raw client-reported milliseconds **must** be treated as untrusted and at most advisory.
- **SR-6** — Host controls **must** require an authenticated host session authorized for that specific game.
- **SR-7** — Game codes **must** be generated with sufficient entropy that active games cannot be enumerated, and **must** be invalidated when the game finishes.
- **SR-8** — Uploaded media **must** be validated and served from a domain/path that cannot execute in the application origin.
- **SR-9** — Guest input rendered anywhere (names, text answers) **must** be treated as untrusted and output-encoded (XSS).
- **SR-10** — If third-party modules are ever installed (post-v1), module server code **must** run sandboxed with no direct filesystem, network, or database access (MR-3 enforced technically, not just by convention).
- **SR-11** — Peer-approval integrity: a judge **must** only ever receive the specific submission assigned to them; assignments **must** be concealed from everyone except the judge and the host (FR-63); and judge decisions **must** be accepted only from the assigned judge's authenticated session, only while the assignment is `pending` and before its deadline.

---

## 17. Branding and Theming

- **FR-60** — Per game, the host **may** configure: game name, logo, background image, accent colour, font/theme preset, host name, custom introduction text, and custom final screen. This is configuration, never custom code.
- **FR-61** — Module UIs **must** consume the platform theme (design tokens) so branding applies across all challenges consistently.

---

## 18. Analytics (Platform Level)

Post-MVP, the platform **should** track anonymized/aggregated: games played, modules used, average players per game, challenge completion rates, average challenge duration, module popularity, and engagement funnels. Module statistics (§11) additionally feed per-challenge insight.

---

## 19. Non-Functional Requirements

| ID | Requirement | Target |
|---|---|---|
| **NFR-1** | Join simplicity | Scan-to-lobby in ≤ 15 s on a mid-range phone; no app, no account |
| **NFR-2** | Interaction latency | Submit → visible ack ≤ 300 ms p95 on party Wi-Fi/LTE |
| **NFR-3** | Broadcast latency | Host action → all screens updated ≤ 1 s p95 |
| **NFR-4** | Reliability | A 30 s network drop on any guest device loses no data (FR-48) |
| **NFR-5** | Scale (v1) | 50 concurrent players per game, 10 concurrent games, smooth on modest hosting; architecture must not preclude 100+ later |
| **NFR-6** | Device support | Evergreen mobile & desktop browsers (iOS Safari, Android Chrome, Firefox, Edge); guest UI usable on 360 px-wide screens |
| **NFR-7** | Extensibility | A competent developer builds a simple new module (multiple-choice-like) in ≤ 1 day using docs + template, touching zero core code |
| **NFR-8** | Accessibility | Guest UI meets WCAG 2.1 AA basics: contrast, touch targets ≥ 44 px, no colour-only information |
| **NFR-9** | Internationalization | All engine strings externalized; modules can ship translations (v1 may ship one language, but nothing hard-coded) |

---

## 20. Future Direction (Post-MVP)

The platform is designed from day one as a generic product; a birthday game is merely one *configuration* of it.

```text
Platform accounts → saved games & templates → sharing/duplication
Custom challenges → module SDK → (much later) module marketplace
Guest accounts (opt-in) → cross-game player statistics
AI-assisted evaluation → judging free-text/drawings/pitches
Advanced modules → drawing, camera, audio recognition, location-based,
                   team play, simultaneous head-to-head, betting rounds
SaaS packaging → orgs, billing, usage analytics, white-labelling
```

The fundamental abstraction must never collapse to "question → answer → points". It is:

> **Challenge = a self-contained interactive experience with configuration, state, inputs, evaluation, and results.**

---

## 21. MVP Scope

### 21.1 Core Platform (must-have)

- Create game, generate code/QR, lobby, join flow (FR-11, FR-29–32)
- Player management incl. reconnection (FR-33–34, FR-48)
- Challenge library, selection, schema-driven configuration, ordering (FR-23–26)
- Game & challenge lifecycle with host control (FR-1–7, §5)
- Real-time state to host, main display, and guests (FR-35–38)
- Submission pipeline with server-side validation and locking (§7.6, SR-1–4)
- Score ledger, live leaderboard, game results (FR-40–42)
- Evaluation modes: automatic + peer approval pipeline + host queue + override (§14)
- Basic media upload for configuration (FR-56, FR-58)

### 21.2 Initial Challenge Modules

Chosen deliberately to stress different corners of the contract:

| # | Module | Exercises |
|---|---|---|
| 1 | Multiple Choice | schema config, fixed scoring, option statistics |
| 2 | Numeric Answer | exact-match evaluation |
| 3 | Closest Number | distance scoring, rich statistics |
| 4 | Timed Reaction | server-side timing (SR-5), time-based scoring |
| 5 | Image / Memory | media capability, timed reveal phases |
| 6 | Majority Vote | no "correct" answer, social scoring |
| 6b | Caption This | **peer approval** (§14.2), text submission + evidence display |
| 7 | Open Performance | **host approval** queue, optional **hybrid** override (§14.3–14.4) |
| 8 | Prediction | deferred evaluation (scored after a later event) |

### 21.3 Architecture Acceptance Test

> **The MVP passes if all eight modules are implemented without a single change to the core engine.**
>
> Any module that forces an engine change indicates a missing generic capability — fix the platform, not the module.

### 21.4 Explicitly Out of MVP

Accounts for guests, templates/sharing, marketplace, analytics dashboards, custom module SDK docs for third parties, native apps, > 50 players.

---

## 22. Open Questions (for Technical Design)

1. **Module UI packaging** — federated frontend components vs. declarative UI schema rendered by platform components (MR-13)? Trade-off: expressiveness vs. sandboxing and theming guarantees.
2. **Module server sandboxing** — in-process trusted modules for v1 (all first-party) vs. isolated execution from the start (SR-10)?
3. **Transport & stack** — WebSockets vs. managed real-time service; monolith vs. split game-server; persistence choice.
4. **Reaction-timing protocol** — how precise can server-authoritative timing be over party networks, and what fairness compensation (per-player latency estimation) is needed (SR-5)?
5. **Late-join semantics per module** — engine default (FR-18) vs. module opt-in hooks for mid-challenge joins.
6. **Peer-approval fairness** — how to weight or audit peer decisions (a rejected player judging their rival?), whether judges earn small points for judging promptly, and derangement algorithm choice for assignments (FR-62) at small player counts.
7. **State snapshot size** — full snapshot on reconnect (FR-36) vs. snapshot + event replay for media-heavy challenges.

---

*End of specification v0.3.*
