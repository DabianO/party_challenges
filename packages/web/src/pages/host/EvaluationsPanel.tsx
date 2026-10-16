import { useState, type FormEvent } from 'react';
import type { AssignmentStatus, EvaluationRecord, ScoredSubmissionSummary } from '@challenge/contract';
import { UIView } from '../../components/UIRenderer';
import { formatClock, formatPoints } from '../../lib/time';
import type { HostCtx } from './hostApi';

const STATUS: Record<AssignmentStatus, { label: string; tone: string }> = {
  pending: { label: 'Pending', tone: 'tone-warning' },
  approved: { label: 'Approved', tone: 'tone-success' },
  rejected: { label: 'Rejected', tone: 'tone-danger' },
  expired: { label: 'Expired', tone: 'tone-muted' },
  escalated: { label: 'Escalated', tone: 'tone-warning' },
  overridden: { label: 'Overridden', tone: 'tone-primary' },
  cancelled: { label: 'Cancelled', tone: 'tone-muted' },
};

/** FR-55: every evaluation plus scored submissions the host may override. */
export function EvaluationsPanel({ ctx }: { ctx: HostCtx }) {
  const { evaluations, scored } = ctx.snapshot;
  return (
    <details className="card card-flat">
      <summary className="section-title">
        Evaluations <span className="muted">({evaluations.length})</span> · Scored submissions <span className="muted">({scored.length})</span>
      </summary>
      <div className="stack gap-lg panel-body">
        <section className="stack gap-sm">
          <h3 className="eyebrow">Evaluations</h3>
          {evaluations.length === 0 ? <p className="muted small">No judging has happened yet.</p> : <EvaluationsTable rows={evaluations} />}
        </section>
        <section className="stack gap-sm">
          <h3 className="eyebrow">Scored submissions</h3>
          {scored.length === 0 && <p className="muted small">Nothing has been scored yet.</p>}
          <ul className="plain-list stack gap-sm">
            {scored.map((s) => (
              <ScoredRow key={s.submissionId} ctx={ctx} s={s} />
            ))}
          </ul>
        </section>
      </div>
    </details>
  );
}

function EvaluationsTable({ rows }: { rows: EvaluationRecord[] }) {
  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Challenge</th>
            <th scope="col">Player</th>
            <th scope="col">Judge</th>
            <th scope="col">Status</th>
            <th scope="col">Decision</th>
            <th scope="col" className="num">
              Points
            </th>
            <th scope="col">Note</th>
            <th scope="col">Assigned</th>
            <th scope="col">Decided</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const st = STATUS[r.status];
            return (
              <tr key={r.assignmentId}>
                <td>{r.moduleName}</td>
                <td>{r.displayName}</td>
                <td>{r.decidedBy === 'host' ? 'Host' : r.judgeName ?? (r.judgePlayerId ? 'Player' : '—')}</td>
                <td>
                  <span className={`badge ${st.tone}`}>{st.label}</span>
                </td>
                <td>{r.decision ? (r.decision === 'approve' ? '✓ approve' : '✕ reject') : '—'}</td>
                <td className="num mono">{r.points !== null ? formatPoints(r.points) : '—'}</td>
                <td className="muted small">{r.note ?? ''}</td>
                <td className="mono small">{formatClock(r.assignedAt)}</td>
                <td className="mono small">{r.decidedAt !== null ? formatClock(r.decidedAt) : r.deadlineAt !== null ? `due ${formatClock(r.deadlineAt)}` : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ScoredRow({ ctx, s }: { ctx: HostCtx; s: ScoredSubmissionSummary }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="card card-flat stack gap-sm scored-row">
      <div className="row gap-sm wrap align-center">
        <strong className="grow">
          {s.displayName} <span className="muted">· {s.moduleName}</span>
        </strong>
        <span className="points-badge">
          {s.points > 0 ? '+' : ''}
          {formatPoints(s.points)} pts
        </span>
        <span className="muted small mono">{formatClock(s.scoredAt)}</span>
        <button type="button" className="btn btn-secondary btn-sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Close' : 'Override…'}
        </button>
      </div>
      {open && (
        <div className="stack gap-md">
          {s.presentation ? (
            <details>
              <summary className="small">Submission</summary>
              <div className="judge-presentation">
                <UIView key={`${s.submissionId}-presentation`} node={s.presentation} />
              </div>
            </details>
          ) : (
            <p className="muted small">No presentation available for this submission.</p>
          )}
          <OverrideForm ctx={ctx} s={s} onDone={() => setOpen(false)} />
        </div>
      )}
    </li>
  );
}

function OverrideForm({ ctx, s, onDone }: { ctx: HostCtx; s: ScoredSubmissionSummary; onDone: () => void }) {
  const [decision, setDecision] = useState<'approve' | 'reject'>('approve');
  const [points, setPoints] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const n = Number(points);
  const pointsOk = points === '' || Number.isFinite(n);
  const valid = reason.trim().length > 0 && pointsOk;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    const r = await ctx.act({ action: 'override', submissionId: s.submissionId, decision, ...(points !== '' ? { points: n } : {}), reason: reason.trim() });
    setBusy(false);
    if (r) {
      ctx.toast(r.message ?? `Overrode ${s.displayName}'s result`, 'success');
      onDone();
    }
  };

  return (
    <form className="stack gap-sm override-form" onSubmit={submit} aria-label={`Override ${s.displayName}'s result`}>
      <div className="row gap-sm wrap" role="radiogroup" aria-label="New decision">
        {(['approve', 'reject'] as const).map((d) => (
          <button key={d} type="button" role="radio" aria-checked={decision === d} className={`btn btn-secondary btn-sm${decision === d ? ' is-selected' : ''}`} onClick={() => setDecision(d)}>
            {decision === d ? '● ' : '○ '}
            {d === 'approve' ? '✓ Approve' : '✕ Reject'}
          </button>
        ))}
      </div>
      <div className="row gap-sm wrap align-end">
        <label className="field field-compact">
          <span className="field-label">
            Points <span className="muted">(optional)</span>
          </span>
          <input className="input" type="number" step="any" inputMode="decimal" value={points} onChange={(e) => setPoints(e.target.value)} placeholder={`now ${formatPoints(s.points)}`} />
        </label>
        <label className="field field-compact grow">
          <span className="field-label">Reason (required)</span>
          <input className="input" type="text" maxLength={160} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Written to the score ledger" />
        </label>
        <button type="submit" className="btn btn-primary btn-sm" disabled={!valid || busy}>
          Apply override
        </button>
      </div>
      <p className="field-help">Leave points empty to let the module rescore from the new decision. The change is written to the ledger as a manual correction.</p>
    </form>
  );
}
