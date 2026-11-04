/**
 * Caption This — reference module for peer approval (§14.2).
 *
 * The player writes a caption for a picture. The engine assigns another player to judge
 * it against the criteria in the manifest; the module only maps the decision to points.
 */
import { defineModule, ui, type Manifest, type PlayerRef, type UINode } from '@challenge/contract';
import manifestJson from '../manifest.json' with { type: 'json' };
import schemaJson from '../config.schema.json' with { type: 'json' };

interface Config {
  image: string;
  prompt: string;
  timeLimit: number;
  maxLength: number;
  points: number;
}

interface State {
  config: Config;
  /** playerId → latest caption (for the player's own feedback). */
  captions: Record<string, string>;
}

interface Input {
  caption: string;
}

interface Evaluation {
  playerId: string;
  displayName: string;
  caption: string;
  approved: boolean;
  /** Host-entered points, when the host judged with a score. */
  hostPoints: number | null;
  note: string | null;
  decidedBy: 'peer' | 'host' | null;
}

function nameOf(players: PlayerRef[], id: string): string {
  return players.find((p) => p.id === id)?.displayName ?? 'Unknown';
}

export default defineModule<Config, State, Input, Evaluation>({
  manifest: manifestJson as unknown as Manifest,
  configurationSchema: schemaJson,

  createInstance(config) {
    return { config, captions: {} };
  },

  timeLimit(state) {
    return state.config.timeLimit > 0 ? state.config.timeLimit : null;
  },

  onAttemptStart(state, player, ctx) {
    if (state.config.timeLimit > 0) ctx.schedule('lock', state.config.timeLimit, player.id); // 0 = no time limit
    // A replay starts with an empty caption.
    const { [player.id]: _previous, ...captions } = state.captions;
    return { ...state, captions };
  },

  validateInput(state, _player, input) {
    const caption = typeof input?.caption === 'string' ? input.caption.trim() : '';
    if (!caption) return { ok: false, reason: 'Write a caption first' };
    if (caption.length > state.config.maxLength) return { ok: false, reason: `Keep it under ${state.config.maxLength} characters` };
    return { ok: true };
  },

  handleInput(state, player, input) {
    return { ...state, captions: { ...state.captions, [player.id]: input.caption.trim() } };
  },

  evaluate(_state, submissions, ctx) {
    // Immediate results: exactly one submission, carrying the judge's decision.
    const s = submissions[0]!;
    const final = s.judgements[s.judgements.length - 1];
    return {
      playerId: s.playerId,
      displayName: nameOf(ctx.players(), s.playerId),
      caption: String(s.payload.caption ?? '').trim(),
      approved: final?.decision === 'approve',
      hostPoints: final?.by === 'host' && typeof final.points === 'number' ? final.points : null,
      note: final?.note ?? null,
      decidedBy: final?.by ?? null,
    };
  },

  calculateScores(state, evaluation) {
    if (evaluation.hostPoints !== null) return [{ playerId: evaluation.playerId, points: evaluation.hostPoints, reason: 'Scored by the host' }];
    return [{ playerId: evaluation.playerId, points: evaluation.approved ? state.config.points : 0, reason: evaluation.approved ? 'Caption approved' : 'Caption rejected' }];
  },

  getStatistics(_state, evaluations) {
    const approved = evaluations.filter((e) => e.approved).length;
    return {
      captions: evaluations.length,
      approved,
      approvalRate: evaluations.length ? Math.round((approved / evaluations.length) * 100) / 100 : null,
      judgedByHost: evaluations.filter((e) => e.decidedBy === 'host').length,
    };
  },

  introView(state, _player, ctx) {
    return ui.stack(
      [ui.image(ctx.mediaUrl(state.config.image), { maxHeight: '30vh' }), ui.text(state.config.prompt), ui.caption(`${state.config.timeLimit > 0 ? `${state.config.timeLimit} seconds. ` : ''}Another player will judge your caption.`)],
      { gap: 'sm' },
    );
  },

  guestView(state, player, ctx) {
    const c = state.config;
    const mine = state.captions[player.id];
    return {
      ui: ui.stack(
        [
          ui.image(ctx.mediaUrl(c.image), { maxHeight: '35vh' }),
          ui.subtitle(c.prompt),
          ui.timer('lock'),
          ui.textInput('caption', { label: 'Your caption', maxLength: c.maxLength, multiline: true, value: mine, placeholder: 'Type something witty…' }),
          ui.submit(mine === undefined ? 'Submit caption' : 'Update caption', { size: 'lg' }),
        ],
        { gap: 'md' },
      ),
      canSubmit: true,
      status: mine === undefined ? undefined : 'Caption saved — you can still change it until time runs out',
    };
  },

  presentSubmission(state, submission, ctx) {
    return ui.stack(
      [ui.image(ctx.mediaUrl(state.config.image), { maxHeight: '40vh' }), ui.card([ui.title(String(submission.payload.caption ?? ''), { align: 'center' })], 'primary')],
      { gap: 'md' },
    );
  },

  mainView(state) {
    return ui.caption(state.config.prompt);
  },

  resultsView(state, evaluations, ctx) {
    const approved = evaluations.filter((e) => e.approved);
    const shared: UINode = ui.stack(
      [
        ui.image(ctx.mediaUrl(state.config.image), { maxHeight: '30vh' }),
        ui.row([ui.badge(`${evaluations.length} captions`), ui.badge(`${approved.length} approved`, 'success')], { gap: 'sm', justify: 'center', wrap: true }),
        ui.list(approved.slice(0, 8).map((e) => ({ label: `“${e.caption}”`, value: e.displayName, highlight: true }))),
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
            ui.card([ui.title(`“${me.caption}”`, { align: 'center' })], me.approved ? 'success' : 'danger'),
            ui.text(me.hostPoints !== null ? `The host gave you ${me.hostPoints} points` : me.approved ? 'Your caption was approved!' : 'Your caption was rejected', { align: 'center' }),
            ...(me.note ? [ui.caption(`Judge's note: ${me.note}`, { align: 'center' })] : []),
          ],
          { gap: 'md' },
        );
      },
    };
  },
});
