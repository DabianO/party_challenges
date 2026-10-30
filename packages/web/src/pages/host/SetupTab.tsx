import { Fragment, useState, type FormEvent } from 'react';
import type { ChallengeInstanceSummary, InstanceOptions, ModuleInfo } from '@challenge/contract';
import { AvailabilityBadge, EvaluationBadge, PhaseBadge } from '../../components/PhaseBadge';
import { SchemaForm, configSummary } from '../../components/SchemaForm';
import { api, errorMessage } from '../../lib/api';
import { GameSettingsForm } from './GameSettingsForm';
import { BackupCard } from './BackupCard';
import { InstanceOptionsFields, DEFAULT_OPTIONS, TitleField, categoriesOf, optionsOf } from './InstanceOptionsFields';
import { Library } from './Library';
import { moduleFor, subtitleOf, type HostCtx } from './hostApi';

/** How the setup list is sorted: as players' boards show it, or for finding things. */
type SortBy = 'board' | 'category' | 'name';

const SORTS: { value: SortBy; label: string }[] = [
  { value: 'board', label: 'Board order' },
  { value: 'category', label: 'Category' },
  { value: 'name', label: 'Name' },
];

function sortChallenges(list: ChallengeInstanceSummary[], by: SortBy): ChallengeInstanceSummary[] {
  if (by === 'board') return list;
  const byName = (a: ChallengeInstanceSummary, b: ChallengeInstanceSummary) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
  if (by === 'name') return [...list].sort(byName);
  // By category (uncategorised last), then by board order.
  return [...list].sort((a, b) => (a.category === '' ? 1 : 0) - (b.category === '' ? 1 : 0) || a.category.localeCompare(b.category, undefined, { sensitivity: 'base' }) || a.sortOrder - b.sortOrder);
}

type Panel = { kind: 'none' } | { kind: 'library' } | { kind: 'add'; module: ModuleInfo } | { kind: 'edit'; instance: ChallengeInstanceSummary; module: ModuleInfo | undefined };

export function SetupTab({ ctx }: { ctx: HostCtx }) {
  const { snapshot, modules } = ctx;
  const { game, challenges, players } = snapshot;
  const [panel, setPanel] = useState<Panel>({ kind: 'none' });
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [options, setOptions] = useState<InstanceOptions>(DEFAULT_OPTIONS);
  const [sortBy, setSortBy] = useState<SortBy>('board');
  const categories = categoriesOf(challenges);
  const shown = sortChallenges(challenges, sortBy);

  const run = async (fn: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    setFormError(null);
    try {
      await fn();
      if (success) ctx.toast(success, 'success');
      return true;
    } catch (e) {
      const msg = errorMessage(e);
      setFormError(msg);
      if (panel.kind === 'none' || panel.kind === 'library') ctx.toast(msg, 'danger');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const openAdd = (m: ModuleInfo) => {
    setOptions({ ...DEFAULT_OPTIONS, category: m.manifest.suggestedCategory ?? '' });
    setFormError(null);
    setPanel({ kind: 'add', module: m });
  };
  const openEdit = (c: ChallengeInstanceSummary) => {
    const mod = moduleFor(modules, c.moduleId);
    setOptions(optionsOf(c, mod?.manifest.evaluation.mode));
    setFormError(null);
    setPanel({ kind: 'edit', instance: c, module: mod });
  };
  const close = () => {
    setFormError(null);
    setPanel({ kind: 'none' });
  };

  const remove = (c: ChallengeInstanceSummary) => {
    const played = c.stats.started;
    const warning = played > 0 ? `\n\n${played} ${played === 1 ? 'player has' : 'players have'} played it; the points they earned with it are taken back.` : '';
    if (!window.confirm(`Remove "${c.title}" from this game?${warning}`)) return;
    void run(() => api.removeChallenge(ctx.gameId, ctx.token, c.id), 'Challenge removed');
  };

  const applyOrder = () => {
    if (!window.confirm(`Use this order (by ${sortBy}) on the players' boards?`)) return;
    void run(() => api.reorderChallenges(ctx.gameId, ctx.token, shown.map((c) => c.id)), 'Board order updated');
    setSortBy('board');
  };

  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= challenges.length) return;
    const order = challenges.map((c) => c.id);
    const [id] = order.splice(index, 1);
    order.splice(target, 0, id as string);
    void run(() => api.reorderChallenges(ctx.gameId, ctx.token, order));
  };

  return (
    <div className="setup stack gap-lg">
      <details className="card settings-details">
        <summary>
          <span className="section-title">⚙ Game settings</span>
          <span className="muted small">Name, late joining, evaluation, branding</span>
        </summary>
        <GameSettingsForm key={`${game.name}|${JSON.stringify(game.settings)}|${JSON.stringify(game.branding)}`} ctx={ctx} />
      </details>

      <section className="stack gap-sm">
        <div className="row align-center justify-between wrap gap-sm">
          <h2 className="section-title">
            Challenges <span className="muted">({challenges.length})</span>
          </h2>
          <div className="row align-center gap-sm wrap">
            {challenges.length > 1 && (
              <label className="row align-center gap-xs small setup-sort">
                <span className="muted">Sort</span>
                <select className="input input-sm" value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)}>
                  {SORTS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {panel.kind === 'none' && (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setPanel({ kind: 'library' })} disabled={modules.length === 0}>
                + Add challenge
              </button>
            )}
          </div>
        </div>
        {challenges.length === 0 && <p className="muted">No challenges yet. Add at least one before starting the game.</p>}
        {sortBy !== 'board' && (
          <p className="muted small row align-center gap-sm wrap">
            Sorted by {sortBy}; players' boards keep the board order.
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={applyOrder}>
              Use this order on the board
            </button>
          </p>
        )}
        <ol className="plain-list setup-list">
          {shown.map((c, i) => {
            const mod = moduleFor(modules, c.moduleId);
            const summary = c.summary ?? configSummary(mod?.configurationSchema, c.configuration);
            const subtitle = subtitleOf(c, summary);
            const boardIndex = challenges.indexOf(c);
            const heading = sortBy === 'category' && (i === 0 || shown[i - 1]!.category !== c.category);
            return (
              <Fragment key={c.id}>
                {heading && <li className="setup-group eyebrow">{c.category || 'No category'}</li>}
                <li className="challenge-row">
                  <span className="challenge-index mono" aria-hidden="true">
                    {boardIndex + 1}
                  </span>
                  <div className="challenge-row-main">
                    <span className="challenge-row-title">
                      {c.category && sortBy !== 'category' && <span className="badge tone-muted">{c.category}</span>}
                      <strong title={c.title}>{c.title}</strong>
                    </span>
                    <span className="challenge-row-meta muted small">
                      <PhaseBadge phase={c.phase} availability={c.availability} started={game.startedAt !== null} />
                      {c.availability !== 'open' && <AvailabilityBadge availability={c.availability} assignedCount={c.assignedPlayerIds?.length} />}
                      {c.evaluationMode !== 'automatic' && <EvaluationBadge mode={c.evaluationMode} />}
                      {c.allowReplay && <span className="badge tone-primary">↻</span>}
                      <span className="challenge-row-sub" title={subtitle || undefined}>
                        {subtitle || c.moduleName}
                      </span>
                    </span>
                    {c.error && (
                      <span className="field-error" role="alert">
                        {c.error}
                      </span>
                    )}
                  </div>
                  <div className="challenge-row-actions">
                    <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => openEdit(c)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn btn-icon btn-sm"
                      aria-label={`Move ${c.title} up`}
                      title={sortBy !== 'board' ? 'Sort by board order to move challenges' : undefined}
                      disabled={sortBy !== 'board' || boardIndex === 0 || busy}
                      onClick={() => move(boardIndex, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn btn-icon btn-sm"
                      aria-label={`Move ${c.title} down`}
                      title={sortBy !== 'board' ? 'Sort by board order to move challenges' : undefined}
                      disabled={sortBy !== 'board' || boardIndex === challenges.length - 1 || busy}
                      onClick={() => move(boardIndex, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="btn btn-icon btn-sm btn-danger btn-ghost"
                      aria-label={`Remove ${c.title}`}
                      disabled={busy || game.status === 'FINISHED'}
                      onClick={() => remove(c)}
                    >
                      ✕
                    </button>
                  </div>
                </li>
              </Fragment>
            );
          })}
        </ol>
      </section>

      {panel.kind === 'library' && <Library modules={modules} onPick={openAdd} onClose={close} />}

      {panel.kind === 'add' && (
        <section className="card stack gap-md" aria-label="Configure challenge">
          <PanelHeading eyebrow="New challenge" module={panel.module} />
          <SchemaForm
            key={`add-${panel.module.manifest.id}`}
            schema={panel.module.configurationSchema}
            submitLabel="Add to game"
            busy={busy}
            serverError={formError}
            upload={ctx.upload}
            leading={<TitleField idPrefix="add" value={options} onChange={setOptions} module={panel.module} categories={categories} disabled={busy} />}
            extra={<InstanceOptionsFields idPrefix="add" value={options} onChange={setOptions} players={players} module={panel.module} disabled={busy} />}
            onCancel={() => {
              setFormError(null);
              setPanel({ kind: 'library' });
            }}
            onSubmit={async (configuration) => {
              const ok = await run(() => api.addChallenge(ctx.gameId, ctx.token, panel.module.manifest.id, { configuration, ...options }), 'Challenge added');
              if (ok) setPanel({ kind: 'none' });
            }}
          />
        </section>
      )}

      {panel.kind === 'edit' && (
        <EditPanel
          ctx={ctx}
          instance={panel.instance}
          module={panel.module}
          options={options}
          setOptions={setOptions}
          busy={busy}
          error={formError}
          onCancel={close}
          onSave={async (body) => {
            const ok = await run(() => api.updateChallenge(ctx.gameId, ctx.token, panel.instance.id, body), 'Challenge updated');
            if (ok) setPanel({ kind: 'none' });
          }}
        />
      )}

      <BackupCard ctx={ctx} />
    </div>
  );
}

function PanelHeading({ eyebrow, module, name }: { eyebrow: string; module: ModuleInfo | undefined; name?: string }) {
  return (
    <div className="stack gap-xs">
      <p className="eyebrow">{eyebrow}</p>
      <h2 className="section-title">{module?.manifest.name ?? name ?? 'Challenge'}</h2>
      {module && <p className="muted small">{module.manifest.description}</p>}
    </div>
  );
}

function EditPanel({
  ctx,
  instance,
  module,
  options,
  setOptions,
  busy,
  error,
  onCancel,
  onSave,
}: {
  ctx: HostCtx;
  instance: ChallengeInstanceSummary;
  module: ModuleInfo | undefined;
  options: InstanceOptions;
  setOptions: (o: InstanceOptions) => void;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (body: { configuration?: Record<string, unknown> } & InstanceOptions) => Promise<void>;
}) {
  const { players } = ctx.snapshot;
  // The server accepts configuration changes while nobody has played it (never opened, or reset).
  const unplayed = instance.stats.attempts === 0 && (instance.phase === 'PENDING' || instance.phase === 'ACTIVE');
  const configEditable = unplayed && module !== undefined;

  if (configEditable) {
    return (
      <section className="card stack gap-md" aria-label="Edit challenge">
        <PanelHeading eyebrow="Edit challenge" module={module} name={instance.moduleName} />
        <SchemaForm
          key={instance.id}
          schema={module.configurationSchema}
          initialValue={instance.configuration}
          submitLabel="Save changes"
          busy={busy}
          serverError={error}
          upload={ctx.upload}
          leading={<TitleField idPrefix="edit" value={options} onChange={setOptions} module={module} categories={categoriesOf(ctx.snapshot.challenges)} disabled={busy} />}
          extra={<InstanceOptionsFields idPrefix="edit" value={options} onChange={setOptions} players={players} module={module} disabled={busy} />}
          onCancel={onCancel}
          onSubmit={(configuration) => onSave({ configuration, ...options })}
        />
      </section>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void onSave(options);
  };
  return (
    <section className="card stack gap-md" aria-label="Edit challenge">
      <PanelHeading eyebrow="Edit challenge" module={module} name={instance.moduleName} />
      <p className="field-help">
        {module === undefined
          ? 'This module is not installed on the server any more, so its configuration cannot be edited.'
          : 'The configuration is locked because players have already played this challenge. You can still change its title, category, who may start it and who evaluates it. To change everything, reset it in the Run tab first (their attempts are discarded and points from it are reversed).'}
      </p>
      {instance.summary && <p className="muted small">Current: {instance.summary}</p>}
      <form className="stack gap-md" onSubmit={submit}>
        <TitleField idPrefix="edit" value={options} onChange={setOptions} module={module} categories={categoriesOf(ctx.snapshot.challenges)} disabled={busy} />
        <InstanceOptionsFields idPrefix="edit" value={options} onChange={setOptions} players={players} module={module} disabled={busy} />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save options'}
          </button>
        </div>
      </form>
    </section>
  );
}
