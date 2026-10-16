import { useState, type FormEvent } from 'react';
import type { ChallengeInstanceSummary, InstanceOptions, ModuleInfo } from '@challenge/contract';
import { AvailabilityBadge, EvaluationBadge, PhaseBadge } from '../../components/PhaseBadge';
import { SchemaForm, configSummary } from '../../components/SchemaForm';
import { api, errorMessage } from '../../lib/api';
import { GameSettingsForm } from './GameSettingsForm';
import { InstanceOptionsFields, DEFAULT_OPTIONS, optionsOf } from './InstanceOptionsFields';
import { Library } from './Library';
import { moduleFor, type HostCtx } from './hostApi';

type Panel = { kind: 'none' } | { kind: 'library' } | { kind: 'add'; module: ModuleInfo } | { kind: 'edit'; instance: ChallengeInstanceSummary; module: ModuleInfo | undefined };

export function SetupTab({ ctx }: { ctx: HostCtx }) {
  const { snapshot, modules } = ctx;
  const { game, challenges, players } = snapshot;
  const [panel, setPanel] = useState<Panel>({ kind: 'none' });
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [options, setOptions] = useState<InstanceOptions>(DEFAULT_OPTIONS);

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
    setOptions(DEFAULT_OPTIONS);
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
    if (!window.confirm(`Remove "${c.moduleName}" from this game?`)) return;
    void run(() => api.removeChallenge(ctx.gameId, ctx.token, c.id), 'Challenge removed');
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
      <section className="stack gap-sm">
        <div className="row align-center justify-between wrap gap-sm">
          <h2 className="section-title">
            Challenges <span className="muted">({challenges.length})</span>
          </h2>
          {panel.kind === 'none' && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setPanel({ kind: 'library' })} disabled={modules.length === 0}>
              + Add challenge
            </button>
          )}
        </div>
        {challenges.length === 0 && <p className="muted">No challenges yet. Add at least one before starting the game.</p>}
        <ol className="plain-list stack gap-sm">
          {challenges.map((c, i) => {
            const mod = moduleFor(modules, c.moduleId);
            const title = c.title ?? configSummary(mod?.configurationSchema, c.configuration);
            const pending = c.phase === 'PENDING';
            return (
              <li key={c.id} className="card card-flat challenge-row">
                <span className="challenge-index mono" aria-hidden="true">
                  {i + 1}
                </span>
                <div className="grow stack gap-xs">
                  <span className="row gap-sm align-center wrap">
                    <strong>{c.moduleName}</strong>
                    <span className="badge tone-muted">{c.moduleCategory}</span>
                    <PhaseBadge phase={c.phase} />
                  </span>
                  {title && <span className="muted small clamp">{title}</span>}
                  <span className="row gap-xs wrap">
                    <AvailabilityBadge availability={c.availability} assignedCount={c.assignedPlayerIds?.length} />
                    <EvaluationBadge mode={c.evaluationMode} />
                  </span>
                  {c.error && (
                    <span className="field-error" role="alert">
                      {c.error}
                    </span>
                  )}
                </div>
                <div className="row gap-xs">
                  <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => openEdit(c)}>
                    Edit
                  </button>
                  <button type="button" className="btn btn-icon" aria-label={`Move ${c.moduleName} up`} disabled={i === 0 || busy} onClick={() => move(i, -1)}>
                    ↑
                  </button>
                  <button type="button" className="btn btn-icon" aria-label={`Move ${c.moduleName} down`} disabled={i === challenges.length - 1 || busy} onClick={() => move(i, 1)}>
                    ↓
                  </button>
                  <button
                    type="button"
                    className="btn btn-icon btn-danger btn-ghost"
                    aria-label={`Remove ${c.moduleName}`}
                    disabled={!pending || busy}
                    title={!pending ? 'Only locked (not yet opened) challenges can be removed' : undefined}
                    onClick={() => remove(c)}
                  >
                    ✕
                  </button>
                </div>
              </li>
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

      <section className="card stack gap-md">
        <GameSettingsForm key={`${game.name}|${JSON.stringify(game.settings)}|${JSON.stringify(game.branding)}`} ctx={ctx} />
      </section>
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
  // The server only accepts configuration changes while the instance is PENDING and was never opened.
  const configEditable = instance.phase === 'PENDING' && instance.stats.started === 0 && module !== undefined;

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
          : 'The configuration is locked because this challenge has already been opened. You can still change who may start it and who evaluates it.'}
      </p>
      {instance.title && <p className="muted small">Current: {instance.title}</p>}
      <form className="stack gap-md" onSubmit={submit}>
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
