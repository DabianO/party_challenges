/**
 * Fill in the Blanks (contract v2, automatic, `results: "immediate"`).
 *
 * The host writes sentences with blanks (`___`); every player fills them in however they like
 * and submits once. There is no right answer: every completed sentence earns
 * `pointsPerSentence`. Players choose whether their name goes with their entries (it does
 * unless they tick "anonymous"). Once closed, the host can show the results on the big screen
 * (`presentation`): one slide per sentence, with everyone's entries rolling through its blanks
 * (`ui.spool`), one entry per step.
 *
 * While it is open, the big screen shows one completed sentence at a time (`displayPanel`):
 * the first as soon as it comes in, then every minute the next one that was added since. When
 * nothing new came in, it stays on the last one.
 */
import { defineModule, ui, type Manifest, type PlayerRef, type PresentationSlide, type UINode } from '@challenge/contract';
import manifestJson from '../manifest.json' with { type: 'json' };
import schemaJson from '../config.schema.json' with { type: 'json' };

interface Config {
  sentences: { text: string }[];
  pointsPerSentence: number;
  timeLimit: number;
  showNames: boolean;
}

interface State {
  config: Config;
  /** playerId → their words, per sentence per blank ('' = left empty). */
  entries: Record<string, string[][]>;
  /** playerId → true when they chose to stay anonymous (absent before 1.1). */
  anonymous?: Record<string, boolean>;
  /** Every completed sentence in the order it came in, for the big screen (absent before 1.2). */
  feed?: { playerId: string; sentence: number }[];
  /** Index into `feed` of the sentence on the big screen now; null before the first. */
  shown?: number | null;
  /** The challenge is open (the big screen shows the feed). */
  open?: boolean;
}

/** Flat form payload: `s<sentence>b<blank>` → words, and `anonymous` (the player's choice). */
type Input = Record<string, unknown>;

/** Payload key of the player's choice to leave their name off. */
const ANONYMOUS = 'anonymous';

interface Evaluation {
  playerId: string;
  displayName: string;
  blanks: string[][];
  completed: number;
  points: number;
  /** The player chose to leave their name off (absent before 1.1). */
  anonymous?: boolean;
}

const MAX_WORDS = 40;
const MAX_BLANKS = 6;
const BLANK = /_{3,}/;
/** How long each entry stays in the presentation while it plays by itself. */
const ENTRY_SECONDS = 4;
/** The big screen moves on to the next new sentence this often (not when nothing new came in). */
const FEED_SECONDS = 60;
const FEED_TIMER = 'feed';

/** The text around the blanks: a blank between every two parts. A sentence without `___` gets its blank at the end. */
function partsOf(text: string): string[] {
  const parts = text.split(BLANK);
  if (parts.length === 1) return [`${text.trimEnd()} `, ''];
  // More blanks than allowed: the rest stay as they were written.
  return parts.length - 1 > MAX_BLANKS ? [...parts.slice(0, MAX_BLANKS), parts.slice(MAX_BLANKS).join('___')] : parts;
}

function sentencesOf(config: Config): string[][] {
  return config.sentences.map((s) => partsOf(s.text));
}

const field = (sentence: number, blank: number) => `s${sentence}b${blank}`;

function clean(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

const complete = (words: string[] | undefined): words is string[] => words !== undefined && words.length > 0 && words.every((w) => w !== '');

/** The sentence with the blanks filled in (or shown as ___). */
function filled(parts: string[], words?: string[]): string {
  return parts.map((p, i) => (i < parts.length - 1 ? `${p}${words?.[i] || '___'}` : p)).join('').trim();
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function nameOf(players: PlayerRef[], id: string): string {
  return players.find((p) => p.id === id)?.displayName ?? 'Unknown';
}

/** The words a payload holds, per sentence per blank. */
function wordsOf(state: State, input: Input): string[][] {
  return sentencesOf(state.config).map((parts, i) => Array.from({ length: parts.length - 1 }, (_, j) => clean(input[field(i, j)])));
}

export default defineModule<Config, State, Input, Evaluation>({
  manifest: manifestJson as unknown as Manifest,
  configurationSchema: schemaJson,

  createInstance(config) {
    return { config, entries: {}, feed: [], shown: null };
  },

  onPhaseChange(state, phase, ctx) {
    if (phase === 'ACTIVE') {
      ctx.schedule(FEED_TIMER, FEED_SECONDS);
      return { ...state, open: true };
    }
    ctx.cancel(FEED_TIMER);
    return { ...state, open: false };
  },

  onTimer(state, tag, ctx) {
    if (tag !== FEED_TIMER) return state;
    ctx.schedule(FEED_TIMER, FEED_SECONDS);
    const feed = state.feed ?? [];
    const shown = state.shown ?? null;
    // On to the next sentence that came in since; nothing new: stay.
    return shown !== null && shown < feed.length - 1 ? { ...state, shown: shown + 1 } : state;
  },

  onAttemptStart(state, player, ctx) {
    if (state.config.timeLimit > 0) ctx.schedule('lock', state.config.timeLimit, player.id); // 0 = no time limit
    const { [player.id]: _previous, ...entries } = state.entries;
    return { ...state, entries };
  },

  validateInput(state, _player, input) {
    if (!input || typeof input !== 'object') return { ok: false, reason: 'Fill in at least one sentence' };
    const { [ANONYMOUS]: anonymous, ...answers } = input;
    if (anonymous !== undefined && typeof anonymous !== 'boolean') return { ok: false, reason: 'Choose whether to stay anonymous' };
    for (const value of Object.values(answers)) {
      if (value !== undefined && value !== null && typeof value !== 'string') return { ok: false, reason: 'Only words, please' };
      if (typeof value === 'string' && value.length > MAX_WORDS * 2) return { ok: false, reason: `At most ${MAX_WORDS} characters per blank` };
    }
    const words = wordsOf(state, input);
    if (words.some((w) => w.some((x) => x.length > MAX_WORDS))) return { ok: false, reason: `At most ${MAX_WORDS} characters per blank` };
    if (!words.some(complete)) return { ok: false, reason: 'Fill in every blank of at least one sentence' };
    return { ok: true };
  },

  handleInput(state, player, input) {
    const words = wordsOf(state, input);
    const feed = [...(state.feed ?? []), ...words.flatMap((w, sentence) => (complete(w) ? [{ playerId: player.id, sentence }] : []))];
    return {
      ...state,
      entries: { ...state.entries, [player.id]: words },
      anonymous: { ...state.anonymous, [player.id]: input[ANONYMOUS] === true },
      feed,
      // The very first sentence goes on the big screen at once.
      shown: (state.shown ?? null) === null && feed.length > 0 ? 0 : (state.shown ?? null),
    };
  },

  playerNote(state, player) {
    const mine = state.entries[player.id];
    if (!mine) return null;
    const filledIn = `${mine.filter(complete).length} of ${plural(mine.length, 'sentence')} filled in`;
    return state.anonymous?.[player.id] && state.config.showNames ? `${filledIn}, anonymously` : filledIn;
  },

  evaluate(state, submissions, ctx) {
    const s = submissions[0]!;
    const blanks = state.entries[s.playerId] ?? wordsOf(state, s.payload);
    const completed = blanks.filter(complete).length;
    return {
      playerId: s.playerId,
      displayName: nameOf(ctx.players(), s.playerId),
      blanks,
      completed,
      points: completed * state.config.pointsPerSentence,
      anonymous: state.anonymous?.[s.playerId] ?? s.payload[ANONYMOUS] === true,
    };
  },

  calculateScores(_state, e) {
    return [{ playerId: e.playerId, points: e.points, reason: `${plural(e.completed, 'sentence')} filled in` }];
  },

  getStatistics(state, evaluations) {
    const sentences = sentencesOf(state.config);
    return {
      players: evaluations.length,
      sentences: sentences.length,
      completed: evaluations.reduce((n, e) => n + e.completed, 0),
      perSentence: sentences.map((_, i) => evaluations.filter((e) => complete(e.blanks[i])).length),
    };
  },

  introView(state) {
    const c = state.config;
    const n = c.sentences.length;
    return ui.stack(
      [
        ui.text(`Fill in the blanks of ${n === 1 ? 'a sentence' : `${n} sentences`}, however you like: there is no right answer.`),
        ui.caption(
          `${c.pointsPerSentence > 0 ? `${plural(c.pointsPerSentence, 'point')} for every sentence you complete. ` : ''}${c.timeLimit > 0 ? `You have ${c.timeLimit} seconds. ` : ''}You submit once, so make them good: they may end up on the big screen.`,
        ),
      ],
      { gap: 'sm' },
    );
  },

  guestView(state) {
    const c = state.config;
    const cards: UINode[] = sentencesOf(c).map((parts, i) => {
      const blanks = parts.length - 1;
      const numbered = blanks > 1 ? parts.map((p, j) => (j < blanks ? `${p}___(${j + 1})` : p)).join('') : filled(parts);
      return ui.card([
        ui.caption(`Sentence ${i + 1} of ${c.sentences.length}`),
        ui.text(numbered.trim(), { variant: 'subtitle' }),
        ...Array.from({ length: blanks }, (_, j) =>
          ui.textInput(field(i, j), { label: blanks > 1 ? `Blank ${j + 1}` : 'Your words', maxLength: MAX_WORDS, placeholder: blanks > 1 ? `Words for blank ${j + 1}` : 'Fill in the blank' }),
        ),
      ]);
    });
    // Clearly offered, off by default: names go with the entries unless the player says otherwise.
    const name = c.showNames
      ? [
          ui.card(
            [
              ui.toggle(ANONYMOUS, 'Stay anonymous', { value: false }),
              ui.caption('Your name is shown with your sentences on the big screen. Switch this on to leave it off.'),
            ],
            'primary',
          ),
        ]
      : [];
    return {
      ui: ui.stack([...(c.timeLimit > 0 ? [ui.timer('lock')] : []), ...name, ...cards, ui.submit(c.sentences.length > 1 ? 'Submit my sentences' : 'Submit', { size: 'lg' })], {
        gap: 'md',
        align: 'stretch',
      }),
      canSubmit: true,
      status: 'Fill in the blanks, then submit once',
    };
  },

  mainView(state) {
    return ui.caption(`${plural(state.config.sentences.length, 'sentence')} to complete: the funnier, the better.`);
  },

  displayPanel(state, ctx) {
    if (!state.open) return null;
    const feed = (state.feed ?? []).filter((f) => complete(state.entries[f.playerId]?.[f.sentence]));
    const shown = Math.min(state.shown ?? 0, feed.length - 1);
    const current = feed[shown];
    if (!current) return ui.caption('Everyone’s sentences appear here as they come in.', { align: 'center' });
    // That sentence's entries shown so far, so a next one for the same sentence rolls in.
    const parts = sentencesOf(state.config)[current.sentence]!;
    const names = new Map(ctx.players().map((p) => [p.id, p.displayName]));
    const entries = feed
      .slice(0, shown + 1)
      .filter((f) => f.sentence === current.sentence)
      .map((f) => {
        const name = state.config.showNames && !state.anonymous?.[f.playerId] ? names.get(f.playerId) : undefined;
        return { blanks: state.entries[f.playerId]![f.sentence]!, ...(name ? { by: name } : {}) };
      });
    return ui.stack([ui.spool(parts, entries, entries.length - 1), ui.caption(`${plural(feed.length, 'sentence')} so far`, { align: 'center' })], {
      gap: 'md',
      align: 'center',
      justify: 'center',
    });
  },

  presentation(state, evaluations): PresentationSlide[] {
    const sentences = sentencesOf(state.config);
    const slides: PresentationSlide[] = [];
    sentences.forEach((parts, i) => {
      const entries = evaluations
        .filter((e) => complete(e.blanks[i]))
        .map((e) => ({ blanks: e.blanks[i]!, ...(state.config.showNames && !e.anonymous ? { by: e.displayName } : {}) }));
      if (entries.length === 0) return;
      slides.push({
        caption: sentences.length > 1 ? `Sentence ${i + 1} of ${sentences.length}` : undefined,
        steps: entries.map((_, k) => ui.spool(parts, entries, k)),
        stepSeconds: ENTRY_SECONDS,
      });
    });
    return slides;
  },

  resultsView(state, evaluations) {
    const sentences = sentencesOf(state.config);
    const showNames = state.config.showNames;
    const section = (parts: string[], i: number, mine?: string) =>
      ui.stack(
        [
          ui.subtitle(filled(parts)),
          ui.list(
            evaluations
              .filter((e) => complete(e.blanks[i]))
              .map((e) => ({ label: filled(parts, e.blanks[i]), value: showNames ? (e.anonymous ? 'Anonymous' : e.displayName) : undefined, highlight: e.playerId === mine })),
          ),
        ],
        { gap: 'sm' },
      );
    return {
      ui: ui.stack(sentences.map((parts, i) => section(parts, i)), { gap: 'lg', align: 'stretch' }),
      guestUi: (player) => {
        const me = evaluations.find((e) => e.playerId === player.id);
        const head: UINode = me
          ? ui.card([ui.text(`You completed ${plural(me.completed, 'sentence')}: +${me.points} points`, { align: 'center' })], 'success')
          : ui.badge('You did not play this one', 'muted');
        return ui.stack([head, ...sentences.map((parts, i) => section(parts, i, player.id))], { gap: 'lg', align: 'stretch' });
      },
    };
  },
});
