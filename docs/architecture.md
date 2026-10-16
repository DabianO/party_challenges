# Architecture

This document records the technical design decisions taken for the MVP and maps the
specification's requirements to their implementation.

## 1. The game model: a self-paced board

The host assembles a **board** of challenge instances. Players open any challenge that is
available to them, press **Start**, play it with their own timers, and submit. There is no
host-driven "current question": each player's run of a challenge is an **attempt**, and
evaluation happens per attempt (or, for aggregate challenges, when the host closes the
challenge). The main display shows the leaderboard, the board with statistics, a live
activity feed and the results of closed challenges.

```text
Instance (engine-owned):  PENDING ─▶ ACTIVE ─▶ LOCKED ─▶ [EVALUATING] ─▶ RESULTS
                          ▲ host unlocks  │ host closes   │ host resolution (onClose)
Attempt (per player):     Start ─▶ input open ─▶ locked ─▶ evaluated ─▶ scored
                                   (timer / submit / Finish / instance closed)
```

Availability per instance: `open` (everyone), `host-unlocked` (hidden until the host
unlocks it), `assigned` (only the listed players see and play it).

Results timing per module (`manifest.results`): `immediate` (each submission is evaluated
on its own) or `onClose` (all submissions are evaluated together when the host closes the
challenge: ranking, votes, predictions).

> Note: spec §5.1/§5.2 still describes a sequential loop where the host steps everyone
> through the same challenge. The lifecycle above is how the engine implements the
> self-paced board requested for v0.3; §14 (evaluation modes) is implemented as written.

## 2. Evaluation pipeline (§14)

Evaluation is a generic engine capability; modules only declare `evaluation.mode`,
`supportedModes`, `criteria`, `evidence` and optional `hostScoring` (MR-17/MR-18).

| Mode | Engine behaviour |
|---|---|
| `automatic` | `evaluate()` runs when the attempt locks (immediate) or at close (onClose). |
| `peer` | An **assignment** pairs the submission with a random eligible judge (never the submitter, never a reciprocal pair when avoidable, connected players preferred, fewest pending tasks first — FR-62). The judge sees the module's `presentSubmission` (or a generic evidence view) plus the criteria on their phone and approves/rejects with an optional note. Only the judge and the host learn about the assignment (FR-63, SR-11). On deadline expiry the engine reassigns, and after `maxReassignments` escalates to the host queue (FR-64). |
| `host` | Every submission goes straight to the host queue (FR-67), where the host approves/rejects or enters points within `hostScoring`. |
| `hybrid` | Peer approval first; peer rejections, expiries and "no eligible judge" cases surface in the host queue (FR-68). |

The final judgement is attached to the submission and handed to the module's
`evaluate()`; the module maps it to points (FR-65). The host can **override** any
submission before or after results (FR-55): prior points are reversed in the ledger and
the new verdict is scored. A game-level preference remaps module defaults where the
module supports the chosen mode (FR-70); hosts can also override the mode per instance.

## 3. Decisions on the spec's open questions (§22)

| # | Question | Decision |
|---|---|---|
| 1 | Module UI packaging | Declarative UI schema rendered by platform components (`ui.ts` → `UIRenderer.tsx`). Modules ship no frontend code. |
| 2 | Module server sandboxing | In-process trusted modules for v1; every module call is wrapped so exceptions surface to the host (FR-52). Modules have no I/O, so isolation later is a loader change. |
| 3 | Transport & stack | Node.js 22+/TypeScript monolith: Fastify + WebSocket, SQLite via built-in `node:sqlite`, React/Vite client. |
| 4 | Reaction-timing protocol | Server timestamps `submittedAt` vs a `goAt` stored with `ctx.now()`; clients never report times. Latency compensation is a follow-up. |
| 5 | Late-join semantics | Late joiners simply see the board (engine default, configurable). |
| 6 | Peer-approval fairness | Derangement by "fewest pending tasks, random tie-break, exclude previous judges and reciprocal pairs"; anonymous submitter in the judge view; host sees every decision and can override. Judge rewards not implemented. |
| 7 | Snapshot size | Full audience-scoped snapshot on every change; media by reference only. |

## 4. Layers

```text
challenges/*                 modules: manifest + JSON-Schema config + pure server logic (+ tests)
packages/contract            ChallengeModule interface (v2), InstanceContext, UI nodes, wire protocol
packages/engine              ModuleRegistry/loader · GameRuntime (board, attempts, evaluation pipeline,
                             ledger, leaderboard, timers, snapshots) · persistence interface
packages/server              Fastify: REST (host/guest) · WebSocket hub · SQLite repository · media service
packages/web                 React: /host, /display/:code, /join/:code, /results/:id · UIRenderer · SchemaForm
```

### Runtime flow

1. A client action (REST host action, or WebSocket `START`/`SUBMIT`/`FINISH`/`JUDGE`) mutates
   the `GameRuntime` and ends in `commit()`.
2. `commit()` emits queued semantic events (each with a new `seq`), then one
   `GAME_STATE_SNAPSHOT` per connected audience (host, main, each player), then persists
   the document (coalesced per tick) through the `Repository`.
3. Timers (attempt time limits, module timers, judge deadlines) run server-side and are
   published as authoritative end timestamps; clients only render countdowns.

## 5. Requirement traceability (selected)

| Requirement | Where |
|---|---|
| FR-1, FR-23–26 library/config | `addChallenge/updateChallenge/reorderChallenges`, `validateConfiguration` (Ajv), `SchemaForm.tsx`, instance options |
| FR-2, FR-5 host control | `performHostAction`: `open-lobby`, `start-game`, `unlock/relock/close/reopen/reset-challenge`, `assign-challenge`, `pause/resume`, `end-game`, `close-game` |
| FR-3, FR-49 live status | `ChallengeStats` per instance, `activity`, player connection flags |
| FR-4, FR-34 remove / free player | `remove-player` (reassigns their judging tasks), `free-player` + reclaim by name |
| FR-6, FR-53–55, FR-62–70 evaluation | `beginEvaluation`, `pickJudge`, `createPeerAssignment`, `onAssignmentDeadline`, `createHostAssignment`, `judge`, `hostDecide`, `hostOverride`, `effectiveMode` |
| FR-7, SR-6 host auth | per-game host token, `Engine.authorizeHost` |
| FR-8–10 main display | `/display/:code`; snapshots for `main` carry stats, activity, results — never views, answers or assignments |
| FR-11, FR-29–32 join flow | `POST /api/join`, unambiguous game codes, name sanitising/uniqueness, QR |
| FR-15–17 generic engine | engine never inspects payloads; `discoverModules()` loads from `challenges/` |
| FR-21–22 locking & timers | `lockAttempt`, `closeInstance`, `scheduleTimer/onTimerFired` |
| FR-27–28 submissions | `submit()` persists verbatim with server timestamp; `resubmission: replace` supersedes until the attempt locks |
| FR-33, FR-48 reconnection | session token hash, `findPlayerBySessionToken`, `POST /api/join/resume` |
| FR-35–39 real-time | `/ws`, `ConnectionHub`, audience-scoped snapshots, `seq`, `MODULE_EVENT` |
| FR-40–43 ledger & leaderboard | `writeAwards`/`reverseAwards` (append-only), `computeLeaderboard`, `adjust-score` |
| FR-44–45 statistics | module `getStatistics(evaluations)`; `computeGenericStatistics` |
| FR-46–47 data model | `packages/server/src/sqlite.ts` (games, players, instances, attempts, submissions, evaluation_assignments, score_awards, media) |
| FR-50–52 failure handling | timers keep running without the host; `restoreAfterRestart`; `callModule` + `MODULE_ERROR` + `retry-evaluation` |
| FR-56–59, FR-69 media & evidence | `MediaService`, `POST /api/games/:id/media`, `POST /api/evidence`, `file-input` node |
| SR-1–4 | server-authoritative runtime; `submit()` checks attempt state, rate limit, then module validation |
| SR-7 | 31^6 code space, `findByCode` ignores `FINISHED` games |
| SR-9 | UI nodes carry plain strings rendered as React text only |
| SR-11 | `judge()` accepts only the assigned judge, only while pending and before the deadline; assignments scoped to `player:<judge>` and host |
| NFR-7 extensibility | `docs/module-authoring.md`; references `closest-number` (onClose) and `caption-this` (peer) |

## 6. Known gaps / follow-ups

- `hostScoring` ranges are static per module; per-instance ranges would need a contract extension.
- Image re-encoding and responsive media sizes (FR-58 partial, FR-59).
- Per-player latency compensation for reaction timing (§22 Q4); judge rewards (§22 Q6).
- Internationalisation: strings are English; engine strings are not externalised (NFR-9).
- Module isolation (SR-10) when third-party modules arrive.
- Spec §5 should be updated to describe the board model.
