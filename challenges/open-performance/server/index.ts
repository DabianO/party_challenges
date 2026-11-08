/**
 * Open Performance (contract v2, `results: "immediate"`, host-judged by default).
 *
 * An open-ended live task ("Give your best 30-second sales pitch for a paperclip").
 * Each player types a short entry (a title or one-liner) and performs live. The engine
 * routes the entry to the host queue (or a peer / hybrid, per game settings); the host
 * may approve/reject or enter 0–10 points. This module only maps the decision to points.
 * Once closed, the host can show the prompt with every entry and who performed it on the big
 * screen, six to a slide (`presentation`); rejected entries are left out without a word.
 */
import { defineModule, ui, type Manifest, type PlayerRef, type PresentationSlide, type UINode } from '@challenge/contract';
import manifestJson from '../manifest.json' with { type: 'json' };
import schemaJson from '../config.schema.json' with { type: 'json' };

interface Config {
  prompt: string;
  instructions: string;
  textLabel: string;
  maxLength: number;
  timeLimit: number;
  points: number;
}

interface State {
  config: Config;
  /** playerId → latest text entry (for the player's own feedback). */
  entries: Record<string, string>;
}

interface Input {
  text: string;
}

interface Evaluation {
  playerId: string;
  displayName: string;
  text: string;
  approved: boolean;
  /** Host-entered points, when the host judged with a score. */
  hostPoints: number | null;
  note: string | null;
  decidedBy: 'peer' | 'host' | null;
}

/** Entries per presentation slide. */
const PER_SLIDE = 6;

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
    return { config, entries: {} };
  },

  timeLimit(state) {
    return state.config.timeLimit > 0 ? state.config.timeLimit : null;
  },

  onAttemptStart(state, player, ctx) {
    if (state.config.timeLimit > 0) ctx.schedule('lock', state.config.timeLimit, player.id); // 0 = no time limit
    // A replay starts with an empty entry.
    const { [player.id]: _previous, ...entries } = state.entries;
    return { ...state, entries };
  },

  validateInput(state, _player, input) {
    if (!input || typeof input !== 'object') return { ok: false, reason: 'Type your entry first' };
    const raw = (input as { text?: unknown }).text;
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) return { ok: false, reason: 'Type your entry first' };
    if (text.length > state.config.maxLength) return { ok: false, reason: `Keep it under ${state.config.maxLength} characters` };
    return { ok: true };
  },

  handleInput(state, player, input) {
    return { ...state, entries: { ...state.entries, [player.id]: String(input.text).trim() } };
  },

  evaluate(_state, submissions, ctx) {
    // Immediate results: exactly one submission, carrying the judge's decision(s).
    const s = submissions[0]!;
    const final = s.judgements[s.judgements.length - 1];
    return {
      playerId: s.playerId,
      displayName: nameOf(ctx.players(), s.playerId),
      text: String(s.payload?.text ?? '').trim(),
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
        reason: evaluation.approved ? 'Performance approved' : 'Performance rejected',
      },
    ];
  },

  getStatistics(state, evaluations) {
    const approved = evaluations.filter((e) => e.approved).length;
    const points = evaluations.map((e) => pointsFor(state.config, e));
    const best = evaluations.reduce<Evaluation | null>((b, e) => (b === null || pointsFor(state.config, e) > pointsFor(state.config, b) ? e : b), null);
    return {
      prompt: state.config.prompt,
      entries: evaluations.length,
      approved,
      approvalRate: evaluations.length ? Math.round((approved / evaluations.length) * 100) / 100 : null,
      averagePoints: points.length ? Math.round((points.reduce((a, b) => a + b, 0) / points.length) * 100) / 100 : null,
      highest: best ? { name: best.displayName, points: pointsFor(state.config, best) } : null,
      judgedByHost: evaluations.filter((e) => e.decidedBy === 'host').length,
    };
  },

  introView(state) {
    const c = state.config;
    const children: UINode[] = [ui.text(c.prompt)];
    if (c.instructions) children.push(ui.text(c.instructions, { tone: 'muted' }));
    children.push(ui.caption(`${c.timeLimit > 0 ? `You get ${c.timeLimit} seconds to type` : 'Type'} a short entry, then perform it live. A judge decides how many points it earns.`));
    return ui.stack(children, { gap: 'sm' });
  },

  guestView(state, player) {
    const c = state.config;
    const mine = state.entries[player.id];
    const children: UINode[] = [ui.subtitle(c.prompt)];
    if (c.instructions) children.push(ui.text(c.instructions, { tone: 'muted' }));
    children.push(ui.timer('lock'));
    children.push(ui.textInput('text', { label: c.textLabel, maxLength: c.maxLength, multiline: c.maxLength > 80, value: mine, placeholder: 'A title or one-liner for your performance' }));
    children.push(ui.submit(mine === undefined ? 'Submit entry' : 'Update entry', { size: 'lg' }));
    return {
      ui: ui.stack(children, { gap: 'md' }),
      canSubmit: true,
      status: mine === undefined ? 'Then perform it live!' : 'Entry saved — perform it live! You can still change it until time runs out',
    };
  },

  presentSubmission(state, submission) {
    return ui.stack(
      [ui.caption(state.config.prompt), ui.card([ui.title(`“${String(submission.payload?.text ?? '').trim()}”`, { align: 'center' })], 'primary')],
      { gap: 'md' },
    );
  },

  mainView(state) {
    const c = state.config;
    const count = Object.keys(state.entries).length;
    const children: UINode[] = [ui.title(c.prompt, { align: 'center' })];
    if (c.instructions) children.push(ui.text(c.instructions, { align: 'center', tone: 'muted' }));
    children.push(ui.badge(`${count} ${count === 1 ? 'entry' : 'entries'} so far`, count > 0 ? 'primary' : 'muted'));
    return ui.stack(children, { gap: 'lg', align: 'center' });
  },

  presentation(state, evaluations): PresentationSlide[] {
    const shown = evaluations.filter((e) => e.approved && e.text);
    const slides: PresentationSlide[] = [];
    for (let i = 0; i < shown.length; i += PER_SLIDE) {
      const page = shown.slice(i, i + PER_SLIDE);
      const columns = page.length === 1 ? 1 : page.length <= 4 ? 2 : 3;
      const cells = page.map((e) => ui.card([ui.subtitle(`“${e.text}”`, { align: 'center' }), ui.caption(e.displayName, { align: 'center' })]));
      slides.push({
        caption: shown.length > PER_SLIDE ? `Entries ${i + 1}–${i + page.length} of ${shown.length}` : undefined,
        steps: [ui.stack([ui.title(state.config.prompt, { align: 'center' }), ui.grid(columns, cells, { gap: 'md' })], { gap: 'lg', align: 'stretch' })],
        stepSeconds: Math.max(10, page.length * 3),
      });
    }
    return slides;
  },

  resultsView(state, evaluations) {
    const c = state.config;
    const approved = evaluations.filter((e) => e.approved).sort((a, b) => pointsFor(c, b) - pointsFor(c, a));
    const shared: UINode = ui.stack(
      [
        ui.caption(c.prompt, { align: 'center' }),
        ui.row(
          [ui.badge(`${evaluations.length} ${evaluations.length === 1 ? 'entry' : 'entries'}`), ui.badge(`${approved.length} approved`, approved.length ? 'success' : 'muted')],
          { gap: 'sm', justify: 'center', wrap: true },
        ),
        approved.length
          ? ui.list(approved.slice(0, 8).map((e) => ({ label: `“${e.text}”`, value: `${e.displayName} · +${pointsFor(c, e)}`, highlight: true })))
          : ui.caption('No approved performances yet.', { align: 'center' }),
      ],
      { gap: 'md' },
    );
    return {
      ui: shared,
      guestUi: (player) => {
        const me = evaluations.find((e) => e.playerId === player.id);
        if (!me) return shared;
        const points = pointsFor(c, me);
        return ui.stack(
          [
            ui.caption(c.prompt),
            ui.card([ui.title(`“${me.text}”`, { align: 'center' })], me.approved ? 'success' : 'danger'),
            ui.text(
              me.hostPoints !== null ? `The host gave you ${me.hostPoints} points` : me.approved ? `Approved! +${points} points` : 'Your performance was rejected',
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
