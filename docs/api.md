# Server API

All endpoints are served by `@challenge/server`. Types live in `packages/contract/src/protocol.ts`.

## Authentication

- **Host**: each game has a host token returned once by `POST /api/games`. Send it as
  `Authorization: Bearer <hostToken>` (or `?hostToken=` for download links). Tokens are
  stored hashed; losing the token means losing host access to that game (SR-6).
- **Guest**: `POST /api/join` returns a per-device `sessionToken` bound to a `playerId`.
  Reconnecting with the same token reattaches the same player (FR-33). REST calls made by
  guests (evidence uploads) send `X-Game-Code` and `X-Session-Token` headers.
- **Main display**: needs only the game code (read-only audience).

Errors are JSON `{ "error": string, "code"?: string }` with status 400 (validation),
401 (auth), 404 (not found), 409 (invalid state), 413/415 (media).

## REST

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/health` | – | Liveness, module and game counts |
| `GET /api/modules` | – | Challenge Library: `{ modules: ModuleInfo[] }` (manifest incl. `evaluation.supportedModes`, `results`) |
| `POST /api/games` | – (optional `hostPassword`) | Create game → `{ game, hostToken }` |
| `GET /api/games/:id` | host | Host snapshot |
| `PATCH /api/games/:id` | host | Update `name`, `settings` (incl. `evaluationPreference`, `judgeDeadlineSeconds`, `maxReassignments`), `branding` |
| `DELETE /api/games/:id` | host | Delete game and its data |
| `GET /api/games/:id/ledger` | host | Score ledger rows |
| `GET /api/games/:id/export` | host | Full game document (secrets stripped) |
| `POST /api/games/:id/challenges` | host | Add instance `{ moduleId, configuration, availability?, assignedPlayerIds?, evaluationMode? }` |
| `PATCH /api/games/:id/challenges/:instanceId` | host | Update `configuration` (only before the instance was opened) and/or instance options |
| `DELETE /api/games/:id/challenges/:instanceId` | host | Remove (no attempts yet) |
| `POST /api/games/:id/challenges/reorder` | host | `{ order: string[] }` |
| `GET /api/games/:id/challenges/:instanceId/results` | host | Shared results of an instance |
| `POST /api/games/:id/actions` | host | Body is a `HostAction` (below) |
| `POST /api/games/:id/media` | host | multipart `file` → `{ id, ref: "media://<id>", url }` (configuration media) |
| `POST /api/evidence` | guest headers | multipart `file` → `{ ref, url }` (submission evidence, §14.6); game must be running |
| `GET /media/:id` | – | Serves validated media with sandbox CSP + nosniff |
| `GET /api/games/by-code/:code` | – | Public game info / joinability |
| `POST /api/join` | – | `{ code, displayName }` → `JoinResponse` |
| `POST /api/join/resume` | – | `{ code, sessionToken }` → `JoinResponse` |
| `GET /api/games/:id/results` | – | Read-only results once the game has ended |

### Host actions

| `action` | Effect |
|---|---|
| `open-lobby` | DRAFT → LOBBY; code/QR become live |
| `start-game` | LOBBY → IN_PROGRESS; every challenge that is not `host-unlocked` becomes ACTIVE |
| `unlock-challenge` `{instanceId}` | PENDING → ACTIVE |
| `relock-challenge` `{instanceId}` | ACTIVE → PENDING (hidden again; running attempts continue) |
| `close-challenge` `{instanceId}` | ACTIVE → LOCKED: running attempts lock, `onClose` modules are evaluated, immediate modules reach RESULTS once nothing is pending |
| `reopen-challenge` `{instanceId}` | LOCKED/EVALUATING/RESULTS(immediate) → ACTIVE |
| `reset-challenge` `{instanceId}` | Reverse all points for the instance, wipe attempts/submissions/assignments, re-open |
| `assign-challenge` `{instanceId, playerIds}` | Make the instance available to specific players only |
| `decide` `{assignmentId, decision, points?, note?}` | Host queue decision (FR-67) |
| `override` `{submissionId, decision, points?, reason}` | Overrule any evaluation, before or after results (FR-55); previous points are reversed in the ledger |
| `resolve` `{instanceId, payload}` | Instance-level host resolution for `onClose` modules (e.g. prediction outcome) |
| `retry-evaluation` `{instanceId}` | Re-run evaluation after a module error |
| `pause` / `resume` | Freeze/resume all attempt timers and judge deadlines; submissions rejected while paused |
| `end-game` | Close every open challenge, hand unanswered peer tasks to the host, → GAME_RESULTS |
| `close-game` | GAME_RESULTS → FINISHED; game code stops resolving |
| `remove-player` `{playerId}` | Disconnects the device; their pending judging tasks are reassigned |
| `free-player` `{playerId}` | Device disconnected, slot reclaimable by re-joining with the same name |
| `adjust-score` `{playerId, points, reason}` | Manual ledger entry |

## WebSocket `/ws`

Connect with a query string:

- host: `?role=host&gameId=<id>&token=<hostToken>`
- main display: `?role=main&code=<code>`
- player: `?role=player&code=<code>&token=<sessionToken>`

Server → client (`ServerMessage`): `HELLO`, `EVENT`, `ACK`, `PONG`, `ERROR`. Every state
change arrives as an `EVENT` of type `GAME_STATE_SNAPSHOT` whose payload is an
audience-specific `GameSnapshot`; clients replace their state with it. Players receive
their `board` (one entry per visible challenge with status, live view, timers, personal
result) and `judging` tasks; the host receives `hostQueue`, `resolutions`, `evaluations`
and `scored`; host and display receive `activity`. Assignments are never revealed to the
display or to the judged player (FR-63).

Client → server (`ClientMessage`, players only, each answered with `ACK {clientId, ok, reason?}`):

| Message | Effect |
|---|---|
| `START {instanceId}` | Start the player's attempt (their timers begin) |
| `SUBMIT {instanceId, payload}` | Submit; locks the attempt unless the module allows resubmission |
| `FINISH {instanceId}` | Lock the attempt early (resubmission modules) |
| `JUDGE {assignmentId, decision, note?}` | Peer decision; accepted only from the assigned judge while pending and before the deadline (SR-11) |
| `RESYNC`, `PING {t}` | Fresh snapshot / clock sync |

Close codes: `4001` player removed, `4003` authentication failed.
