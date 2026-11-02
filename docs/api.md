# Server API

All endpoints are served by `@challenge/server`. Types live in `packages/contract/src/protocol.ts`.

## Authentication

- **Host**: each game has a host token returned once by `POST /api/games`. Send it as
  `Authorization: Bearer <hostToken>` (or `?hostToken=` for download links). Tokens are
  stored hashed (SR-6). Each game also accepts a second, stable token derived from the
  server's host key (`DATA_DIR/host-key`); the server hands it only to a browser on the
  host machine itself (`GET /api/local/games`), so a lost token never locks the host out.
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
| `POST /api/games/import` | – (optional `hostPassword`) | `{ setup: GameSetup }` → new DRAFT game `{ game, hostToken, warnings }`; embedded media is re-stored, unknown modules / invalid configurations are skipped with a warning |
| `GET /api/local/games` | host machine only | Every stored game with a host token → `{ games: LocalGameInfo[] }`; 403 for other devices (see below) |
| `GET /api/games/:id` | host | Host snapshot |
| `PATCH /api/games/:id` | host | Update `name`, `settings` (incl. `evaluationPreference`, `judgeDeadlineSeconds`, `maxReassignments`), `branding` |
| `DELETE /api/games/:id` | host | Delete game and its data |
| `GET /api/games/:id/ledger` | host | Score ledger rows |
| `POST /api/games/:id/duplicate` | host | Start over: a new DRAFT game with this game's setup and no players or scores → `{ game, hostToken, warnings }`; the original is untouched |
| `GET /api/games/:id/setup` | host | The game's configuration as a `GameSetup` JSON file (name, settings, branding, board with titles and options, referenced media as base64). No players or scores |
| `GET /api/games/:id/export` | host | Full game document (secrets stripped) |
| `POST /api/games/:id/challenges` | host | Add instance `{ moduleId, configuration, title?, category?, allowReplay?, availability?, assignedPlayerIds?, evaluationMode? }` |
| `PATCH /api/games/:id/challenges/:instanceId` | host | Update `configuration` (only while nobody has played it: never opened, or reset; an open instance restarts from the new configuration) and/or instance options |
| `DELETE /api/games/:id/challenges/:instanceId` | host | Remove, any time before the game is closed; points already earned with it are reversed, as with a reset |
| `POST /api/games/:id/challenges/reorder` | host | `{ order: string[] }` |
| `GET /api/games/:id/challenges/:instanceId/results` | host | Shared results of an instance |
| `POST /api/games/:id/actions` | host | Body is a `HostAction` (below) |
| `POST /api/games/:id/media` | host | multipart `file` → `{ id, ref: "media://<id>", url }` (configuration media) |
| `POST /api/evidence` | guest headers | multipart `file` → `{ ref, url }` (submission evidence, §14.6); game must be running |
| `POST /api/avatar` | guest headers | multipart `file` (an image, at most 1 MB; the web client sends a 320 px square JPEG) → `{ ref, url }`; becomes the player's picture (`PlayerPublic.avatar`) |
| `DELETE /api/avatar` | guest headers | Back to the player's icon (`PlayerPublic.icon`) |
| `GET /media/:id` | – | Serves validated media with sandbox CSP + nosniff |
| `GET /api/games/by-code/:code` | – | Public game info / joinability |
| `POST /api/join` | – | `{ code, displayName }` → `JoinResponse` |
| `POST /api/join/resume` | – | `{ code, sessionToken }` → `JoinResponse` |
| `GET /api/games/:id/results` | – | Read-only results once the game has ended (points hidden until revealed) |

**Host machine detection** (`/api/local/games`): the request must come from a loopback
or local interface address with a Host header naming this machine. Behind a proxy on
the same machine (the Vite dev server) the last `X-Forwarded-For` entry must be local
too, so the proxy must append it (`xfwd: true` in `vite.config.ts`). Set
`LOCAL_HOST_ACCESS=0` when a reverse proxy on the host forwards outside traffic without
that header.

**Internet mode** (`ADMIN_PORT` set; see `docs/deployment.md`): the server listens twice.
- **`PORT` (public):** answers only the allow-list in `packages/server/src/surface.ts`:
  - the client's pages except `/host`, and its static files
  - `/api/health` (just `{ ok: true }`), `/api/games/by-code/:code`, `/api/join`,
    `/api/join/resume`, `/api/games/:id/results`, `/api/evidence`, `/api/avatar`, `/media/:id`
  - `/ws` for players and the big screen by code

  Everything else answers 404, even with a valid host token. Per client address
  (`cf-connecting-ip` from the Cloudflare tunnel) it allows per minute: 3000 requests in
  total, 60 joins, 240 code lookups, 240 uploads and 600 WebSocket connections. More gives
  429 with `Retry-After`.
- **`ADMIN_PORT`:** serves everything, but only to requests whose Host header names this
  machine (`localhost`, a local address). Bind it to the host machine only. `/api/local/games`
  works there without the address check.

Every response carries a strict `Content-Security-Policy`, `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.

### Host actions

| `action` | Effect |
|---|---|
| `open-lobby` | DRAFT → LOBBY; code/QR become live |
| `start-game` | LOBBY → IN_PROGRESS; every challenge that is not `host-unlocked` becomes ACTIVE |
| `unlock-challenge` `{instanceId}` | PENDING → ACTIVE |
| `relock-challenge` `{instanceId}` | ACTIVE → PENDING (hidden again; running attempts continue) |
| `close-challenge` `{instanceId}` | ACTIVE → LOCKED: running attempts lock, `onClose` modules are evaluated, immediate modules reach RESULTS once nothing is pending |
| `reopen-challenge` `{instanceId}` | LOCKED/EVALUATING/RESULTS → ACTIVE. Players who played keep their result. For `onClose` modules the points awarded at the close are reversed (they are awarded again at the next close), and live-action ones (Hot Takes, Blob War) give players the attempt the close ended back |
| `reopen-all-challenges` | The same for every closed challenge at once (e.g. after `reopen-game`) |
| `reset-challenge` `{instanceId}` | Reverse all points for the instance, wipe attempts/submissions/assignments, re-open |
| `reopen-for-player` `{instanceId, playerId}` | Give one player another go at a challenge the module closed for them (listed in the host-only `closedFor` of the challenge summary); points already earned or deducted stay |
| `assign-challenge` `{instanceId, playerIds}` | Make the instance available to specific players only |
| `decide` `{assignmentId, decision, points?, note?}` | Host queue decision (FR-67) |
| `override` `{submissionId, decision, points?, reason}` | Overrule any evaluation, before or after results (FR-55); previous points are reversed in the ledger |
| `resolve` `{instanceId, payload}` | Instance-level host resolution for `onClose` modules (e.g. prediction outcome) |
| `retry-evaluation` `{instanceId}` | Re-run evaluation after a module error |
| `pause` / `resume` | Freeze/resume all attempt timers and judge deadlines; submissions rejected while paused |
| `clear-avatar` | `{ playerId }`: take a player's selfie off (they get their icon back) |
| `show-spotlight` | `{ instanceId, itemId, hold? }`: put one spotlight item (e.g. a Hot Take) on the big screen now, for a minute or, with `hold`, until `release-spotlight` |
| `release-spotlight` | Let the spotlight rotate again after a held item (the next one comes up at once) |
| `start-presentation` | `{ instanceIds?, autoplay? }`: the results presentation on the big screen, with the slides (module `presentation`) of the given closed challenges, default all that have any, in board order. Also on a finished game |
| `move-presentation` | `{ to }`: `next` / `previous` (a step; at a slide's end, the next slide), `next-slide` / `previous-slide`, or `{ instanceId, slide? }` |
| `autoplay-presentation` | `{ on }`: play by itself (each step for its `stepSeconds`, stopping on the last one; from the end it starts over) or hold |
| `stop-presentation` | Back to the normal big screen |
| `publish-standings` | Copy the current leaderboard (with graph lines) to the big screen and append ranking changes (new leader, overtakes, newcomers, drawing level) to the standings feed. The big screen changes only on this action; phones are not affected |
| `reveal-results` / `hide-results` | Show (or hide again) points, ranks and results to players and the main display. Games start hidden; the host always sees everything. `reveal-results` also works on a FINISHED game |
| `end-game` | Close every open challenge, hand unanswered peer tasks to the host, → GAME_RESULTS |
| `close-game` | GAME_RESULTS → FINISHED; game code stops resolving; results are revealed |
| `reopen-game` | GAME_RESULTS/FINISHED → IN_PROGRESS with players, attempts and points kept; results hidden again; challenges stay as they were (reopen them individually). A closed game gets a new code if its old one was handed out meanwhile |
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

Until the host reveals results (`game.resultsRevealed`), non-host snapshots carry no
outcome: board entries show a finished attempt as `submitted` with `points`/`result`
null, `results` is empty, leaderboard entries have `rank`/`total`/`lastDelta`/`wins`
zeroed (ordered by `completed`), challenge stats omit average/best points, `scored`
activity is dropped and `PLAYER_SCORED` events go to the host only. `RESULTS_REVEALED` /
`RESULTS_HIDDEN` events announce the switch. A module's `playerNote` (board entry `note`) is
the one exception: personal practice feedback the module chooses to show right away.

The main display's challenge summaries carry `displayPanel` (the module's live big-screen
panel, or null) and `displayBanner` (its line for the top bar while open, or null).

Host and main display also receive `standings` (the last published copy, or null) and
`standingsFeed` (newest first), independent of `resultsRevealed`; players receive neither.

Host and main display receive `presentation` while the host runs the results presentation
(the current step of the current slide: `ui`, the challenge's `title`/`category`, the slide's
`caption`, `slide`/`slideCount`, `step`/`stepCount`, `index`/`total` over the whole
presentation, `autoplay` and `startedAt`/`endsAt`), else null; the host also receives
`presentationDeck` (every closed challenge with slides and whether it is included). The
presentation lives in server memory: a restart ends it.

Each leaderboard entry carries `series` for the progress graph: the running total after each
challenge the player finished, in their own finishing order (index 0 = start). A replayed
challenge keeps its slot and follows its current (best) points; the last value equals `total`.

Client → server (`ClientMessage`, players only, each answered with `ACK {clientId, ok, reason?}`):

| Message | Effect |
|---|---|
| `START {instanceId}` | Start the player's attempt (their timers begin); again after a finished attempt when the instance allows replays (`canReplay`). Refused with the module's reason while its board entry is `waiting` (e.g. another player's turn) |
| `SUBMIT {instanceId, payload, final?}` | Submit; locks the attempt unless the module allows resubmission. `final: true` always locks (the web client sends it: one tap locks the answer in) |
| `FINISH {instanceId}` | Lock the attempt early (resubmission modules) |
| `ACTION {instanceId, payload}` | Live action for a module's `onAction` (e.g. a batch of taps); needs an attempt in progress; not a submission; rate limited separately |
| `JUDGE {assignmentId, decision, note?}` | Peer decision; accepted only from the assigned judge while pending and before the deadline (SR-11) |
| `RESYNC`, `PING {t}` | Fresh snapshot / clock sync |

Close codes: `4001` player removed, `4003` authentication failed.
