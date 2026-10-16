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
questions: each player opens a challenge from their board whenever they like, presses
**Start**, plays it at their own pace (with their own timers) and submits. This is an
**attempt**; one attempt per player per instance. The engine evaluates submissions
(§14) and writes scores to the ledger. The main display shows the leaderboard, activity
and statistics, not a shared question.

Consequences for module code:

- Instance state is **shared** by all players. Keep per-player data keyed by
  `player.id` (e.g. `guesses[player.id]`).
- Timers are **per player** when passed a `playerId`: `ctx.schedule('lock', 30, player.id)`.
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
| `id`, `version` | kebab-case id; `id@version` identifies a build; games pin the exact version. |
| `apiVersion` | Must be `"2"`. The loader refuses anything else. |
| `category` | `knowledge`, `skill`, `social`, `memory`, `chaos`, `other`. |
| `evaluation.mode` | `automatic` (your `evaluate()` decides), `peer` (another player approves/rejects), `host` (host queue), `hybrid` (peers first, rejections go to the host). |
| `evaluation.supportedModes` | Every mode the module can run in. Hosts may pick any of these per game or per instance (FR-70). Defaults to `[mode]`. |
| `evaluation.criteria` | Required for non-automatic modes: what a judge should check (MR-17). |
| `evaluation.evidence` | Which payload field judges look at: `kind` `text`, `number`, `image`, `video`, `audio` or `none`. Used for the generic judging screen when you do not implement `presentSubmission`. |
| `evaluation.hostScoring` | Optional `{min,max,step}`; when set the host may enter points instead of approve/reject. The value arrives in `judgement.points`. |
| `evaluation.deadlineSeconds` | Optional per-module override of the judge deadline. |
| `results` | `immediate` — each submission is evaluated on its own as soon as the attempt locks (after judging). `onClose` — evaluation runs once over all submissions when the host closes the challenge (ranking, votes, predictions). `onClose` modules must be `automatic`. |
| `resubmission` | `none` (default: submitting locks the attempt) or `replace` (players can change their answer until their timer fires or they press Finish). |
| `capabilities` | Declare everything you use (`timer`, `image`, `text-input`, `numeric-input`, `multiple-choice`, `evidence-upload`, `statistics`, …). |

## 2. config.schema.json

Standard JSON Schema (draft-07 subset). The host UI renders a form from it; the server
validates against it and applies `default`s (MR-7). Supported field types in the form
generator: `string` (with optional `enum`, `maxLength`, `format: "media-ref"` for image
upload), `number`/`integer` (with `minimum`/`maximum`), `boolean`, and `array` of
`string` or of flat `object`s. Use `title` and `description` for labels and help text.

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
  validateInput(state, player, input, ctx) { ... },
  handleInput(state, player, input, ctx) { ... },
  evaluate(state, submissions, ctx) { ... },
  calculateScores(state, evaluation, ctx) { ... },
  getStatistics(state, evaluations, ctx) { ... },
  introView(state, player, ctx) { ... },         // optional: instructions before Start
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
2. **`onAttemptStart(state, player, ctx)`** runs when a player presses Start. Schedule
   their time limit: `ctx.schedule('lock', state.config.timeLimit, player.id)`. You can
   schedule other per-player timers (`'go'`, `'hide'`, …) and react in
   `onTimer(state, tag, ctx, playerId)`.
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
   (`onClose`: one). Return `{ ui, guestUi?(player) }`; `guestUi` is the personal result
   a player sees right after scoring, `ui` is shown on the display when the instance
   reaches `RESULTS`. `getStatistics(state, evaluations)` gets the same array.

### Rules

- **Deterministic** (MR-11): use `ctx.rng()` and `ctx.now()`, never `Math.random()` or `Date.now()`.
- **State is JSON**: no classes, `Map`s, `Set`s or functions in `State`/`Evaluation`.
- **Return new state**; don't rely on mutation being observed.
- **Never implement judging yourself** (MR-18): no queues, deadlines, or judge picking.
  Declare `criteria`/`evidence` and map judgements to points.
- `submission.startedAt` (attempt start) and `submission.submittedAt` are server times:
  use them for speed bonuses and reaction timing (SR-5). Client-reported times are advisory.
- Player names come from `ctx.players()`; store `displayName` in evaluation rows so
  `resultsView` can render without a roster lookup.
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
- [ ] time limit scheduled in `onAttemptStart` with `player.id`
- [ ] `guestView` shows only the current player's data; `mainView` leaks nothing
- [ ] `evaluate` handles one submission (`immediate`) or all (`onClose`) — check `submissions.length`
- [ ] `calculateScores` only returns players from `ctx.players()`
- [ ] `npm run typecheck` and `npm test` pass
