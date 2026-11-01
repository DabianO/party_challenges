/**
 * Color Match (contract v2): the Stroop test.
 *
 * Every round shows a colour word written in another colour ("BLUE" in red); the player taps
 * the colour of the letters before the round's time runs out. Each try, the player picks one
 * of three levels (more colours, less time, more points per correct tap). The rounds are
 * played on the phone (`ui.quickRounds`), so the network adds no delay between them: a level's
 * start button asks this module to deal a fresh set of words (`onAction`), the phone plays them
 * and submits every answer with its time at the end.
 *
 * Every deal differs from all earlier ones of that player, so a replay never repeats the same
 * words in the same order. The server also checks the whole try took no longer than the
 * rounds allow (a phone cannot pause the clock by going to the background).
 */
import { defineModule, ui, type InstanceContext, type Manifest, type PlayerRef, type QuickRound, type UINode } from '@challenge/contract';
import manifestJson from '../manifest.json' with { type: 'json' };
import schemaJson from '../config.schema.json' with { type: 'json' };

interface Level {
  colors: number;
  secondsPerRound: number;
  pointsPerCorrect: number;
}

interface Config {
  rounds: number;
  /** Exactly three (absent in games made with 1.0: the default levels). */
  levels?: Level[];
}

/** One round: the word and the colour of its letters (indexes into COLORS). */
interface Deal {
  word: number;
  ink: number;
}

interface Run {
  runId: string;
  /** Server time the words were dealt (just before the phone's countdown). */
  dealtAt: number;
  deals: Deal[];
  /** Index into the levels (absent before 1.1: the first). */
  level?: number;
}

interface Score {
  correct: number;
  rounds: number;
  /** Average time of the correct taps, ms (null without any). */
  avgMs: number | null;
  /** Absent before 1.1. */
  level?: number;
  points?: number;
}

interface State {
  config: Config;
  /** playerId → the words they are playing now. */
  runs: Record<string, Run>;
  /** playerId → every deal they had so far, as text (a new deal must differ from all of them). */
  dealt: Record<string, string[]>;
  /** Deals so far, for unique run ids. */
  count: number;
  /** playerId → their latest and best try, for practice feedback. */
  last: Record<string, Score>;
  best: Record<string, Score>;
}

interface Answer {
  choice: string | null;
  ms: number;
}

interface Input {
  colors: { runId: string; answers: Answer[] };
}

/** One evaluation per try (results: immediate). */
interface Evaluation {
  playerId: string;
  displayName: string;
  /** 1, 2 or 3 (absent before 1.1: level 1). */
  level?: number;
  correct: number;
  wrong: number;
  missed: number;
  rounds: number;
  avgMs: number | null;
  /** The try took longer than the rounds allow (timed by the server): it does not count. */
  tooSlow: boolean;
  points: number;
}

/** Payload key of the quick rounds (start action and answers). */
const NAME = 'colors';

const COLORS = [
  { id: 'red', label: 'Red', word: 'RED', hex: '#ef4444' },
  { id: 'blue', label: 'Blue', word: 'BLUE', hex: '#3b82f6' },
  { id: 'green', label: 'Green', word: 'GREEN', hex: '#22c55e' },
  { id: 'yellow', label: 'Yellow', word: 'YELLOW', hex: '#facc15' },
  { id: 'purple', label: 'Purple', word: 'PURPLE', hex: '#a855f7' },
  { id: 'orange', label: 'Orange', word: 'ORANGE', hex: '#f97316' },
];

export const DEFAULT_LEVELS: Level[] = [
  { colors: 4, secondsPerRound: 1.5, pointsPerCorrect: 1 },
  { colors: 5, secondsPerRound: 1, pointsPerCorrect: 2 },
  { colors: 6, secondsPerRound: 0.75, pointsPerCorrect: 3 },
];

/** The phone's countdown before the first round, and the most it pauses between rounds. */
const COUNTDOWN_MS = 3000;
const GAP_MS = 250;
/** Network and rendering on top of that (the deal reaching the phone, the answers coming back). */
const SLACK_MS = 5000;
/** A new deal tries this often to differ from every earlier one (it practically always does at once). */
const DEAL_TRIES = 50;

function levelsOf(config: Config): Level[] {
  const levels = Array.isArray(config.levels) && config.levels.length > 0 ? config.levels : DEFAULT_LEVELS;
  return levels.slice(0, 3);
}

function levelOf(config: Config, index: number | undefined): Level {
  const levels = levelsOf(config);
  return levels[Math.min(levels.length - 1, Math.max(0, index ?? 0))]!;
}

function colorsOf(level: Level): typeof COLORS {
  return COLORS.slice(0, Math.min(COLORS.length, Math.max(2, Math.round(level.colors))));
}

function limitMs(level: Level): number {
  return Math.round(level.secondsPerRound * 1000);
}

function nameOf(players: PlayerRef[], id: string): string {
  return players.find((p) => p.id === id)?.displayName ?? 'Unknown';
}

/** "1.5 s", "0.75 s". */
function seconds(s: number): string {
  return `${Number(s.toFixed(2))} s`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** What a level means, e.g. "4 colours · 1.5 s per word · 1 point per correct tap". */
function levelText(level: Level): string {
  return `${level.colors} colours · ${seconds(level.secondsPerRound)} per word · ${plural(level.pointsPerCorrect, 'point')} per correct tap`;
}

function pick(n: number, ctx: InstanceContext, not: number[]): number {
  const options = Array.from({ length: n }, (_, i) => i).filter((i) => !not.includes(i));
  return options[Math.min(options.length - 1, Math.floor(ctx.rng() * options.length))]!;
}

/**
 * A fresh set of rounds: the word never matches its own colour, and neither the word nor the
 * colour repeats straight after itself (with three colours that would leave no choice).
 */
function deal(rounds: number, level: Level, ctx: InstanceContext): Deal[] {
  const n = colorsOf(level).length;
  const out: Deal[] = [];
  for (let i = 0; i < rounds; i++) {
    const prev = out[i - 1];
    const ink = pick(n, ctx, n > 3 && prev ? [prev.ink] : []);
    const word = pick(n, ctx, n > 3 && prev ? [ink, prev.word] : [ink]);
    out.push({ word, ink });
  }
  return out;
}

const signature = (deals: Deal[]) => deals.map((d) => `${d.word}${d.ink}`).join('.');

function roundsOf(level: Level, deals: Deal[]): QuickRound[] {
  const colors = colorsOf(level);
  const options = colors.map((c) => ({ id: c.id, label: c.label }));
  return deals.map((d) => ({ prompt: { text: colors[d.word]!.word, color: colors[d.ink]!.hex }, options }));
}

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(2)} s`;
}

function scoreText(s: Score): string {
  return `Level ${(s.level ?? 0) + 1}: ${s.correct} of ${s.rounds} right${s.avgMs === null ? '' : ` · ${secs(s.avgMs)} per word`}`;
}

/** More points is better; on a tie, faster. */
function better(a: Score, b: Score | undefined): boolean {
  if (!b) return true;
  const pa = a.points ?? a.correct;
  const pb = b.points ?? b.correct;
  if (pa !== pb) return pa > pb;
  return (a.avgMs ?? Infinity) < (b.avgMs ?? Infinity);
}

/** Score the answers against the deal. */
function score(level: Level, deals: Deal[], answers: Answer[]): { correct: number; wrong: number; missed: number; rounds: number; avgMs: number | null } {
  const colors = colorsOf(level);
  const limit = limitMs(level);
  let correct = 0;
  let wrong = 0;
  let missed = 0;
  let time = 0;
  deals.forEach((d, i) => {
    const a = answers[i];
    if (!a || a.choice === null || a.ms >= limit) missed++;
    else if (a.choice === colors[d.ink]!.id) {
      correct++;
      time += a.ms;
    } else wrong++;
  });
  return { correct, wrong, missed, rounds: deals.length, avgMs: correct ? Math.round(time / correct) : null };
}

function isAnswers(value: unknown, rounds: number, limit: number): value is Answer[] {
  return (
    Array.isArray(value) &&
    value.length === rounds &&
    value.every(
      (a) =>
        a !== null &&
        typeof a === 'object' &&
        (a.choice === null || typeof a.choice === 'string') &&
        typeof a.ms === 'number' &&
        Number.isFinite(a.ms) &&
        a.ms >= 0 &&
        a.ms <= limit,
    )
  );
}

/** The level a start action asks for: `choice` "1", "2" or "3" (none: level 1). */
function chosenLevel(payload: unknown, config: Config): number | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (p[NAME] !== 'start') return null;
  if (p.choice === undefined) return 0;
  const n = typeof p.choice === 'string' ? Number(p.choice) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= levelsOf(config).length ? n - 1 : null;
}

export default defineModule<Config, State, Input, Evaluation>({
  manifest: manifestJson as unknown as Manifest,
  configurationSchema: schemaJson,

  createInstance(config) {
    return { config, runs: {}, dealt: {}, count: 0, last: {}, best: {} };
  },

  onAttemptStart(state, player) {
    // Every try (also a replay) starts at the level buttons, without words.
    const { [player.id]: _run, ...runs } = state.runs;
    return { ...state, runs };
  },

  validateAction(state, _player, payload) {
    return chosenLevel(payload, state.config) === null ? { ok: false, reason: 'Pick a level' } : { ok: true };
  },

  onAction(state, player, payload, ctx) {
    // Start (again, after a reload): new words, never a set this player had before.
    const index = chosenLevel(payload, state.config) ?? 0;
    const level = levelOf(state.config, index);
    const seen = new Set(state.dealt[player.id] ?? []);
    let deals = deal(state.config.rounds, level, ctx);
    for (let i = 1; i < DEAL_TRIES && seen.has(signature(deals)); i++) deals = deal(state.config.rounds, level, ctx);
    const count = state.count + 1;
    return {
      ...state,
      count,
      runs: { ...state.runs, [player.id]: { runId: `r${count}`, dealtAt: ctx.now(), deals, level: index } },
      dealt: { ...state.dealt, [player.id]: [...seen, signature(deals)] },
    };
  },

  validateInput(state, player, input) {
    const run = state.runs[player.id];
    const value = input && typeof input === 'object' ? (input as { colors?: unknown }).colors : undefined;
    if (!run || !value || typeof value !== 'object') return { ok: false, reason: 'Pick a level to play' };
    const { runId, answers } = value as { runId?: unknown; answers?: unknown };
    if (runId !== run.runId) return { ok: false, reason: 'These answers belong to an older try: start again' };
    if (!isAnswers(answers, run.deals.length, limitMs(levelOf(state.config, run.level)))) return { ok: false, reason: 'Those answers could not be read: start again' };
    return { ok: true };
  },

  handleInput(state, player, input) {
    // Practice feedback (playerNote); the evaluation decides what counts.
    const run = state.runs[player.id]!;
    const level = levelOf(state.config, run.level);
    const s = score(level, run.deals, input.colors.answers);
    const mine: Score = { correct: s.correct, rounds: s.rounds, avgMs: s.avgMs, level: run.level ?? 0, points: s.correct * level.pointsPerCorrect };
    return {
      ...state,
      last: { ...state.last, [player.id]: mine },
      best: better(mine, state.best[player.id]) ? { ...state.best, [player.id]: mine } : state.best,
    };
  },

  playerNote(state, player) {
    const last = state.last[player.id];
    if (!last) return null;
    const best = state.best[player.id];
    return best && best !== last && better(best, last) ? `${scoreText(last)} · best ${plural(best.points ?? best.correct, 'point')}` : scoreText(last);
  },

  evaluate(state, submissions, ctx) {
    // Immediate results: exactly one submission, this player's try.
    const s = submissions[0]!;
    const run = state.runs[s.playerId];
    const c = state.config;
    const level = levelOf(c, run?.level);
    const answers = s.payload.colors.answers;
    const result = run ? score(level, run.deals, answers) : { correct: 0, wrong: 0, missed: c.rounds, rounds: c.rounds, avgMs: null };
    // The whole try, as the server saw it: from the deal to the answers arriving.
    const allowed = COUNTDOWN_MS + c.rounds * (limitMs(level) + GAP_MS) + SLACK_MS;
    const tooSlow = run !== undefined && s.submittedAt - run.dealtAt > allowed;
    return {
      playerId: s.playerId,
      displayName: nameOf(ctx.players(), s.playerId),
      level: (run?.level ?? 0) + 1,
      ...result,
      tooSlow,
      points: tooSlow ? 0 : result.correct * level.pointsPerCorrect,
    };
  },

  calculateScores(_state, e) {
    const reason = e.tooSlow ? 'The try took longer than the words allow (paused?)' : `Level ${e.level ?? 1}: ${e.correct} of ${e.rounds} colours right`;
    return [{ playerId: e.playerId, points: e.points, reason }];
  },

  getStatistics(state, evaluations) {
    const counted = evaluations.filter((e) => !e.tooSlow);
    const ranked = [...counted].sort((a, b) => b.points - a.points || (a.avgMs ?? Infinity) - (b.avgMs ?? Infinity));
    const sum = (f: (e: Evaluation) => number) => counted.reduce((n, e) => n + f(e), 0);
    return {
      tries: evaluations.length,
      perfect: counted.filter((e) => e.correct === e.rounds).length,
      averageCorrect: counted.length ? Math.round((sum((e) => e.correct) / counted.length) * 10) / 10 : null,
      wrong: sum((e) => e.wrong),
      missed: sum((e) => e.missed),
      byLevel: levelsOf(state.config).map((_, i) => counted.filter((e) => (e.level ?? 1) === i + 1).length),
      best: ranked[0] ? { name: ranked[0].displayName, level: ranked[0].level ?? 1, correct: ranked[0].correct, avgMs: ranked[0].avgMs } : null,
      tooSlow: evaluations.length - counted.length,
    };
  },

  introView(state) {
    const levels = levelsOf(state.config);
    return ui.stack(
      [
        ui.text('A colour word appears in another colour, e.g. BLUE written in red. Tap the colour of the letters, not the word!'),
        ui.caption(`${plural(state.config.rounds, 'word')} per try. Pick your level each time you play:`),
        ui.list(levels.map((l, i) => ({ label: `Level ${i + 1}`, value: levelText(l) }))),
      ],
      { gap: 'sm' },
    );
  },

  guestView(state, player) {
    const c = state.config;
    const run = state.runs[player.id];
    const levels = levelsOf(c);
    const level = levelOf(c, run?.level);
    return {
      ui: ui.stack(
        [
          ui.card([ui.text('Tap the colour of the letters, not the word', { align: 'center' })], 'primary'),
          ui.quickRounds(NAME, run?.runId ?? null, run ? roundsOf(level, run.deals) : [], level.secondsPerRound, {
            choices: levels.map((l, i) => ({ id: String(i + 1), label: `Level ${i + 1}`, detail: levelText(l) })),
          }),
        ],
        { gap: 'md', align: 'stretch' },
      ),
      canSubmit: true,
      status: run ? `Level ${(run.level ?? 0) + 1} · ${plural(c.rounds, 'word')}` : `Pick a level · ${plural(c.rounds, 'word')}`,
    };
  },

  mainView() {
    return ui.caption('Tap the colour of the letters, not the word!');
  },

  resultsView(_state, evaluations) {
    const sorted = [...evaluations].sort(
      (a, b) => Number(a.tooSlow) - Number(b.tooSlow) || b.points - a.points || b.correct - a.correct || (a.avgMs ?? Infinity) - (b.avgMs ?? Infinity),
    );
    const value = (e: Evaluation) =>
      e.tooSlow ? 'too slow (paused)' : `L${e.level ?? 1} · ${e.correct}/${e.rounds}${e.avgMs === null ? '' : ` · ${secs(e.avgMs)}`}`;
    const rankOf = (id: string) => sorted.findIndex((e) => e.playerId === id) + 1;
    const perfect = evaluations.filter((e) => !e.tooSlow && e.correct === e.rounds).length;
    const badges = ui.row(
      [ui.badge(plural(evaluations.length, 'player')), ui.badge(`${perfect} perfect`, perfect ? 'success' : 'muted')],
      { gap: 'sm', wrap: true, justify: 'center' },
    );
    const shared = ui.stack(
      [
        sorted.length
          ? ui.ranking(sorted.map((e, i) => ({ rank: i + 1, name: e.displayName, value: value(e), points: e.points, highlight: i === 0 })))
          : ui.caption('Nobody has played yet.', { align: 'center' }),
        badges,
      ],
      { gap: 'md', align: 'stretch' },
    );
    return {
      ui: shared,
      guestUi: (player) => {
        const me = evaluations.find((e) => e.playerId === player.id);
        const mine: UINode = me
          ? ui.card(
              [
                ui.display(`${me.correct}/${me.rounds}`),
                ui.text(
                  me.tooSlow
                    ? 'Your try took longer than the words allow, so it did not count.'
                    : `Level ${me.level ?? 1}${me.avgMs === null ? ' · no correct taps' : ` · ${secs(me.avgMs)} per correct tap`}`,
                ),
                ui.text(`${me.points} points · #${rankOf(me.playerId)} of ${sorted.length}`, { tone: 'muted' }),
              ],
              rankOf(me.playerId) === 1 ? 'success' : 'primary',
            )
          : ui.badge('You did not play this one', 'muted');
        return ui.stack(
          [mine, ui.ranking(sorted.slice(0, 5).map((e, i) => ({ rank: i + 1, name: e.displayName, value: value(e), points: e.points, highlight: e.playerId === player.id })))],
          { gap: 'md' },
        );
      },
    };
  },
});
