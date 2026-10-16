import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { HostAction } from '@challenge/contract';
import { ActivityFeed } from '../../components/ActivityFeed';
import { Leaderboard } from '../../components/Leaderboard';
import { StatusBadge } from '../../components/PhaseBadge';
import { QrCode } from '../../components/QrCode';
import { AttentionPanel, attentionCount } from './AttentionPanel';
import { ChallengeControls, type Act } from './ChallengeControls';
import { EvaluationsPanel } from './EvaluationsPanel';
import type { HostCtx } from './hostApi';
import { PlayerList } from './PlayerList';

export function RunTab({ ctx }: { ctx: HostCtx }) {
  const { snapshot } = ctx;
  const { game, players, leaderboard, joinUrl, challenges, activity } = snapshot;
  const [busy, setBusy] = useState(false);

  const act: Act = async (action: HostAction, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return false;
    setBusy(true);
    const r = await ctx.act(action);
    setBusy(false);
    if (r?.message) ctx.toast(r.message, 'info');
    return r !== null;
  };

  const running = game.status === 'IN_PROGRESS';
  const finished = game.status === 'GAME_RESULTS' || game.status === 'FINISHED';
  const attention = attentionCount(ctx);

  return (
    <div className="run stack gap-lg">
      {game.paused && (
        <div className="banner banner-info" role="status">
          <span className="banner-icon" aria-hidden="true">
            ❙❙
          </span>
          <span className="banner-text">Game paused — players cannot start or submit until you resume.</span>
        </div>
      )}

      {/* 1. Game controls */}
      <section className="card stack gap-md control-panel" aria-label="Game controls">
        <div className="row gap-sm align-center wrap">
          <StatusBadge status={game.status} />
          <strong>
            {game.status === 'DRAFT' && 'Draft — add challenges, then open the lobby'}
            {game.status === 'LOBBY' && `Lobby open — ${players.length} ${players.length === 1 ? 'player' : 'players'} joined`}
            {game.status === 'IN_PROGRESS' && `Board open — ${challenges.filter((c) => c.phase === 'ACTIVE').length} of ${challenges.length} challenges playable`}
            {game.status === 'GAME_RESULTS' && 'Final results are on the big screen'}
            {game.status === 'FINISHED' && 'Finished — the join code no longer works'}
          </strong>
        </div>
        <div className="row gap-sm wrap align-center">
          {game.status === 'DRAFT' && (
            <>
              <button type="button" className="btn btn-primary btn-lg" disabled={busy} onClick={() => void act({ action: 'open-lobby' })}>
                Open lobby
              </button>
              <span className="muted small">Guests can join once the lobby is open.</span>
            </>
          )}
          {game.status === 'LOBBY' && (
            <>
              <button type="button" className="btn btn-primary btn-lg" disabled={busy || challenges.length === 0} onClick={() => void act({ action: 'start-game' })}>
                ▶ Start game
              </button>
              <span className="muted small">{challenges.length === 0 ? 'Add at least one challenge in Setup first.' : 'Opens the board: every "open to all" challenge becomes playable.'}</span>
            </>
          )}
          {running &&
            (game.paused ? (
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act({ action: 'resume' })}>
                ▶ Resume
              </button>
            ) : (
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void act({ action: 'pause' })}>
                ❙❙ Pause
              </button>
            ))}
          {running && (
            <button
              type="button"
              className="btn btn-danger btn-ghost"
              disabled={busy}
              onClick={() => void act({ action: 'end-game' }, 'End the game now? Open challenges close, remaining judgements are cancelled and the final leaderboard is shown.')}
            >
              End game
            </button>
          )}
          {game.status === 'GAME_RESULTS' && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void act({ action: 'close-game' }, 'Close the game? The join code stops working and results become read-only.')}
            >
              Close game
            </button>
          )}
          {finished && (
            <Link className="btn btn-secondary" to={`/results/${ctx.gameId}`} target="_blank">
              Public results page ↗
            </Link>
          )}
        </div>
        {game.status !== 'FINISHED' && (
          <div className="join-panel">
            <QrCode value={joinUrl} size={132} />
            <div className="stack gap-xs">
              <span className="code-big" aria-label={`Join code ${game.code}`}>
                {game.code}
              </span>
              <a className="link small" href={joinUrl} target="_blank" rel="noopener">
                {joinUrl}
              </a>
              <span className="muted small">
                {running && !game.settings.allowLateJoin ? 'Late joining is off — new guests cannot join.' : 'Guests scan the QR or type the code on the start page.'}
              </span>
            </div>
          </div>
        )}
      </section>

      {/* 2. Needs your attention */}
      {(running || finished || attention > 0) && <AttentionPanel ctx={ctx} />}

      {/* 3. Challenges */}
      <section className="stack gap-sm">
        <h2 className="section-title">
          Challenges <span className="muted">({challenges.length})</span>
        </h2>
        {!running && !finished && <p className="muted small">Challenge controls become available once the game starts. Edit the list in Setup.</p>}
        <ChallengeControls ctx={ctx} act={act} busy={busy} />
      </section>

      {/* 4. Players */}
      <section className="stack gap-sm">
        <h2 className="section-title">
          Players <span className="muted">({players.length})</span>
        </h2>
        <PlayerList ctx={ctx} />
      </section>

      {leaderboard.length > 0 && (running || finished) && (
        <section className="stack gap-sm">
          <h2 className="section-title">Leaderboard</h2>
          <Leaderboard entries={leaderboard} showCompleted />
        </section>
      )}

      {/* 5. Evaluations */}
      {(running || finished) && <EvaluationsPanel ctx={ctx} />}

      {/* 6. Activity */}
      <section className="stack gap-sm">
        <h2 className="section-title">Activity</h2>
        <ActivityFeed items={activity} clockOffset={ctx.clockOffset} limit={40} />
      </section>
    </div>
  );
}
