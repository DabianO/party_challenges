import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../../lib/api';
import { saveHostedGame } from '../../lib/storage';
import type { HostCtx } from './hostApi';

/** Create a fresh game with this game's setup (no players or scores) and switch to it. */
export function StartOverButton({ ctx, className = 'btn btn-secondary' }: { ctx: HostCtx; className?: string }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const startOver = async () => {
    const msg =
      'Start a new game with this setup?\n\nThe challenges, titles, settings and branding are copied into a fresh game with no players or scores. ' +
      'This game stays as it is, so you can still open it later.';
    if (!window.confirm(msg)) return;
    setBusy(true);
    try {
      const res = await api.duplicateGame(ctx.gameId, ctx.token);
      saveHostedGame({ id: res.game.id, name: res.game.name, code: res.game.code, hostToken: res.hostToken, createdAt: res.game.createdAt });
      if (res.warnings.length > 0) ctx.toast(`New game created with ${res.warnings.length} warning(s): ${res.warnings.join(' · ')}`, 'warning');
      else ctx.toast(`New game ready — code ${res.game.code}`, 'success');
      navigate(`/host/${res.game.id}`);
    } catch (e) {
      ctx.toast(errorMessage(e), 'danger');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className={className} disabled={busy} onClick={() => void startOver()}>
      {busy ? 'Creating…' : '↺ New game with this setup'}
    </button>
  );
}
