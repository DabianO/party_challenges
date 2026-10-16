/**
 * Photo Hunt (contract v2, `results: "immediate"`, peer-judged by default).
 *
 * Each player gets a task ("Take a selfie with someone wearing red"), a per-player time
 * limit and one shot: they upload a photo as evidence (`media://` ref produced by the
 * platform's file input). The engine assigns a judge (peer, host or hybrid) who checks
 * the photo against the criteria; this module only maps the decision to points.
 */
import { defineModule, ui, type Manifest, type PlayerRef, type UINode } from '@challenge/contract';
import manifestJson from '../manifest.json' with { type: 'json' };
import schemaJson from '../config.schema.json' with { type: 'json' };

interface Config {
  task: string;
  timeLimit: number;
  points: number;
}

interface State {
  config: Config;
  /** playerId → submitted photo reference (for the player's own feedback). */
  photos: Record<string, string>;
}

interface Input {
  photo: string;
}

interface Evaluation {
  playerId: string;
  displayName: string;
  /** `media://` reference of the submitted photo. */
  photo: string;
  approved: boolean;
  /** Host-entered points, when the host judged with a score. */
  hostPoints: number | null;
  note: string | null;
  decidedBy: 'peer' | 'host' | null;
}

const MEDIA_REF = /^media:\/\/[A-Za-z0-9_-]+$/;

function nameOf(players: PlayerRef[], id: string): string {
  return players.find((p) => p.id === id)?.displayName ?? 'Unknown';
}

function pointsFor(config: Config, e: Evaluation): number {
  return e.hostPoints ?? (e.approved ? config.points : 0);
}

export default defineModule<Config, State, Input, Evaluation>({
  manifest: manifestJson as unknown as Manifest,
  configurationSchema: schemaJson,

  createInstance(config) {
    return { config, photos: {} };
  },

  onAttemptStart(state, player, ctx) {
    ctx.schedule('lock', state.config.timeLimit, player.id);
    return state;
  },

  validateInput(_state, _player, input) {
    if (!input || typeof input !== 'object') return { ok: false, reason: 'Take or choose a photo first' };
    const photo = (input as { photo?: unknown }).photo;
    if (typeof photo !== 'string' || !photo) return { ok: false, reason: 'Take or choose a photo first' };
    if (!MEDIA_REF.test(photo)) return { ok: false, reason: 'The photo could not be uploaded, please try again' };
    return { ok: true };
  },

  handleInput(state, player, input) {
    return { ...state, photos: { ...state.photos, [player.id]: input.photo } };
  },

  evaluate(_state, submissions, ctx) {
    // Immediate results: exactly one submission, carrying the judge's decision(s).
    const s = submissions[0]!;
    const final = s.judgements[s.judgements.length - 1];
    return {
      playerId: s.playerId,
      displayName: nameOf(ctx.players(), s.playerId),
      photo: String(s.payload?.photo ?? ''),
      approved: final?.decision === 'approve',
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
        reason: evaluation.approved ? 'Photo approved' : 'Photo rejected',
      },
    ];
  },

  getStatistics(state, evaluations) {
    const approved = evaluations.filter((e) => e.approved).length;
    return {
      task: state.config.task,
      photos: evaluations.length,
      approved,
      approvalRate: evaluations.length ? Math.round((approved / evaluations.length) * 100) / 100 : null,
      judgedByHost: evaluations.filter((e) => e.decidedBy === 'host').length,
    };
  },

  introView(state) {
    const c = state.config;
    return ui.stack(
      [
        ui.text(c.task),
        ui.caption(`You have ${c.timeLimit} seconds from the moment you start to take and upload one photo. Another player checks it; an approved photo earns ${c.points} points.`),
      ],
      { gap: 'sm' },
    );
  },

  guestView(state, player, ctx) {
    const c = state.config;
    const mine = state.photos[player.id];
    const children: UINode[] = [ui.subtitle(c.task), ui.timer('lock')];
    if (mine) {
      children.push(ui.image(ctx.mediaUrl(mine), { maxHeight: '40vh', alt: 'Your photo' }));
      children.push(ui.badge('Photo submitted', 'success'));
      return { ui: ui.stack(children, { gap: 'md' }), canSubmit: false, status: 'Photo submitted — waiting for a judge' };
    }
    children.push(ui.fileInput('photo', { accept: 'image/*', capture: 'environment', label: 'Take or choose a photo' }));
    children.push(ui.submit('Submit photo', { size: 'lg' }));
    return { ui: ui.stack(children, { gap: 'md' }), canSubmit: true, status: 'One photo only — make it count' };
  },

  presentSubmission(state, submission, ctx) {
    return ui.stack(
      [ui.subtitle(state.config.task), ui.image(ctx.mediaUrl(String(submission.payload?.photo ?? '')), { maxHeight: '55vh', alt: 'Submitted photo' })],
      { gap: 'md' },
    );
  },

  mainView(state) {
    const count = Object.keys(state.photos).length;
    return ui.stack(
      [ui.title(state.config.task, { align: 'center' }), ui.badge(`${count} photo${count === 1 ? '' : 's'} so far`, count > 0 ? 'primary' : 'muted')],
      { gap: 'lg', align: 'center' },
    );
  },

  resultsView(state, evaluations, ctx) {
    const c = state.config;
    const approved = evaluations.filter((e) => e.approved);
    const shared: UINode = ui.stack(
      [
        ui.caption(c.task, { align: 'center' }),
        ui.row(
          [ui.badge(`${evaluations.length} photo${evaluations.length === 1 ? '' : 's'}`), ui.badge(`${approved.length} approved`, approved.length ? 'success' : 'muted')],
          { gap: 'sm', justify: 'center', wrap: true },
        ),
        approved.length
          ? ui.grid(
              2,
              approved.slice(0, 12).map((e) => ui.stack([ui.image(ctx.mediaUrl(e.photo), { maxHeight: '30vh', alt: `${e.displayName}'s photo` }), ui.caption(e.displayName, { align: 'center' })], { gap: 'sm' })),
              { gap: 'md' },
            )
          : ui.caption('No approved photos yet.', { align: 'center' }),
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
            ui.caption(c.task),
            ui.card([ui.image(ctx.mediaUrl(me.photo), { maxHeight: '40vh', alt: 'Your photo' })], me.approved ? 'success' : 'danger'),
            ui.text(
              me.hostPoints !== null ? `The host gave you ${me.hostPoints} points` : me.approved ? `Approved! +${pointsFor(c, me)} points` : 'Your photo was rejected',
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
