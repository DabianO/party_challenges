/**
 * Selfiemotion (contract v2, `results: "immediate"`, peer-judged by default).
 *
 * Every player gets a random emoji when they start (the ones handed out least so far first)
 * and recreates it with a selfie, uploaded as evidence. A judge (peer, host or hybrid) checks
 * it is a real attempt; in automatic mode every selfie counts. Once closed, the host can show
 * every emoji next to its selfie on the big screen, four to a slide (`presentation`).
 */
import { defineModule, ui, type InstanceContext, type Manifest, type PlayerRef, type PresentationSlide, type UINode } from '@challenge/contract';
import manifestJson from '../manifest.json' with { type: 'json' };
import schemaJson from '../config.schema.json' with { type: 'json' };

interface Config {
  emojis: string[];
  timeLimit: number;
  points: number;
}

interface State {
  config: Config;
  /** playerId → the emoji of their current (or last) attempt. */
  emoji: Record<string, string>;
  /** emoji → how often it was handed out, so they spread evenly. */
  given: Record<string, number>;
  /** playerId → submitted selfie reference (for the player's own feedback). */
  photos: Record<string, string>;
}

interface Input {
  photo: string;
}

interface Evaluation {
  playerId: string;
  displayName: string;
  emoji: string;
  /** `media://` reference of the selfie. */
  photo: string;
  approved: boolean;
  /** Host-entered points, when the host judged with a score. */
  hostPoints: number | null;
  note: string | null;
  decidedBy: 'peer' | 'host' | null;
}

const MEDIA_REF = /^media:\/\/[A-Za-z0-9_-]+$/;
/** Selfies per presentation slide. */
const PER_SLIDE = 4;

function nameOf(players: PlayerRef[], id: string): string {
  return players.find((p) => p.id === id)?.displayName ?? 'Unknown';
}

function emojisOf(config: Config): string[] {
  const list = (config.emojis ?? []).map((e) => String(e).trim()).filter(Boolean);
  return list.length ? list : ['🙂'];
}

/** One of the emojis handed out least so far, at random; a replay never gets the same one again. */
function pickEmoji(state: State, player: PlayerRef, ctx: InstanceContext): string {
  const all = emojisOf(state.config);
  const previous = state.emoji[player.id];
  const options = all.length > 1 ? all.filter((e) => e !== previous) : all;
  const fewest = Math.min(...options.map((e) => state.given[e] ?? 0));
  const least = options.filter((e) => (state.given[e] ?? 0) === fewest);
  return least[Math.min(least.length - 1, Math.floor(ctx.rng() * least.length))]!;
}

function pointsFor(config: Config, e: Evaluation): number {
  return e.hostPoints ?? (e.approved ? config.points : 0);
}

/** The emoji and the selfie side by side. */
function pair(emoji: string, photo: string, ctx: InstanceContext, maxHeight: string, alt: string): UINode {
  return ui.row([ui.display(emoji), ui.image(ctx.mediaUrl(photo), { maxHeight, alt })], { gap: 'md', align: 'center', justify: 'center' });
}

export default defineModule<Config, State, Input, Evaluation>({
  manifest: manifestJson as unknown as Manifest,
  configurationSchema: schemaJson,

  createInstance(config) {
    return { config, emoji: {}, given: {}, photos: {} };
  },

  onAttemptStart(state, player, ctx) {
    if (state.config.timeLimit > 0) ctx.schedule('lock', state.config.timeLimit, player.id); // 0 = no time limit
    const emoji = pickEmoji(state, player, ctx);
    // A replay starts with a new emoji and without a selfie.
    const { [player.id]: _previous, ...photos } = state.photos;
    return { ...state, emoji: { ...state.emoji, [player.id]: emoji }, given: { ...state.given, [emoji]: (state.given[emoji] ?? 0) + 1 }, photos };
  },

  validateInput(_state, _player, input) {
    if (!input || typeof input !== 'object') return { ok: false, reason: 'Take your selfie first' };
    const photo = (input as { photo?: unknown }).photo;
    if (typeof photo !== 'string' || !photo) return { ok: false, reason: 'Take your selfie first' };
    if (!MEDIA_REF.test(photo)) return { ok: false, reason: 'The selfie could not be uploaded, please try again' };
    return { ok: true };
  },

  handleInput(state, player, input) {
    return { ...state, photos: { ...state.photos, [player.id]: input.photo } };
  },

  evaluate(state, submissions, ctx) {
    // Immediate results: exactly one submission, carrying the judge's decision(s) (none when automatic).
    const s = submissions[0]!;
    const final = s.judgements[s.judgements.length - 1];
    return {
      playerId: s.playerId,
      displayName: nameOf(ctx.players(), s.playerId),
      emoji: state.emoji[s.playerId] ?? '',
      photo: String(s.payload?.photo ?? ''),
      approved: final ? final.decision === 'approve' : true,
      hostPoints: final?.by === 'host' && typeof final.points === 'number' && Number.isFinite(final.points) ? final.points : null,
      note: final?.note ?? null,
      decidedBy: final?.by ?? null,
    };
  },

  calculateScores(state, evaluation, ctx) {
    if (!ctx.players().some((p) => p.id === evaluation.playerId)) return [];
    if (evaluation.hostPoints !== null) return [{ playerId: evaluation.playerId, points: evaluation.hostPoints, reason: 'Scored by the host' }];
    return [
      {
        playerId: evaluation.playerId,
        points: evaluation.approved ? state.config.points : 0,
        reason: evaluation.approved ? `Selfie ${evaluation.emoji}` : `Selfie ${evaluation.emoji} rejected`,
      },
    ];
  },

  getStatistics(_state, evaluations) {
    const approved = evaluations.filter((e) => e.approved).length;
    return {
      selfies: evaluations.length,
      approved,
      approvalRate: evaluations.length ? Math.round((approved / evaluations.length) * 100) / 100 : null,
      emojis: [...new Set(evaluations.map((e) => e.emoji))].length,
      judgedByHost: evaluations.filter((e) => e.decidedBy === 'host').length,
    };
  },

  introView(state) {
    const c = state.config;
    return ui.stack(
      [
        ui.text('You get a random emoji. Recreate it with a selfie: the face, the props, the drama.'),
        ui.caption(`${c.timeLimit > 0 ? `You have ${c.timeLimit} seconds from the moment you start.` : 'Take your time.'} One selfie only.`),
      ],
      { gap: 'sm' },
    );
  },

  guestView(state, player, ctx) {
    const emoji = state.emoji[player.id] ?? '🙂';
    const mine = state.photos[player.id];
    const children: UINode[] = [ui.card([ui.caption('Recreate this emoji', { align: 'center' }), ui.display(emoji)], 'primary'), ui.timer('lock')];
    if (mine) {
      children.push(pair(emoji, mine, ctx, '30vh', 'Your selfie'));
      children.push(ui.badge('Selfie submitted', 'success'));
      return { ui: ui.stack(children, { gap: 'md' }), canSubmit: false, status: 'Selfie submitted' };
    }
    children.push(ui.fileInput('photo', { accept: 'image/*', capture: 'user', label: 'Take your selfie' }));
    children.push(ui.submit('Submit selfie', { size: 'lg' }));
    return { ui: ui.stack(children, { gap: 'md' }), canSubmit: true, status: 'One selfie only: make it count' };
  },

  presentSubmission(state, submission, ctx) {
    const emoji = state.emoji[submission.playerId] ?? '';
    return ui.stack([ui.subtitle('Does this selfie recreate the emoji?', { align: 'center' }), pair(emoji, String(submission.payload?.photo ?? ''), ctx, '50vh', 'Submitted selfie')], {
      gap: 'md',
    });
  },

  mainView(state) {
    const count = Object.keys(state.photos).length;
    return ui.stack(
      [ui.title('Recreate your emoji with a selfie', { align: 'center' }), ui.badge(`${count} selfie${count === 1 ? '' : 's'} so far`, count > 0 ? 'primary' : 'muted')],
      { gap: 'lg', align: 'center' },
    );
  },

  presentation(_state, evaluations, ctx): PresentationSlide[] {
    const shown = evaluations.filter((e) => e.approved && e.photo);
    const slides: PresentationSlide[] = [];
    for (let i = 0; i < shown.length; i += PER_SLIDE) {
      const page = shown.slice(i, i + PER_SLIDE);
      const cells = page.map((e) => ui.card([pair(e.emoji, e.photo, ctx, '30vh', `${e.displayName}'s selfie`), ui.text(e.displayName, { align: 'center' })]));
      slides.push({
        caption: shown.length > PER_SLIDE ? `${i + 1}–${i + page.length} of ${shown.length}` : undefined,
        steps: [ui.grid(page.length === 1 ? 1 : 2, cells, { gap: 'lg' })],
        stepSeconds: 12,
      });
    }
    return slides;
  },

  resultsView(state, evaluations, ctx) {
    const c = state.config;
    const approved = evaluations.filter((e) => e.approved);
    const shared: UINode = ui.stack(
      [
        ui.row(
          [ui.badge(`${evaluations.length} selfie${evaluations.length === 1 ? '' : 's'}`), ui.badge(`${approved.length} approved`, approved.length ? 'success' : 'muted')],
          { gap: 'sm', justify: 'center', wrap: true },
        ),
        approved.length
          ? ui.grid(
              2,
              approved.slice(0, 12).map((e) => ui.stack([pair(e.emoji, e.photo, ctx, '24vh', `${e.displayName}'s selfie`), ui.caption(e.displayName, { align: 'center' })], { gap: 'sm' })),
              { gap: 'md' },
            )
          : ui.caption('No selfies yet.', { align: 'center' }),
      ],
      { gap: 'md' },
    );
    return {
      ui: shared,
      guestUi: (player) => {
        const me = evaluations.find((e) => e.playerId === player.id);
        if (!me) return shared;
        return ui.stack(
          [
            ui.card([pair(me.emoji, me.photo, ctx, '36vh', 'Your selfie')], me.approved ? 'success' : 'danger'),
            ui.text(
              me.hostPoints !== null ? `The host gave you ${me.hostPoints} points` : me.approved ? `+${pointsFor(c, me)} points` : 'Your selfie was rejected',
              { align: 'center' },
            ),
            ...(me.note ? [ui.caption(`Judge's note: ${me.note}`, { align: 'center' })] : []),
          ],
          { gap: 'md' },
        );
      },
    };
  },
});
