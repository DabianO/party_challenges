# Writing a Challenge Module (contract v2)

> **A challenge is a plugin, not a feature of the game engine.**

A module is a folder under `challenges/` that ships everything a challenge needs. The
engine discovers it at startup; no core code changes are needed (spec MR-1, FR-16).

```text
challenges/<module-id>/
├── manifest.json          # identity, capabilities, evaluation mode, results timing
├── config.schema.json     # JSON Schema – the host's configuration form is generated from it
├── server/index.ts        # default export: the ChallengeModule implementation
└── test/*.test.ts         # vitest tests
```

Modules import **only** from `@challenge/contract`. They must not import other modules,
touch the database, filesystem or network (MR-2, MR-3). Everything the module needs from
the platform comes through the `InstanceContext` argument.

## 0. The game model

A game is a **board** of challenge instances. There is no host stepping everyone through
questions: each player taps a challenge on their board whenever they like (that starts
it), plays it at their own pace (with their own timers) and submits. This is an
**attempt**; one per player per instance, unless the host allows **replays** on an
`immediate` instance, in which case a player may start new attempts and only their best
one counts. The engine evaluates submissions (§14) and writes scores to the ledger.
Results stay hidden from players and the main display until the host reveals them; the
engine handles that, modules render results as usual. The main display shows progress or
the leaderboard, activity and statistics, not a shared question.

Consequences for module code:

- Instance state is **shared** by all players. Keep per-player data keyed by
  `player.id` (e.g. `guesses[player.id]`).
- Timers are **per player** when passed a `playerId`: `ctx.schedule('lock', 30, player.id)`.
- With replays, `onAttemptStart` runs again for the same player: **clear that player's
  per-attempt data there** (e.g. `const { [player.id]: _, ...answers } = state.answers`),
  or `validateInput` will still see the previous attempt's answer.
- `guestView(state, player, ctx)` renders **that player's** attempt and must not leak
  other players' data (MR-10). The main display never shows answers (MR-9).

## 1. manifest.json

```json
{
  "id": "caption-this",
  "name": "Caption This",
  "version": "1.0.0",
  "apiVersion": "2",
  "category": "social",
  "description": "Write the best caption for a picture. Another player judges it.",
  "players": { "min": 2, "max": null },
  "duration": { "typicalSeconds": 60 },
  "capabilities": ["timer", "image", "text-input", "statistics"],
  "evaluation": {
    "mode": "peer",
    "supportedModes": ["peer", "host", "hybrid"],
    "criteria": "Approve the caption if it fits the picture and is funny; reject empty or offensive ones.",
    "evidence": { "kind": "text", "field": "caption", "label": "Caption" },
    "hostScoring": { "min": 0, "max": 10, "step": 1 }
  },
  "results": "immediate",
  "resubmission": "replace"
}
```

| Field | Notes |
|---|---|
| `id`, `version` | kebab-case id; `id@version` identifies a build; games pin the exact version. A game whose pinned version is no longer installed moves up to the newest installed version **with the same major**, so minor/patch releases must keep `State` and `Config` compatible; bump the major for anything else. |
| `apiVersion` | Must be `"2"`. The loader refuses anything else. |
| `category` | `knowledge`, `skill`, `social`, `memory`, `creativity`, `chaos`, `other`. |
| `evaluation.mode` | `automatic` (your `evaluate()` decides), `peer` (another player approves/rejects), `host` (host queue), `hybrid` (peers first, rejections go to the host). |
| `evaluation.supportedModes` | Every mode the module can run in. Hosts may pick any of these per game or per instance (FR-70). Defaults to `[mode]`. |
| `evaluation.criteria` | Required for non-automatic modes: what a judge should check (MR-17). |
| `evaluation.evidence` | Which payload field judges look at: `kind` `text`, `number`, `image`, `video`, `audio` or `none`. Used for the generic judging screen when you do not implement `presentSubmission`. |
| `evaluation.hostScoring` | Optional `{min,max,step}`; when set the host may enter points instead of approve/reject. The value arrives in `judgement.points`. |
| `evaluation.deadlineSeconds` | Optional per-module override of the judge deadline. |
| `results` | `immediate` — each submission is evaluated on its own as soon as the attempt locks (after judging). `onClose` — evaluation runs once over all submissions when the host closes the challenge (ranking, votes, predictions). `onClose` modules must be `automatic`. |
| `resubmission` | `none` (default: submitting locks the attempt) or `replace` (a client may replace the answer until the timer fires or it sends FINISH). The web client locks on a submit unless the button says `final: false` (`ui.submit('Save', { final: false })`): then the attempt stays open and every save replaces the last, until a final submit, the time limit or the host closing it (`fill-in-the-blanks`). Enter in a text box does what the screen's first button does. |
| `attempts` | `once` (default; the host may still enable best-of replays) or `repeat`: taking part repeatedly *is* the challenge. Players may always start a new attempt, every attempt is scored and the points add up; gate who may start with `canStart`. `immediate` results only. Examples: `group-message`, `secret-word`, `report-score`. After a repeat attempt locks, a player who may start again straight away is offered to continue on the same screen. |
| `suggestedCategory` | Optional, at most 40 characters: pre-filled as the challenge's category when the host adds it (e.g. `"Hot Takes"`). The host can change it. |
| `suggestedReplay` | Optional `true`: replays start switched on when the host adds the challenge (best try counts; the host can switch them off). For challenges where playing again to beat your own score is the point (`color-match`). `immediate` results only. |
| `supersededBy` | Optional module id that replaces this one. The host's library stops offering the module; games and setup files that use it keep working. Keep the module installed. |
| `capabilities` | Declare everything you use (`timer`, `image`, `text-input`, `numeric-input`, `multiple-choice`, `evidence-upload`, `statistics`, …). |

## 2. config.schema.json

Standard JSON Schema (draft-07 subset). The host UI renders a form from it; the server
validates against it and applies `default`s (MR-7). Supported field types in the form
generator: `string` (with optional `enum`, `maxLength`, `format: "media-ref"` for image
upload), `number`/`integer` (with `minimum`/`maximum`), `boolean`, and `array` of
`string` or of flat `object`s. Use `title` and `description` for labels and help text.

A number with one special value besides its range is written as
`"anyOf": [{ "const": 0, "title": "No time limit" }, { "minimum": 5 }]` (put `maximum` and
`default` on the field itself). The form shows the range as the number field and the
constant as a checkbox labelled with its title. Every per-player time limit offers
"No time limit" this way: the module then skips `ctx.schedule('lock', …)` and the attempt
lasts until the player locks in or the host closes the challenge.

## 3. server/index.ts

```ts
import { defineModule, ui, type Manifest } from '@challenge/contract';
import manifestJson from '../manifest.json' with { type: 'json' };
import schemaJson from '../config.schema.json' with { type: 'json' };

export default defineModule<Config, State, Input, Evaluation>({
  manifest: manifestJson as unknown as Manifest,
  configurationSchema: schemaJson,
  createInstance(config, ctx) { ... },          // shared state for the instance
  onAttemptStart(state, player, ctx) { ... },    // schedule the player's time limit here
  onTimer(state, tag, ctx, playerId) { ... },    // optional: your own timers
  onAttemptLocked(state, player, ctx) { ... },   // optional
  lockInput(state, player, ctx) { ... },         // optional: live-action answers become the submission at the lock
  validateInput(state, player, input, ctx) { ... },
  handleInput(state, player, input, ctx) { ... },
  evaluate(state, submissions, ctx) { ... },
  calculateScores(state, evaluation, ctx) { ... },
  getStatistics(state, evaluations, ctx) { ... },
  introView(state, player, ctx) { ... },         // optional: instructions before Start
  timeLimit(state, player, ctx) { ... },         // optional: seconds the player will have (warned before Start)
  guestView(state, player, ctx) { ... },
  presentSubmission(state, submission, ctx) { ... }, // optional: how judges see a submission
  mainView(state, ctx) { ... },                  // optional: public card content
  resultsView(state, evaluations, ctx) { ... },
});
```

### Lifecycle

Instance (engine-owned): `PENDING` (not yet available) → `ACTIVE` (players may start) →
`LOCKED` (host closed it) → [`EVALUATING` (host resolution)] → `RESULTS`.

Attempt (per player): Start → input open → **locked** (submitted with `resubmission:
none`, timer `lock` fired, player pressed Finish, or the host closed the instance) →
evaluated → scored.

1. **`createInstance(config, ctx)`** runs when the instance becomes available (once).
1b. **`canStart(state, player, ctx)`** (optional) adds a gate on top of the engine's
   availability, e.g. turn-taking. Return `{ ok: true, hint? }` (the hint shows on the
   player's tile, e.g. "Your turn!") or `{ ok: false, reason }` (the tile shows a waiting
   state with the reason; starting is refused). `{ ok: true, urgent: true }` means the player
   is needed right now (`group-message`: their turn): their board puts the tile on top in its
   own colour, also while their attempt runs. Add `finished: true` when the player has
   nothing left to do (all words played, score reported): a repeat module's tile then shows
   as done instead of waiting. It is called for every player on every snapshot, so keep it
   pure and cheap.
1b2. **`timeLimit(state, player, ctx)`** (optional) returns the seconds the player will have
   once they start (the `lock` timer you set in `onAttemptStart`), or null. The phone then shows
   a warning before Start ("Timed challenge: 60 seconds", with the `introView`), where the
   player can still go back. Every module with a time limit setting implements it.
1c. **`playerNote(state, player, ctx)`** (optional) returns a short personal line for the
   player's tile and lock-in message, e.g. `"312 ms · best 287 ms"`. It is shown even while
   the host keeps results hidden, so use it for practice feedback, not to give away answers.
   Return `{ text, tone }` to colour it: `danger`/`warning` replaces the "Locked in ✓" message
   with a warning, and in a repeat module the "continue" screen shows it as "Not accepted"
   (`report-score`: a number above the maximum costs points and must be filled in again).
1d. **`closedFor(state, ctx)` / `reopenFor(state, player, ctx)`** (optional, implement both)
   let a module close a still-open challenge for single players (`report-score`: a number
   above the maximum). `closedFor` lists their ids; the host sees them on the challenge in the
   Run tab and can give each another go (`reopen-for-player`), which calls `reopenFor`.
1e. **Live actions** (optional, implement both): `validateAction` / `onAction(state, player,
   payload, ctx)` take rapid input that is *not* a submission, e.g. taps from a
   `ui.tapPad('pump')` (payload `{ pump: tapsSinceLastBatch }`, sent every ~300 ms). Only
   accepted while the player's attempt is in progress and the instance is ACTIVE; nothing is
   stored or evaluated per action, and the engine throttles the snapshots they cause. Pair
   with `results: "onClose"` and score from state. Example: `blob-war`.
   `ui.stopwatch('clock', { hideAfterSeconds })` is timed on the phone itself: Start sends
   the live action `{ clock: 'start' }`, Stop submits `{ clock: elapsedMs }` measured between
   the two touches, so Wi-Fi delay does not count. Note the server time in `onAction` and
   compare it with the submission to catch implausible times. Examples: `stop-the-clock`
   (the time visible all the way), `time-estimation` (`hideAfterSeconds: 0`: no clock at all).
   `ui.quickRounds(name, runId, rounds, secondsPerRound)` plays a burst of short timed rounds
   on the phone (a prompt, a few buttons, the next round at once): Start sends the live action
   `{ [name]: 'start' }`, you deal the rounds in `onAction` under a new `runId`, the phone
   counts down (under 3 s), plays them and submits `{ [name]: { runId, answers: [{ choice, ms
   }] } }` (`choice` null when time ran out). Check the `runId` in `validateInput`, and check
   the server's time from the deal to the submission against what the rounds allow (allow
   ~250 ms per round between rounds). With `choices: [{ id, label, detail }]` the phone shows
   one start button per choice instead (e.g. levels, with what each means in `detail`), and the
   start action carries it: `{ [name]: 'start', choice: id }`. Example: `color-match`.
1f. **`displayPanel(state, ctx)`** (optional) is a live panel for the big screen, shown next
   to the race graph while the instance is open and as the closing picture after it closes
   or the game ends. Everyone sees it, so never leak answers. `ui.blobField(fieldId, 'live' |
   'final', { cols, rows, cells }, blobs)` renders a territory map: `cells` is one character
   per grid cell (row by row, `blobCells.encode(slot)` or `blobCells.EMPTY`), and each blob
   names its `slot`, `color` (#rrggbb), `label`, `share` and an optional `pulse` counter
   (a glow when it rises). Live it is drawn as embossed liquid that flows between snapshots;
   final as a gapless picture with every share (empty cells join the nearest territory).
   Return null when there is nothing to show (`fill-in-the-blanks` shows the latest sentence
   while it is open, a new one a minute from its own instance timer, and nothing once closed).
   Panels with a picture (a `blob-field`) come first on the screen, other panels underneath.
   **`displayBanner(state, ctx)`** (optional) returns one short line for the big screen's top
   bar while the instance is open, or null: `group-message` shows whose turn it is there.
   Return parts, `[{ text }, { text: name, color: player.color }, …]`, to colour some of it
   (`group-message`: the writer's name in their own colour).
   **`displayOverlay(state, ctx)`** (optional) returns a layer drawn over the whole big screen
   while the instance is open (a 16:9 box, see-through and not clickable, hidden during the
   results presentation), or null. `ui.aimField(crosshair, home, targets, bursts)` draws a
   crosshair that glides between positions, its home base, targets that float a little
   (`{ id, x, y, size, color }`, positions 0..1) and a pop with a short text where one was hit
   (a new burst `id` plays it once), plus an optional `shot` that flashes once per new `id`. Steer it with `ui.dPad(action, { fireLabel, disabled })`
   on the phones: arrow presses arrive in batches as `{ [action]: { move: [dx, dy] } }`,
   Shoot as `{ [action]: { fire: true } }`. Example: `balloon-pop` (an instance timer brings
   each balloon; instance timers pause with the game).
1g. **`spotlight(state, ctx)`** (optional) returns items for the big screen's spotlight:
   `{ id, ui, activity }[]`, e.g. one per statement with how the room answered it. The engine
   shows one item a minute from all open instances that have any: every item once per round,
   the item whose `activity` grew most since it was last shown first, otherwise at random.
   Raise `activity` on every new or changed answer. Everyone sees it: aggregate answers only.
   `ui.distribution(columns, { axis, marker, highlight, compact })` draws a column chart of answers
   on a scale. Example: the Hot Takes modules (`sliding-scales`, `rivalries`, `binaries`,
   `likelihoods`, `agree-to-disagree`).
   **Answers that stay open:** `ui.liveAnswer('answer', id, value, { min, max, step, unit,
   marks, stepLabels, start, options })` is a slider (or buttons, with `options`) that sends
   every change as the live action `{ answer: { id, value } }`, with no submit, so players can
   change their minds until the instance closes. Pair it with `results: "onClose"` and score
   from state, like the Hot Takes modules.
   **Answers built up item by item:** `ui.pairMatch(action, left, right, links, { leftTitle,
   rightTitle })` shows two columns to link (tap one item, then one on the other side; tap a
   link to undo it): every change is the live action `{ [action]: { left, right } }` (`right:
   null` undoes). Use ids that do not tell what belongs together (positions on the player's
   own sheet). Return `lockOnLeave: true` from `guestView` (with `canSubmit: true`) once the
   answer is complete: going back to the board then submits `{}` (final), so `validateInput`
   must accept it. Example: `match-up` (`onClose`, scored from state, so unfinished sheets
   count too). `ui.wordEntry(action, { placeholder, maxLength, buttonLabel })` is a box for one
   answer after another: Enter sends `{ [action]: text }`, empties the box and keeps the
   keyboard open; show what came of each entry with your own nodes. For `immediate` modules
   whose answers are live actions, implement **`lockInput(state, player, ctx)`**: when the
   attempt locks without a submission (time up, Finish, the host closing it) the engine
   records what it returns as the player's submission and evaluates it, or nothing for null
   (the attempt is missed). Example: `name-them-all` (everything named before the buzzer
   counts).
1i. **`presentation(state, evaluations, ctx)`** (optional) returns slides for the results
   presentation the host runs on the big screen once the challenge is closed (`RESULTS`):
   `{ caption?, steps: UINode[], stepSeconds? }[]`. The host moves through the steps one by one
   (or lets them play, `stepSeconds` each, default 10), then on to the next slide. Most slides
   have one step; more steps change part of the slide in place, e.g. `ui.spool(parts,
   entries, index)`: a sentence with everyone's entries rolling through its blanks, one entry
   per step (every blank as wide as its longest entry, so the sentence stays still). Slides
   are shown while points are still hidden: no points or rankings on them. The big screen
   shrinks a slide that does not fit, so one slide may hold many items (`ui.grid`). Examples:
   `fill-in-the-blanks` (spool), `selfiemotion` (four per slide), `group-message` (the
   message in readable parts), `blob-war` (the closing picture), the Hot Takes modules (every
   statement on one slide), the quiz modules (`multiple-choice`, `numeric-answer`: the room's
   answers first, the right answer revealed in a second step with the same layout), photos
   and captions (`photo-hunt`, `caption-this`). Every built-in module has slides: give a new
   module some too, since hosts expect every challenge to be presentable. Which challenges are
   in it is the host's choice (`inPresentation`), not the module's. Return `[]` when there is
   nothing to show.
1h. **`onPlayerJoin(state, player, ctx)`** (optional) runs for every ACTIVE instance when a
   new player joins the game, before they start anything, e.g. to give them a place on a
   shared field right away.
2. **`onAttemptStart(state, player, ctx)`** runs when a player starts the challenge (and
   again on every replay). Schedule their time limit:
   `ctx.schedule('lock', state.config.timeLimit, player.id)`, and reset the player's
   per-attempt data. You can schedule other per-player timers (`'go'`, `'hide'`, …) and
   react in `onTimer(state, tag, ctx, playerId)`.
3. **Timers**: reserved tag `lock` with a `playerId` locks that player's attempt; without a
   playerId it closes the whole instance. Clients render `ui.timer(tag)` as a countdown;
   attempt-scoped timers are only visible to their player.
4. **Input**: `validateInput` returns `{ ok: true }` or `{ ok: false, reason }`.
   `handleInput` returns the new state. The engine has already checked that the game is
   running, the attempt is in progress, and the rate limit. Submissions are persisted
   verbatim with a server timestamp.
5. **Evaluation** — depends on `results`:
   - `immediate`: once the attempt locks, the engine runs the evaluation mode. For
     `automatic` it calls `evaluate(state, [submission])` right away; for `peer`/`host`/
     `hybrid` it first collects a decision and then calls `evaluate` with the submission
     carrying `judgements: [{ by, decision, points?, note? }]`. Use the **last** judgement
     as the verdict. Then `calculateScores(state, evaluation)` → ledger.
   - `onClose`: when the host closes the instance the engine calls
     `evaluate(state, allSubmissions)` once, then `calculateScores`. If you implement
     `hostResolutionView`/`applyHostResolution`, the instance waits in `EVALUATING`
     until the host submits your form (e.g. "who actually won?"), then scores.
6. **Results**: `resultsView(state, evaluations, ctx)` receives all evaluations so far
   (`onClose`: one; with replays, only each player's best attempt). Return
   `{ ui, guestUi?(player) }`; `guestUi` is the personal result a player sees once the
   host reveals results, `ui` is shown on the display when the instance reaches
   `RESULTS` (also after the reveal). `getStatistics(state, evaluations)` gets the same array.

### Rules

- **Deterministic** (MR-11): use `ctx.rng()` and `ctx.now()`, never `Math.random()` or `Date.now()`.
- **State is JSON**: no classes, `Map`s, `Set`s or functions in `State`/`Evaluation`.
- **Return new state**; don't rely on mutation being observed.
- **Never implement judging yourself** (MR-18): no queues, deadlines, or judge picking.
  Declare `criteria`/`evidence` and map judgements to points.
- `submission.startedAt` (attempt start) and `submission.submittedAt` are server times:
  use them for speed bonuses and reaction timing (SR-5). Client-reported times are advisory,
  with one bounded exception: a `ui.stopwatch` time is more precise than any server
  measurement over Wi-Fi, so `stop-the-clock` accepts it only when it lies within 750 ms of
  the server's own measurement (start action → submission) and uses the server's time otherwise.
  `ui.quickRounds` answer times are the same kind of exception: `color-match` refuses a try
  that took the server longer than its rounds allow.
- Player names come from `ctx.players()`; store `displayName` in evaluation rows so
  `resultsView` can render without a roster lookup.
- Colour players with `player.color` (#rrggbb, from `ctx.players()` or the `PlayerRef` you
  get): every player keeps one colour for the whole game, the same as in the race graph.
  `playerColor(index)` from the contract is the palette behind it.
- Use `ctx.mediaUrl(ref)` to turn a `media://…` config value into a URL for `ui.image`.

## 4. Building UI

Views return trees of UI nodes built with the `ui` helpers from `@challenge/contract`:

| Helper | Renders |
|---|---|
| `ui.stack(children, {gap, align, direction})`, `ui.row(...)`, `ui.grid(cols, children)` | layout |
| `ui.display(text)`, `ui.title`, `ui.subtitle`, `ui.text`, `ui.caption` | typography (`tone`: primary/success/warning/danger/muted) |
| `ui.image(src, {maxHeight, hidden})`, `ui.video(src)`, `ui.audio(src)` | media (`hidden` blurs an image) |
| `ui.timer(tag, {size, label})` | countdown for a scheduled timer |
| `ui.badge(text, tone)`, `ui.progress(value, max)`, `ui.card(children, tone)` | status |
| `ui.list(items)`, `ui.barChart(bars, {percent})`, `ui.ranking(rows)` | results |
| `ui.choices(name, options, {multiple, columns, submitOnSelect, value})` | option buttons |
| `ui.numberInput(name, {...})`, `ui.textInput(name, {...})`, `ui.slider(name,min,max)`, `ui.toggle(name,label)` | inputs |
| `ui.fileInput(name, {accept, capture, label})` | evidence upload; the payload gets a `media://` ref (§14.6) |
| `ui.submit(label, {payload, size, tone})` | submit button; `payload` is merged into the form fields |
| `ui.stopwatch(name, {hideAfterSeconds})`, `ui.quickRounds(name, runId, rounds, secondsPerRound)` | timed on the phone (see live actions) |
| `ui.spool(parts, entries, index)` | presentation slides: entries rolling through a sentence's blanks |

Inputs are collected by `name` into one payload object; that object is what your
`validateInput`/`handleInput` receive as `Input`. A `guestView` returns
`{ ui, canSubmit, status? }`.

## 5. Testing

Call your module's functions directly with a fake context (see
`challenges/closest-number/test` and `challenges/caption-this/test`), or drive it through
the engine like `packages/engine/test/lifecycle.test.ts`. Run `npm test`.

## 6. Checklist

- [ ] `manifest.json` and `server/index.ts` agree on `id` and `version`; `apiVersion` is `"2"`
- [ ] every capability used is declared; `evaluation.criteria` set for non-automatic modes
- [ ] time limit scheduled in `onAttemptStart` with `player.id`, and the player's previous attempt data cleared there (replays)
- [ ] `guestView` shows only the current player's data; `mainView` leaks nothing
- [ ] `evaluate` handles one submission (`immediate`) or all (`onClose`) — check `submissions.length`
- [ ] `calculateScores` only returns players from `ctx.players()`
- [ ] `npm run typecheck` and `npm test` pass
