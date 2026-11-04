/**
 * Match Up (contract v2).
 *
 * The host fills in pairs side by side (capital | country). Every player gets both columns in
 * their own random order (left stays left, right stays right) and links each item on the left
 * to one on the right (`ui.pairMatch`). Links are live actions, so players can undo and relink
 * as often as they like, leave and come back later. Nobody sees whether a link is right.
 *
 * Once everything is linked, going back to the board locks the matches in (`lockOnLeave`), as
 * does the Lock in button. Scored when the host closes the challenge (`onClose`), from state:
 * players who never locked in still score the links they made.
 *
 * Item ids are positions on the player's own sheet (`a3`, `b5`), so the page never carries
 * which items belong together. A link is right when its two labels form one of the host's pairs,
 * so pairs that share a label (two countries with the same answer) both count.
 */
import { defineModule, ui, type ListItem, type Manifest, type PlayerRef, type PresentationSlide, type UINode } from '@challenge/contract';
import manifestJson from '../manifest.json' with { type: 'json' };
import schemaJson from '../config.schema.json' with { type: 'json' };

interface Pair {
  left: string;
  right: string;
}

interface Config {
  instructions?: string;
  leftTitle?: string;
  rightTitle?: string;
  pairs: Pair[];
  pointsPerMatch: number;
  bonus?: number;
}

/** One player's shuffled columns and their links. */
interface Sheet {
  /** Row → pair index, for each column. */
  left: number[];
  right: number[];
  /** Left row → right row. */
  links: Record<string, number>;
}

interface State {
  config: Config;
  sheets: Record<string, Sheet>;
}

/** Live action payload: `{ link: { left, right } }`, `right: null` undoes the left item's link. */
interface Link {
  left: string;
  right: string | null;
}

interface PlayerResult {
  playerId: string;
  displayName: string;
  linked: number;
  correct: number;
  /** Per pair (host's order): what this player linked its left item to, and whether that was right. */
  answers: { given: string | null; right: boolean }[];
  points: number;
}

/** Aggregate evaluation (results: onClose). */
interface Evaluation {
  players: PlayerResult[];
}

const ACTION = 'link';
const leftId = (row: number) => `a${row}`;
const rightId = (row: number) => `b${row}`;

function rowOf(id: unknown, prefix: 'a' | 'b', size: number): number | null {
  if (typeof id !== 'string' || !id.startsWith(prefix)) return null;
  const row = Number(id.slice(1));
  return Number.isInteger(row) && row >= 0 && row < size && id === `${prefix}${row}` ? row : null;
}

/** Labels compare without case, accents or extra spaces. */
function same(a: string, b: string): boolean {
  const n = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
  return n(a) === n(b);
}

function pairsOf(state: State): Pair[] {
  return state.config.pairs.filter((p) => p.left.trim() && p.right.trim());
}

/** Is linking pair `l`'s left item to pair `r`'s right item one of the host's pairs? */
function isRight(pairs: Pair[], l: number, r: number): boolean {
  const left = pairs[l]!.left;
  const right = pairs[r]!.right;
  return pairs.some((p) => same(p.left, left) && same(p.right, right));
}

function shuffled(n: number, rng: () => number): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

/**
 * Both columns in random order, avoiding matches that sit side by side (a few tries: the
 * fewest rows where the right item next to a left item is its match).
 */
export function dealSheet(pairs: Pair[], rng: () => number): Sheet {
  let best: Sheet | null = null;
  let bestAligned = Infinity;
  for (let attempt = 0; attempt < 8 && bestAligned > 0; attempt++) {
    const left = shuffled(pairs.length, rng);
    const right = shuffled(pairs.length, rng);
    const aligned = left.filter((l, row) => isRight(pairs, l, right[row]!)).length;
    if (aligned < bestAligned) {
      best = { left, right, links: {} };
      bestAligned = aligned;
    }
  }
  return best!;
}

function linkedCount(sheet: Sheet | undefined): number {
  return sheet ? Object.keys(sheet.links).length : 0;
}

/** One player's result over their sheet. */
export function scoreSheet(state: State, sheet: Sheet): Omit<PlayerResult, 'playerId' | 'displayName'> {
  const pairs = pairsOf(state);
  const answers = pairs.map(() => ({ given: null as string | null, right: false }));
  let correct = 0;
  for (const [row, rightRow] of Object.entries(sheet.links)) {
    const l = sheet.left[Number(row)];
    const r = sheet.right[rightRow];
    if (l === undefined || r === undefined) continue;
    const right = isRight(pairs, l, r);
    answers[l] = { given: pairs[r]!.right, right };
    if (right) correct++;
  }
  const each = Math.max(0, state.config.pointsPerMatch ?? 0);
  const bonus = correct === pairs.length ? Math.max(0, state.config.bonus ?? 0) : 0;
  return { linked: linkedCount(sheet), correct, answers, points: correct * each + bonus };
}

const INSTRUCTIONS = 'Tap an item, then its match on the other side. Tap a link to undo it. Nobody sees what is right until the results.';

export default defineModule<Config, State, Record<string, unknown>, Evaluation>({
  manifest: manifestJson as unknown as Manifest,
  configurationSchema: schemaJson,

  createInstance(config) {
    return { config, sheets: {} };
  },

  onAttemptStart(state, player, ctx) {
    return { ...state, sheets: { ...state.sheets, [player.id]: dealSheet(pairsOf(state), () => ctx.rng()) } };
  },

  validateAction(state, player, payload) {
    const sheet = state.sheets[player.id];
    const link = payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[ACTION] : undefined;
    if (!sheet || !link || typeof link !== 'object') return { ok: false, reason: 'Unknown action' };
    const { left, right } = link as Partial<Link>;
    if (rowOf(left, 'a', sheet.left.length) === null) return { ok: false, reason: 'Unknown item' };
    if (right !== null && rowOf(right, 'b', sheet.right.length) === null) return { ok: false, reason: 'Unknown item' };
    return { ok: true };
  },

  onAction(state, player, payload) {
    const sheet = state.sheets[player.id]!;
    const link = (payload as Record<string, Link>)[ACTION]!;
    const l = rowOf(link.left, 'a', sheet.left.length)!;
    const r = link.right === null ? null : rowOf(link.right, 'b', sheet.right.length)!;
    // A new link replaces any link either item had.
    const links: Record<string, number> = {};
    for (const [row, rightRow] of Object.entries(sheet.links)) if (Number(row) !== l && rightRow !== r) links[row] = rightRow;
    if (r !== null) links[String(l)] = r;
    return { ...state, sheets: { ...state.sheets, [player.id]: { ...sheet, links } } };
  },

  // The Lock in button (and leaving the screen) submits once every item is linked.
  validateInput(state, player) {
    const sheet = state.sheets[player.id];
    if (!sheet || linkedCount(sheet) < sheet.left.length) return { ok: false, reason: 'Link every item first' };
    return { ok: true };
  },

  handleInput(state) {
    return state;
  },

  playerNote(state, player) {
    const sheet = state.sheets[player.id];
    return sheet ? `${linkedCount(sheet)} of ${sheet.left.length} linked` : null;
  },

  evaluate(state, _submissions, ctx) {
    // Scored from state: links are live actions, and an unfinished sheet still counts.
    const names = new Map(ctx.players().map((p) => [p.id, p.displayName]));
    const players = Object.entries(state.sheets).map(([playerId, sheet]) => ({ playerId, displayName: names.get(playerId) ?? 'Unknown', ...scoreSheet(state, sheet) }));
    return { players };
  },

  calculateScores(state, evaluation) {
    const n = pairsOf(state).length;
    return evaluation.players.map((p) => ({ playerId: p.playerId, points: p.points, reason: p.correct === n ? `All ${n} right` : `${p.correct} of ${n} right` }));
  },

  getStatistics(state, evaluations) {
    const players = evaluations[0]?.players ?? [];
    const pairs = pairsOf(state);
    return {
      pairs: pairs.length,
      players: players.length,
      perfect: players.filter((p) => p.correct === pairs.length).length,
      averageCorrect: players.length ? Math.round((players.reduce((a, p) => a + p.correct, 0) / players.length) * 100) / 100 : null,
      perPair: pairs.map((p, i) => ({ left: p.left, right: p.right, correct: players.filter((r) => r.answers[i]?.right).length })),
    };
  },

  introView(state) {
    const n = pairsOf(state).length;
    const c = state.config;
    return ui.stack(
      [
        ...(c.instructions ? [ui.text(c.instructions)] : []),
        ui.text(`${n} pairs to match, in your own order.`),
        ui.caption('Link everything, then go back to the board to lock your matches in. Until then you can undo links, leave and come back.'),
      ],
      { gap: 'sm' },
    );
  },

  guestView(state, player) {
    const c = state.config;
    const pairs = pairsOf(state);
    const sheet = state.sheets[player.id] ?? { left: [], right: [], links: {} };
    const links: Record<string, string> = {};
    for (const [row, rightRow] of Object.entries(sheet.links)) links[leftId(Number(row))] = rightId(rightRow);
    const linked = linkedCount(sheet);
    const done = sheet.left.length > 0 && linked === sheet.left.length;
    const children: UINode[] = [];
    if (c.instructions) children.push(ui.subtitle(c.instructions));
    children.push(
      ui.caption(INSTRUCTIONS),
      ui.pairMatch(
        ACTION,
        sheet.left.map((p, row) => ({ id: leftId(row), label: pairs[p]?.left ?? '' })),
        sheet.right.map((p, row) => ({ id: rightId(row), label: pairs[p]?.right ?? '' })),
        links,
        { leftTitle: c.leftTitle?.trim() || undefined, rightTitle: c.rightTitle?.trim() || undefined },
      ),
    );
    if (done) children.push(ui.submit('Lock in my matches', { size: 'lg' }));
    return {
      ui: ui.stack(children, { gap: 'md', align: 'stretch' }),
      canSubmit: done,
      lockOnLeave: done,
      status: done ? 'Everything linked · going back locks your matches in' : `${linked} of ${sheet.left.length} linked · come back to it any time`,
    };
  },

  mainView(state) {
    return ui.caption(`${pairsOf(state).length} pairs to match, every player in their own order.`);
  },

  presentation(state, evaluations): PresentationSlide[] {
    // The right matches one by one, each with how many players got it.
    const pairs = pairsOf(state);
    const players = evaluations[0]?.players ?? [];
    if (pairs.length === 0) return [];
    const items = (shown: number): ListItem[] =>
      pairs.map((p, i) =>
        i < shown
          ? { label: `${p.left}  →  ${p.right}`, value: `${players.filter((r) => r.answers[i]?.right).length} of ${players.length} right`, tone: 'success' as const, highlight: i === shown - 1 }
          : { label: `${p.left}  →  ?`, tone: 'muted' as const },
      );
    const head = [state.config.leftTitle, state.config.rightTitle].filter((t) => t?.trim()).join('  →  ');
    return [
      {
        caption: 'The right matches',
        steps: pairs.map((_, i) => ui.stack([...(head ? [ui.caption(head, { align: 'center' })] : []), ui.list(items(i + 1))], { gap: 'md', align: 'stretch' })),
        stepSeconds: 5,
      },
    ];
  },

  resultsView(state, evaluations) {
    const pairs = pairsOf(state);
    const players = evaluations[0]?.players ?? [];
    const perfect = players.filter((p) => p.correct === pairs.length).length;
    const answerList = ui.list(pairs.map((p, i) => ({ label: `${p.left} → ${p.right}`, value: `${players.filter((r) => r.answers[i]?.right).length}/${players.length}`, tone: 'success' as const })));
    const summary = ui.badge(players.length ? `${perfect} of ${players.length} matched everything` : 'Nobody played', perfect > 0 ? 'success' : 'muted');
    return {
      ui: ui.stack([answerList, ui.row([summary], { justify: 'center' })], { gap: 'md', align: 'stretch' }),
      guestUi: (player: PlayerRef) => {
        const me = players.find((p) => p.playerId === player.id);
        if (!me) return ui.stack([ui.badge('You did not play', 'muted'), answerList], { gap: 'md' });
        const all = me.correct === pairs.length;
        const rows = ui.list(
          pairs.map((p, i) => {
            const a = me.answers[i]!;
            return {
              label: `${p.left} → ${a.given ?? '—'}`,
              value: a.right ? '✓' : `✕ ${p.right}`,
              tone: a.right ? ('success' as const) : ('danger' as const),
            };
          }),
        );
        const head = ui.title(all ? 'All matched!' : `${me.correct} of ${pairs.length} right`, { tone: all ? 'success' : me.correct ? 'neutral' : 'danger' });
        return ui.stack([ui.card([head, ui.text(`${me.points} ${me.points === 1 ? 'point' : 'points'}`, { tone: 'muted' })], all ? 'success' : 'neutral'), rows], { gap: 'md' });
      },
    };
  },
});
