import { useState } from 'react';
import type { HostQueueItem, HostResolutionViewModel, Judgement, UINode } from '@challenge/contract';
import { UIView, hasSubmitButton } from '../../components/UIRenderer';
import { formatClock, formatPoints } from '../../lib/time';
import type { HostCtx } from './hostApi';

const REASONS: Record<string, { label: string; tone: string }> = {
  'host-mode': { label: 'Host judges', tone: 'tone-warning' },
  'escalated-timeout': { label: 'Judge timed out', tone: 'tone-danger' },
  'escalated-rejection': { label: 'Rejected by a player', tone: 'tone-danger' },
  'no-judges': { label: 'No judges available', tone: 'tone-danger' },
};

export function attentionCount(ctx: HostCtx): number {
  return ctx.snapshot.hostQueue.length + ctx.snapshot.resolutions.length;
}

/** "Needs your attention": the host queue (FR-67/68) and instance-level resolutions (onClose modules). */
export function AttentionPanel({ ctx }: { ctx: HostCtx }) {
  const { hostQueue, resolutions } = ctx.snapshot;
  const count = hostQueue.length + resolutions.length;
  return (
    <section className={`card stack gap-md attention${count > 0 ? ' has-items' : ''}`} aria-label="Needs your attention">
      <h2 className="section-title">
        <span aria-hidden="true">⚖</span> Needs your attention
        <span className={`badge ${count > 0 ? 'tone-warning' : 'tone-muted'}`} aria-label={`${count} items`}>
          {count}
        </span>
      </h2>
      {count === 0 && <p className="muted">Nothing waiting for you. Judged submissions and closed challenges that need a decision show up here.</p>}
      {resolutions.map((r) => (
        <ResolutionCard key={r.instanceId} ctx={ctx} instanceId={r.instanceId} moduleName={r.title} form={r.form} />
      ))}
      {hostQueue.map((item) => (
        <QueueCard key={item.assignmentId} ctx={ctx} item={item} />
      ))}
    </section>
  );
}

function PriorJudgements({ judgements }: { judgements: Judgement[] }) {
  if (judgements.length === 0) return null;
  return (
    <div className="stack gap-xs">
      <span className="field-label">Earlier decisions</span>
      <ul className="plain-list stack gap-xs">
        {judgements.map((j) => (
          <li key={j.assignmentId} className="row gap-sm wrap small">
            <span className={`badge ${j.decision === 'approve' ? 'tone-success' : 'tone-danger'}`}>
              <span aria-hidden="true">{j.decision === 'approve' ? '✓' : '✕'}</span> {j.decision === 'approve' ? 'Approved' : 'Rejected'}
            </span>
            <span className="muted">by {j.by === 'peer' ? 'a player' : 'you'}</span>
            {j.points !== undefined && <span className="mono">{formatPoints(j.points)} pts</span>}
            {j.note && <span className="judgement-note">“{j.note}”</span>}
            <span className="muted mono">{formatClock(j.decidedAt)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function QueueCard({ ctx, item }: { ctx: HostCtx; item: HostQueueItem }) {
  const reason = REASONS[item.reason] ?? { label: item.reason, tone: 'tone-muted' };
  const scoring = item.hostScoring;
  const [points, setPoints] = useState<string>(scoring ? String(scoring.max) : '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const n = Number(points);
  const pointsValid = !scoring || (points !== '' && Number.isFinite(n) && n >= scoring.min && n <= scoring.max);

  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(decision);
    const trimmed = note.trim();
    const r = await ctx.act({
      action: 'decide',
      assignmentId: item.assignmentId,
      decision,
      ...(scoring && decision === 'approve' ? { points: n } : {}),
      ...(trimmed ? { note: trimmed } : {}),
    });
    setBusy(null);
    if (r) ctx.toast(r.message ?? (decision === 'approve' ? `Approved ${item.displayName}'s submission` : `Rejected ${item.displayName}'s submission`), 'success');
  };

  return (
    <article className="card card-flat stack gap-md queue-item" aria-label={`Submission by ${item.displayName}`}>
      <div className="row gap-sm wrap align-center">
        <strong className="grow">
          {item.displayName} <span className="muted">· {item.title}</span>
        </strong>
        <span className={`badge ${reason.tone}`}>{reason.label}</span>
        <span className="muted small mono">{formatClock(item.submittedAt)}</span>
      </div>
      <blockquote className="criteria">
        <span className="criteria-label">What to check</span>
        <p>“{item.criteria}”</p>
      </blockquote>
      <div className="judge-presentation">
        <UIView key={`${item.assignmentId}-presentation`} node={item.presentation} />
      </div>
      <PriorJudgements judgements={item.priorJudgements} />
      <div className="row gap-md wrap align-end">
        {scoring && (
          <label className="field field-compact">
            <span className="field-label">
              Points ({scoring.min}–{scoring.max})
            </span>
            <input
              className="input"
              type="number"
              inputMode="decimal"
              min={scoring.min}
              max={scoring.max}
              step={scoring.step ?? 1}
              value={points}
              onChange={(e) => setPoints(e.target.value)}
              aria-invalid={!pointsValid || undefined}
            />
          </label>
        )}
        <label className="field field-compact grow">
          <span className="field-label">
            Note <span className="muted">(optional)</span>
          </span>
          <input className="input" type="text" maxLength={140} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Shown in the evaluation log" />
        </label>
      </div>
      {!pointsValid && (
        <p className="field-error" role="alert">
          Enter points between {scoring?.min} and {scoring?.max} to approve.
        </p>
      )}
      <div className="row gap-sm wrap">
        <button type="button" className="btn btn-danger" disabled={busy !== null} onClick={() => void decide('reject')} aria-busy={busy === 'reject' || undefined}>
          <span aria-hidden="true">✕</span> Reject
        </button>
        <button type="button" className="btn btn-success" disabled={busy !== null || !pointsValid} onClick={() => void decide('approve')} aria-busy={busy === 'approve' || undefined}>
          <span aria-hidden="true">✓</span> Approve{scoring && pointsValid ? ` · ${formatPoints(n)} pts` : ''}
        </button>
      </div>
    </article>
  );
}

function withSubmit(ui: UINode, label: string): UINode {
  return hasSubmitButton(ui) ? ui : { type: 'stack', gap: 'md', children: [ui, { type: 'button', action: 'submit', label, size: 'lg' }] };
}

function ResolutionCard({ ctx, instanceId, moduleName, form }: { ctx: HostCtx; instanceId: string; moduleName: string; form: HostResolutionViewModel | null }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  return (
    <article className="card card-flat stack gap-md resolution-item" aria-label={`Resolve ${moduleName}`}>
      <div className="row gap-sm wrap align-center">
        <strong className="grow">{moduleName}</strong>
        <span className="badge tone-warning">
          <span aria-hidden="true">⚖</span> Needs your decision
        </span>
      </div>
      {form ? (
        <UIView
          key={`${instanceId}-resolution`}
          node={withSubmit(form.ui, form.submitLabel ?? 'Resolve')}
          disabled={busy}
          onSubmit={async (payload) => {
            setBusy(true);
            const r = await ctx.act({ action: 'resolve', instanceId, payload });
            setBusy(false);
            if (r) {
              setMessage(r.message ?? null);
              ctx.toast(r.message ?? 'Resolved — results are being published', r.message ? 'warning' : 'success');
            }
          }}
        />
      ) : (
        <div className="row gap-sm wrap align-center">
          <span className="muted">The module has not produced a resolution form.</span>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void ctx.act({ action: 'retry-evaluation', instanceId })}>
            Retry evaluation
          </button>
        </div>
      )}
      {message && (
        <p className="status-line" role="status">
          {message}
        </p>
      )}
    </article>
  );
}
