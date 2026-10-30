import { useState, type FormEvent } from 'react';
import type { PlayerPublic } from '@challenge/contract';
import { ConnectionDot } from '../../components/Leaderboard';
import { PlayerAvatar } from '../../components/PlayerAvatar';
import { formatPoints } from '../../lib/time';
import type { HostCtx } from './hostApi';

export function PlayerList({ ctx }: { ctx: HostCtx }) {
  const { players, leaderboard } = ctx.snapshot;
  const [open, setOpen] = useState<string | null>(null);
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const totals = new Map(leaderboard.map((e) => [e.playerId, e]));

  if (players.length === 0) return <p className="muted">Nobody has joined yet.</p>;

  const remove = async (p: PlayerPublic) => {
    if (!window.confirm(`Remove ${p.displayName} from the game? They will be disconnected and cannot rejoin with their scores.`)) return;
    const r = await ctx.act({ action: 'remove-player', playerId: p.id });
    if (r) ctx.toast(`${p.displayName} removed`, 'success');
    setOpen(null);
  };

  const free = async (p: PlayerPublic) => {
    const r = await ctx.act({ action: 'free-player', playerId: p.id });
    if (r) ctx.toast(r.message ?? `${p.displayName}'s slot freed`, 'success');
    setOpen(null);
  };

  return (
    <ul className="plain-list player-list">
      {players.map((p) => {
        const entry = totals.get(p.id);
        const isOpen = open === p.id;
        return (
          <li key={p.id} className="player-row-wrap">
            <div className="player-row">
              <ConnectionDot connected={p.connected} />
              <PlayerAvatar player={p} size={28} />
              <span className="grow player-name">
                {p.displayName}
                {entry && (
                  <span className="muted small">
                    {' '}
                    · #{entry.rank} · {formatPoints(entry.total)} pts · {entry.completed} done
                  </span>
                )}
              </span>
              <button
                type="button"
                className="btn btn-icon"
                aria-label={`Actions for ${p.displayName}`}
                aria-expanded={isOpen}
                onClick={() => {
                  setOpen(isOpen ? null : p.id);
                  setAdjusting(null);
                }}
              >
                ⋯
              </button>
            </div>
            {isOpen && (
              <div className="player-actions">
                {adjusting === p.id ? (
                  <AdjustForm
                    ctx={ctx}
                    player={p}
                    onDone={() => {
                      setAdjusting(null);
                      setOpen(null);
                    }}
                    onCancel={() => setAdjusting(null)}
                  />
                ) : (
                  <div className="row gap-sm wrap">
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAdjusting(p.id)}>
                      Adjust score
                    </button>
                    <button type="button" className="btn btn-secondary btn-sm" title="Invalidate this player's device so the name can be reclaimed" onClick={() => void free(p)}>
                      Free slot
                    </button>
                    {p.avatar && (
                      <button type="button" className="btn btn-secondary btn-sm" title="Take this player's selfie off the big screen" onClick={() => void ctx.act({ action: 'clear-avatar', playerId: p.id })}>
                        Remove photo
                      </button>
                    )}
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => void remove(p)}>
                      Remove
                    </button>
                  </div>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function AdjustForm({ ctx, player, onDone, onCancel }: { ctx: HostCtx; player: PlayerPublic; onDone: () => void; onCancel: () => void }) {
  const [points, setPoints] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const n = Number(points);
  const valid = points !== '' && Number.isFinite(n) && n !== 0 && reason.trim().length > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    const r = await ctx.act({ action: 'adjust-score', playerId: player.id, points: n, reason: reason.trim() });
    setBusy(false);
    if (r) {
      ctx.toast(`${n > 0 ? '+' : ''}${formatPoints(n)} pts for ${player.displayName}`, 'success');
      onDone();
    }
  };

  return (
    <form className="row gap-sm wrap align-end" onSubmit={submit}>
      <label className="field field-compact">
        <span className="field-label">Points (±)</span>
        <input className="input" type="number" step="any" inputMode="decimal" value={points} onChange={(e) => setPoints(e.target.value)} placeholder="5 or -3" autoFocus />
      </label>
      <label className="field field-compact grow">
        <span className="field-label">Reason</span>
        <input className="input" type="text" maxLength={120} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Bonus for best costume" />
      </label>
      <button type="submit" className="btn btn-primary btn-sm" disabled={!valid || busy}>
        Apply
      </button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}
