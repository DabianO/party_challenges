/**
 * Secret Word (contract v2).
 *
 * Every player gets a secret word to slip into a conversation without the other person
 * noticing. Players judge themselves: they come back and say whether it worked, and only
 * then do they get their next word. Each player gets `maxPoints / pointsPerWord` words;
 * every word that slipped by unnoticed earns `pointsPerWord`.
 *
 * Every word is its own attempt (`attempts: "repeat"`): the engine scores each answer on its
 * own and adds the points up, so nothing is lost when the host closes the challenge while a
 * player is still waiting for the right moment. An unanswered word stays in progress, so the
 * player can go back to the board, play other challenges and return to it later.
 *
 * No two players get the same word while the list lasts. Built-in words come with their Dutch
 * translation in brackets (`words.nl.json`).
 */
import { defineModule, ui, type InstanceContext, type Manifest, type PlayerRef, type UINode } from '@challenge/contract';
import manifestJson from '../manifest.json' with { type: 'json' };
import schemaJson from '../config.schema.json' with { type: 'json' };
import wordsJson from '../words.json' with { type: 'json' };
import dutchJson from '../words.nl.json' with { type: 'json' };

interface Config {
  maxPoints: number;
  pointsPerWord: number;
  /** One per line or comma-separated. */
  customWords?: string;
  /** `replace` (default): only the host's words; `add`: theirs and the built-in list. */
  customWordsUse?: 'replace' | 'add';
  /** With `add`: the chance (0–100) that a new word comes from the host's words while some are left. */
  customWordsChance?: number;
}

interface Played {
  word: string;
  succeeded: boolean;
  at: number;
}

interface PlayerWords {
  /** The word handed out and not answered yet. */
  current: string | null;
  history: Played[];
}

interface State {
  config: Config;
  players: Record<string, PlayerWords>;
}

interface Input {
  /** The word the answer is about (must be the player's current word). */
  word: string;
  succeeded: boolean;
}

/** One evaluation per answered word (results: immediate). */
interface Evaluation {
  playerId: string;
  displayName: string;
  word: string;
  succeeded: boolean;
  points: number;
}

const BUILT_IN: string[] = wordsJson as string[];
const DUTCH: Record<string, string> = dutchJson as Record<string, string>;
const MAX_WORD_LENGTH = 40;

/** The Dutch for a built-in word (also when the host typed it themselves), unless it is the same word. */
export function dutchOf(word: string): string | null {
  const nl = DUTCH[word.toLowerCase()];
  return nl && nl.toLowerCase() !== word.toLowerCase() ? nl : null;
}

/** "aardvark (aardvarken)". */
function withDutch(word: string): string {
  const nl = dutchOf(word);
  return nl ? `${word} (${nl})` : word;
}

/** The host's own words, deduplicated case-insensitively (empty when there are none). */
function customOf(config: Config): string[] {
  const seen = new Set<string>();
  const custom: string[] = [];
  for (const raw of (config.customWords ?? '').split(/[\n,;]+/)) {
    const word = raw.trim().replace(/\s+/g, ' ').slice(0, MAX_WORD_LENGTH);
    const key = word.toLowerCase();
    if (!word || seen.has(key)) continue;
    seen.add(key);
    custom.push(word);
  }
  return custom;
}

/** Where words come from: the host's own, the built-in list, or both (see `pickWord`). */
function sourcesOf(config: Config): { custom: string[]; builtIn: boolean } {
  const custom = customOf(config);
  return { custom, builtIn: custom.length === 0 || config.customWordsUse === 'add' };
}

/** A random word from `pool` that nobody has had yet, or null. */
function freshFrom(pool: string[], used: Set<string>, ctx: InstanceContext): string | null {
  if (pool.length === 0) return null;
  const start = Math.floor(ctx.rng() * pool.length);
  for (let i = 0; i < pool.length; i++) {
    const word = pool[(start + i) % pool.length]!;
    if (!used.has(word.toLowerCase())) return word;
  }
  return null;
}

function pointsPerWordOf(config: Config): number {
  return Math.max(1, Math.min(config.pointsPerWord, config.maxPoints));
}

/** Words per player: as many as fit in the maximum (always at least one). */
function wordsPerPlayer(config: Config): number {
  return Math.max(1, Math.floor(config.maxPoints / pointsPerWordOf(config)));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function nameOf(players: PlayerRef[], id: string): string {
  return players.find((p) => p.id === id)?.displayName ?? 'Unknown';
}

function wordsOf(state: State, playerId: string): PlayerWords {
  return state.players[playerId] ?? { current: null, history: [] };
}

/**
 * A random word nobody has had yet. Together with the built-in list, the host's words come
 * first with their chance (`customWordsChance`) while any are left. When every word is taken
 * (a custom list that is too short), words are handed out again rather than leaving the
 * player without one.
 */
function pickWord(state: State, ctx: InstanceContext): string {
  const { custom, builtIn } = sourcesOf(state.config);
  const used = new Set<string>();
  for (const p of Object.values(state.players)) {
    if (p.current) used.add(p.current.toLowerCase());
    for (const h of p.history) used.add(h.word.toLowerCase());
  }
  if (!builtIn) return freshFrom(custom, used, ctx) ?? custom[Math.floor(ctx.rng() * custom.length)]!;
  const chance = Math.min(100, Math.max(0, state.config.customWordsChance ?? 50)) / 100;
  const mine = custom.length > 0 && ctx.rng() < chance ? freshFrom(custom, used, ctx) : null;
  return mine ?? freshFrom(BUILT_IN, used, ctx) ?? freshFrom(custom, used, ctx) ?? BUILT_IN[Math.floor(ctx.rng() * BUILT_IN.length)]!;
}

const HOW_TO = 'Slip it into a conversation without the other person noticing.';

export default defineModule<Config, State, Input, Evaluation>({
  manifest: manifestJson as unknown as Manifest,
  configurationSchema: schemaJson,

  createInstance(config) {
    return { config, players: {} };
  },

  canStart(state, player) {
    const mine = wordsOf(state, player.id);
    const total = wordsPerPlayer(state.config);
    // The tile's note already counts the words that worked.
    if (mine.history.length >= total) return { ok: false, reason: 'All your words are done', finished: true };
    return { ok: true, hint: `Get word ${mine.history.length + 1} of ${total}` };
  },

  onAttemptStart(state, player, ctx) {
    const mine = wordsOf(state, player.id);
    // A word that was never answered (the challenge closed in between) is kept.
    if (mine.current) return state;
    return { ...state, players: { ...state.players, [player.id]: { ...mine, current: pickWord(state, ctx) } } };
  },

  validateInput(state, player, input) {
    const mine = wordsOf(state, player.id);
    if (!input || typeof input !== 'object' || typeof (input as { succeeded?: unknown }).succeeded !== 'boolean') {
      return { ok: false, reason: 'Say whether it worked' };
    }
    if (!mine.current || input.word !== mine.current) return { ok: false, reason: 'That is not your current word' };
    return { ok: true };
  },

  handleInput(state, player, input, ctx) {
    const mine = wordsOf(state, player.id);
    const played: Played = { word: mine.current as string, succeeded: input.succeeded, at: ctx.now() };
    return { ...state, players: { ...state.players, [player.id]: { current: null, history: [...mine.history, played] } } };
  },

  playerNote(state, player) {
    const mine = wordsOf(state, player.id);
    if (mine.history.length === 0) return null;
    const won = mine.history.filter((h) => h.succeeded).length;
    return `${mine.history.length}/${wordsPerPlayer(state.config)} words · ${won} unnoticed`;
  },

  evaluate(state, submissions, ctx) {
    // Immediate results: exactly one submission, this player's answer about one word.
    const s = submissions[0]!;
    const succeeded = s.payload.succeeded === true;
    return {
      playerId: s.playerId,
      displayName: nameOf(ctx.players(), s.playerId),
      word: String(s.payload.word),
      succeeded,
      points: succeeded ? pointsPerWordOf(state.config) : 0,
    };
  },

  calculateScores(_state, evaluation) {
    const reason = evaluation.succeeded ? `Slipped “${evaluation.word}” in unnoticed` : `“${evaluation.word}” did not work out`;
    return [{ playerId: evaluation.playerId, points: evaluation.points, reason }];
  },

  getStatistics(_state, evaluations) {
    const succeeded = evaluations.filter((e) => e.succeeded).length;
    const byPlayer = new Map<string, { name: string; won: number }>();
    for (const e of evaluations) {
      const row = byPlayer.get(e.playerId) ?? { name: e.displayName, won: 0 };
      if (e.succeeded) row.won++;
      byPlayer.set(e.playerId, row);
    }
    const best = [...byPlayer.values()].sort((a, b) => b.won - a.won)[0];
    return {
      wordsPlayed: evaluations.length,
      succeeded,
      spotted: evaluations.length - succeeded,
      successRate: evaluations.length ? Math.round((succeeded / evaluations.length) * 100) : null,
      players: byPlayer.size,
      best: best && best.won > 0 ? { name: best.name, words: best.won } : null,
    };
  },

  introView(state) {
    const c = state.config;
    const total = wordsPerPlayer(c);
    const each = pointsPerWordOf(c);
    return ui.stack(
      [
        ui.text(`You get a secret word. ${HOW_TO} Then come back and say honestly whether it worked.`),
        ui.caption(
          `${plural(total, 'word')}, one at a time, ${plural(each, 'point')} for every word nobody noticed. Take your time: you can play other challenges while you wait for the right moment.`,
        ),
      ],
      { gap: 'sm' },
    );
  },

  guestView(state, player) {
    const mine = wordsOf(state, player.id);
    const total = wordsPerPlayer(state.config);
    if (!mine.current) {
      return { ui: ui.card([ui.title('No word right now'), ui.caption('Go back to the challenges and tap this one again.')]), canSubmit: false };
    }
    const word = mine.current;
    const number = mine.history.length + 1;
    return {
      ui: ui.stack(
        [
          ui.card(
            [
              ui.caption(`Your secret word · ${number} of ${total}`, { align: 'center' }),
              ui.display(word),
              ...(dutchOf(word) ? [ui.subtitle(`(${dutchOf(word)})`, { align: 'center' })] : []),
              ui.caption(HOW_TO, { align: 'center' }),
            ],
            'primary',
          ),
          ui.text('Did it work?', { align: 'center' }),
          ui.submit('✓ Yes, nobody noticed', { payload: { word, succeeded: true }, tone: 'success', size: 'lg' }),
          ui.submit('✗ No, I was caught or gave up', { payload: { word, succeeded: false }, tone: 'danger', size: 'lg' }),
          ui.caption('No rush: go ← Back to play other challenges. This word waits here until you answer.', { align: 'center' }),
        ],
        { gap: 'md', align: 'stretch' },
      ),
      canSubmit: true,
      status: `Word ${number} of ${total} · keep it secret!`,
    };
  },

  mainView() {
    return ui.caption('Everyone has secret words to slip into their conversations. Listen carefully!');
  },

  resultsView(state, evaluations) {
    const total = wordsPerPlayer(state.config);
    const rows = new Map<string, { name: string; won: string[]; played: number; points: number }>();
    for (const e of evaluations) {
      const row = rows.get(e.playerId) ?? { name: e.displayName, won: [], played: 0, points: 0 };
      row.played++;
      row.points += e.points;
      if (e.succeeded) row.won.push(e.word);
      rows.set(e.playerId, row);
    }
    const sorted = [...rows.entries()].sort(([, a], [, b]) => b.won.length - a.won.length || a.name.localeCompare(b.name));
    let rank = 0;
    let previous = -1;
    const ranking = ui.ranking(
      sorted.map(([, r], i) => {
        if (r.won.length !== previous) rank = i + 1;
        previous = r.won.length;
        return { rank, name: r.name, value: `${r.won.length} of ${r.played} unnoticed`, points: r.points, highlight: rank === 1 && r.won.length > 0 };
      }),
    );
    // The fun part afterwards: which words got past everyone.
    const slipped: UINode[] = sorted
      .filter(([, r]) => r.won.length > 0)
      .map(([, r]) => ui.text(`${r.name}: ${r.won.map(withDutch).join(', ')}`));
    const succeeded = evaluations.filter((e) => e.succeeded).length;
    const badges = ui.row(
      [ui.badge(plural(evaluations.length, 'word') + ' played'), ui.badge(`${succeeded} unnoticed`, succeeded ? 'success' : 'neutral'), ui.badge(`${evaluations.length - succeeded} spotted`)],
      { gap: 'sm', wrap: true, justify: 'center' },
    );
    const shared = ui.stack(
      [
        ui.title('Secret words', { align: 'center' }),
        evaluations.length ? ranking : ui.caption('Nobody has answered yet.', { align: 'center' }),
        ...(slipped.length ? [ui.subtitle('Slipped by unnoticed'), ...slipped] : []),
        badges,
      ],
      { gap: 'md', align: 'stretch' },
    );
    return {
      ui: shared,
      guestUi: (player) => {
        const mine = evaluations.filter((e) => e.playerId === player.id);
        const won = mine.filter((e) => e.succeeded);
        const summary: UINode = mine.length
          ? ui.card(
              [
                ui.display(`${won.length} of ${mine.length}`),
                ui.text(`words slipped by unnoticed (of ${total})`, { tone: 'muted' }),
                ...(won.length ? [ui.text(won.map((e) => withDutch(e.word)).join(', '))] : []),
              ],
              won.length ? 'success' : 'neutral',
            )
          : ui.badge('You did not play any words', 'muted');
        return ui.stack([summary, ranking, badges], { gap: 'md' });
      },
    };
  },
});
