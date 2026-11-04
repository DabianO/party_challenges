/**
 * Group Message (contract v2).
 *
 * The players write one message together, a few words at a time. The challenge is open to
 * one player at a time (their *turn*): they see the last words of the message and add up to
 * `wordsPerTurn` words, which earns `pointsPerTurn`. Then the turn moves to the next player.
 * A turn that is not used within `turnSeconds` moves on by itself. Each player contributes at
 * most `maxTurnsPerPlayer` times.
 *
 * The turn goes strictly round the group, whether or not a player's phone is connected right
 * now: a phone on stand-by gets its turn as soon as it wakes up, and when it does not wake up
 * in time, the turn moves on to the next in line. The big screen's top bar shows whose turn
 * it is (`displayBanner`), so players who put their phone away know when to pick it up.
 *
 * Every contribution is its own attempt (`attempts: "repeat"`): the engine scores each one
 * and adds the points up; `canStart` tells the engine whose turn it is.
 */
import { defineModule, ui, type BannerPart, type InstanceContext, type Manifest, type PlayerRef, type PresentationSlide, type UINode } from '@challenge/contract';
import manifestJson from '../manifest.json' with { type: 'json' };
import schemaJson from '../config.schema.json' with { type: 'json' };

interface Config {
  prompt: string;
  openingText?: string;
  wordsPerTurn: number;
  visibleWords: number;
  turnSeconds: number;
  maxTurnsPerPlayer: number;
  pointsPerTurn: number;
}

interface Contribution {
  playerId: string;
  displayName: string;
  text: string;
  at: number;
}

interface Turn {
  playerId: string;
  displayName: string;
  startedAt: number;
  endsAt: number;
}

interface State {
  config: Config;
  contributions: Contribution[];
  /** Whose turn it is; null before the first turn, while closed, or when nobody can contribute. */
  turn: Turn | null;
  /** playerId → turns offered (used or not), so absent players do not keep getting the turn. */
  offered: Record<string, number>;
  /** playerId → contributions made. */
  counts: Record<string, number>;
  /** The most recent turn holder (rotation continues after them). */
  lastHolder: string | null;
  /** The challenge is open (absent before 1.3: open while someone holds the turn). */
  open?: boolean;
}

interface Input {
  words: string;
}

/** One evaluation per contribution (results: immediate). */
interface Evaluation {
  playerId: string;
  displayName: string;
  text: string;
}

/** While nobody can take a turn (no players yet, or everyone is done), look again this often. */
const RETRY_SECONDS = 30;
const MAX_WORD_LENGTH = 30;
const MAX_TEXT_LENGTH = 120;

function wordsOf(text: string | undefined): string[] {
  return (text ?? '').trim().split(/\s+/).filter(Boolean);
}

function messageOf(state: State): string {
  return [state.config.openingText ?? '', ...state.contributions.map((c) => c.text)].map((s) => s.trim()).filter(Boolean).join(' ');
}

/** Words per presentation slide: aimed for, at least (when looking for a sentence end) and at most (to avoid a tiny last slide). */
const PAGE_WORDS = 45;
const PAGE_MIN = 25;
const PAGE_MAX = 60;

/** The message in readable parts, ending at a sentence end where one is near. */
function pagesOf(words: string[]): string[][] {
  const pages: string[][] = [];
  let i = 0;
  while (i < words.length) {
    if (words.length - i <= PAGE_MAX) {
      pages.push(words.slice(i));
      break;
    }
    let end = i + PAGE_WORDS;
    for (let j = i + PAGE_WORDS; j >= i + PAGE_MIN; j--) {
      if (/[.!?…]["'”’)]*$/.test(words[j - 1]!)) {
        end = j;
        break;
      }
    }
    pages.push(words.slice(i, end));
    i = end;
  }
  return pages;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function nameOf(players: PlayerRef[], id: string): string {
  return players.find((p) => p.id === id)?.displayName ?? 'Unknown';
}

/**
 * Give the turn to the next player in line: never the previous holder twice in a row while
 * someone else can still write, then whoever was offered the fewest turns, then the join order
 * after the previous holder. Players who reached their maximum are skipped. Whether their
 * phone is connected does not matter: a sleeping phone gets the turn when it wakes up, and
 * the turn moves on after `turnSeconds` if it does not.
 */
function assignNextTurn(state: State, ctx: InstanceContext, previous: string | null): State {
  const players = ctx.players();
  const max = state.config.maxTurnsPerPlayer;
  const eligible = players.filter((p) => (state.counts[p.id] ?? 0) < max);
  if (eligible.length === 0) {
    // Nobody can contribute right now; a player who joins later can still pick it up.
    ctx.schedule('turn', RETRY_SECONDS);
    return { ...state, turn: null };
  }
  const ids = players.map((p) => p.id);
  const from = previous ? ids.indexOf(previous) : -1;
  const rotation = (id: string) => (ids.indexOf(id) - from - 1 + ids.length) % ids.length;
  const repeatPenalty = (id: string) => (id === previous && eligible.length > 1 ? 1 : 0);
  const next = [...eligible].sort(
    (a, b) =>
      repeatPenalty(a.id) - repeatPenalty(b.id) ||
      (state.offered[a.id] ?? 0) - (state.offered[b.id] ?? 0) ||
      rotation(a.id) - rotation(b.id),
  )[0]!;
  const now = ctx.now();
  ctx.schedule('turn', state.config.turnSeconds);
  return {
    ...state,
    turn: { playerId: next.id, displayName: next.displayName, startedAt: now, endsAt: now + state.config.turnSeconds * 1000 },
    offered: { ...state.offered, [next.id]: (state.offered[next.id] ?? 0) + 1 },
    lastHolder: next.id,
  };
}

function normalise(text: string): string {
  return wordsOf(text).join(' ');
}

export default defineModule<Config, State, Input, Evaluation>({
  manifest: manifestJson as unknown as Manifest,
  configurationSchema: schemaJson,

  createInstance(config) {
    return { config, contributions: [], turn: null, offered: {}, counts: {}, lastHolder: null };
  },

  onPhaseChange(state, phase, ctx) {
    if (phase === 'ACTIVE') return state.turn ? { ...state, open: true } : assignNextTurn({ ...state, open: true }, ctx, state.lastHolder);
    // Hidden again, closed or finished: nobody holds the turn.
    ctx.cancel('turn');
    return { ...state, turn: null, open: false };
  },

  onTimer(state, tag, ctx, playerId) {
    // The turn ran out unused (or nobody could take one before): move on.
    if (tag === 'turn' && !playerId) return assignNextTurn(state, ctx, state.turn?.playerId ?? state.lastHolder);
    return state;
  },

  canStart(state, player) {
    const c = state.config;
    if ((state.counts[player.id] ?? 0) >= c.maxTurnsPerPlayer) return { ok: false, reason: `You added your ${plural(c.maxTurnsPerPlayer, 'contribution')} — thank you!` };
    if (state.turn?.playerId === player.id) return { ok: true, hint: `Your turn! Add up to ${plural(c.wordsPerTurn, 'word')}`, urgent: true };
    if (state.turn) return { ok: false, reason: `${state.turn.displayName} is writing — wait for your turn` };
    return { ok: false, reason: 'Waiting for the next turn' };
  },

  // What is left of the player's turn.
  timeLimit(state, player, ctx) {
    return state.turn?.playerId === player.id ? Math.max(1, Math.round((state.turn.endsAt - ctx.now()) / 1000)) : null;
  },

  onAttemptStart(state, player, ctx) {
    // The attempt ends with the turn: the player gets whatever is left of it.
    const left = state.turn?.playerId === player.id ? (state.turn.endsAt - ctx.now()) / 1000 : 1;
    ctx.schedule('lock', Math.max(1, Math.round(left)), player.id);
    return state;
  },

  validateInput(state, player, input) {
    if (state.turn?.playerId !== player.id) return { ok: false, reason: 'Your turn is over' };
    const raw = input && typeof input === 'object' ? (input as { words?: unknown }).words : undefined;
    if (typeof raw !== 'string') return { ok: false, reason: 'Type your words first' };
    const words = wordsOf(raw);
    const max = state.config.wordsPerTurn;
    if (words.length === 0) return { ok: false, reason: 'Type your words first' };
    if (words.length > max) return { ok: false, reason: `Only ${plural(max, 'word')} per turn` };
    if (words.some((w) => w.length > MAX_WORD_LENGTH)) return { ok: false, reason: 'That word is too long' };
    if (words.join(' ').length > MAX_TEXT_LENGTH) return { ok: false, reason: 'That is too long' };
    return { ok: true };
  },

  handleInput(state, player, input, ctx) {
    const contribution: Contribution = { playerId: player.id, displayName: player.displayName, text: normalise(input.words), at: ctx.now() };
    const next: State = {
      ...state,
      contributions: [...state.contributions, contribution],
      counts: { ...state.counts, [player.id]: (state.counts[player.id] ?? 0) + 1 },
    };
    return assignNextTurn(next, ctx, player.id);
  },

  evaluate(_state, submissions, ctx) {
    // Immediate results: exactly one submission, this player's contribution.
    const s = submissions[0]!;
    return { playerId: s.playerId, displayName: nameOf(ctx.players(), s.playerId), text: normalise(s.payload.words) };
  },

  calculateScores(state, evaluation) {
    return [{ playerId: evaluation.playerId, points: state.config.pointsPerTurn, reason: 'Added to the message' }];
  },

  getStatistics(state, evaluations) {
    return {
      words: wordsOf(messageOf(state)).length,
      contributions: evaluations.length,
      contributors: new Set(evaluations.map((e) => e.playerId)).size,
    };
  },

  guestView(state, player) {
    const c = state.config;
    if (state.turn?.playerId !== player.id) {
      return { ui: ui.card([ui.title('Your turn is over'), ui.caption('The message moved on to the next player.')]), canSubmit: false };
    }
    const all = wordsOf(messageOf(state));
    const tail = all.slice(-c.visibleWords).join(' ');
    const shown: UINode = tail
      ? ui.card([ui.text(all.length > c.visibleWords ? `… ${tail}` : tail)], 'primary')
      : ui.card([ui.text('You write the very first words!')], 'primary');
    return {
      ui: ui.stack(
        [
          ui.caption(c.prompt),
          shown,
          ui.timer('lock'),
          ui.textInput('words', { label: `Add up to ${plural(c.wordsPerTurn, 'word')}`, maxLength: MAX_TEXT_LENGTH, placeholder: 'Your words…' }),
          ui.submit('Add my words', { size: 'lg' }),
        ],
        { gap: 'md' },
      ),
      canSubmit: true,
      status: `Up to ${plural(c.wordsPerTurn, 'word')} — then it is the next player's turn`,
    };
  },

  displayBanner(state, ctx): BannerPart[] | null {
    // Whose turn it is, in the big screen's top bar (the name in the player's own colour):
    // players who put their phone away know when to pick it up.
    if (!(state.open ?? state.turn !== null) || !state.turn) return null;
    const player = ctx.players().find((p) => p.id === state.turn!.playerId);
    const name = player?.displayName ?? state.turn.displayName;
    return [{ text: '✍️ ' }, { text: name, ...(player?.color ? { color: player.color } : {}) }, { text: "'s turn to write: open your phone" }];
  },

  presentation(state): PresentationSlide[] {
    const pages = pagesOf(wordsOf(messageOf(state)));
    return pages.map((page, i) => ({
      caption: pages.length > 1 ? `Part ${i + 1} of ${pages.length}` : undefined,
      steps: [
        ui.stack(
          [
            ...(i === 0 ? [ui.subtitle(state.config.prompt, { align: 'center', tone: 'muted' })] : []),
            ui.title(`${i > 0 ? '… ' : ''}${page.join(' ')}${i < pages.length - 1 ? ' …' : ''}`, { align: 'center' }),
          ],
          { gap: 'lg', align: 'center' },
        ),
      ],
      // Time to read it out loud.
      stepSeconds: Math.max(8, Math.round(page.length * 0.5)),
    }));
  },

  resultsView(state, evaluations) {
    const message = messageOf(state);
    const writers = new Set(evaluations.map((e) => e.playerId)).size;
    const body = ui.card([ui.text(message || 'Nobody wrote anything yet.')], 'primary');
    const facts = ui.row([ui.badge(plural(wordsOf(message).length, 'word')), ui.badge(plural(writers, 'writer'))], { gap: 'sm', wrap: true, justify: 'center' });
    return {
      ui: ui.stack([ui.title(state.config.prompt, { align: 'center' }), body, facts], { gap: 'md', align: 'stretch' }),
      guestUi: (player) => {
        const mine = evaluations.filter((e) => e.playerId === player.id).length;
        return ui.stack(
          [ui.caption(state.config.prompt), body, ui.text(mine ? `You added to it ${plural(mine, 'time')}.` : 'You did not add to this one.', { tone: 'muted' }), facts],
          { gap: 'md' },
        );
      },
    };
  },
});
