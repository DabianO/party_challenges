import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { HostAction, PresentationMove } from '@challenge/contract';
import { ActivityFeed } from '../../components/ActivityFeed';
import { Leaderboard } from '../../components/Leaderboard';
import { ProgressChart } from '../../components/ProgressChart';
import { StatusBadge } from '../../components/PhaseBadge';
import { QrCode } from '../../components/QrCode';
import { AttentionPanel, attentionCount } from './AttentionPanel';
import { ChallengeControls, type Act } from './ChallengeControls';
import { EvaluationsPanel } from './EvaluationsPanel';
import type { HostCtx } from './hostApi';
import { PlayerList } from './PlayerList';
import { StartOverButton } from './StartOverButton';
import { relativeTime, useNow } from '../../lib/time';

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
            {game.status === 'GAME_RESULTS' && (game.resultsRevealed ? 'Final results are on the big screen' : 'Game over — reveal the results when you are ready')}
            {game.status === 'FINISHED' && 'Closed — the join code no longer works. Continue it or start a new game with this setup.'}
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
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() =>
                void act(
                  { action: 'reopen-game' },
                  'Continue this game? It goes back to in progress with all players and points kept; players can rejoin with the same code. Then reopen the challenges they should play, one by one or all at once.',
                )
              }
            >
              ▶ Continue this game
            </button>
          )}
          {finished && <StartOverButton ctx={ctx} />}
          {finished && (
            <Link className="btn btn-secondary" to={`/results/${ctx.gameId}`} target="_blank">
              Public results page ↗
            </Link>
          )}
        </div>
        {running && <BigScreenPanel ctx={ctx} busy={busy} onUpdate={() => void act({ action: 'publish-standings' })} />}
        {running && ctx.snapshot.spotlightChoices.length > 0 && <SpotlightPanel ctx={ctx} busy={busy} act={act} />}
        {(running || finished) && (ctx.snapshot.presentationDeck.length > 0 || ctx.snapshot.presentation) && <PresentationPanel ctx={ctx} busy={busy} act={act} />}
        {(running || finished) && (
          <div className={`reveal-panel${game.resultsRevealed ? ' is-revealed' : ''}`}>
            <span className="grow stack gap-xs">
              <strong>{game.resultsRevealed ? '★ Results are visible to everyone' : '🙈 Results are hidden'}</strong>
              <span className="muted small">
                {game.resultsRevealed
                  ? 'Players see their points and answers; the big screen shows the leaderboard.'
                  : 'Players only see which challenges they finished. You see all scores here.'}
              </span>
            </span>
            {game.resultsRevealed ? (
              game.status !== 'FINISHED' && (
                <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void act({ action: 'hide-results' })}>
                  Hide again
                </button>
              )
            ) : (
              <button
                type="button"
                className="btn btn-primary btn-lg"
                disabled={busy}
                onClick={() => void act({ action: 'reveal-results' }, 'Reveal all results now? Every player sees what they got right and the big screen shows the leaderboard.')}
              >
                ★ Reveal results
              </button>
            )}
          </div>
        )}
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
          <ProgressChart entries={leaderboard} players={players} challengeCount={challenges.length} />
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

/**
 * The results presentation: closed challenges' slides on the big screen (e.g. every caption,
 * or how the room answered the Hot Takes). The host steps through them (also with the arrow
 * keys) or lets them play by themselves.
 */
function PresentationPanel({ ctx, busy, act }: { ctx: HostCtx; busy: boolean; act: Act }) {
  const { presentation, presentationDeck } = ctx.snapshot;
  const [left, setLeft] = useState<string[]>([]);
  const [autoplay, setAutoplay] = useState(true);
  const picked = presentationDeck.filter((d) => !left.includes(d.instanceId));
  const slides = picked.reduce((n, d) => n + d.slides, 0);
  // Moving on should feel instant (and work while a previous move is still on its way).
  const go = (to: PresentationMove) => void ctx.act({ action: 'move-presentation', to });

  const live = presentation !== null;
  useEffect(() => {
    if (!live) return undefined;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      const to: PresentationMove | null =
        e.key === 'ArrowRight' ? 'next' : e.key === 'ArrowLeft' ? 'previous' : e.key === 'PageDown' ? 'next-slide' : e.key === 'PageUp' ? 'previous-slide' : null;
      if (!to) return;
      e.preventDefault();
      void ctx.act({ action: 'move-presentation', to });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [live, ctx]);

  if (!presentation) {
    return (
      <div className="screen-panel presentation-panel">
        <span className="grow stack gap-xs">
          <strong>🎞 Results presentation</strong>
          <span className="muted small">
            Show what everyone made on the big screen, one slide at a time: {slides} {slides === 1 ? 'slide' : 'slides'} from {picked.length} closed{' '}
            {picked.length === 1 ? 'challenge' : 'challenges'}. Slides show no points.
          </span>
          <span className="presentation-picks">
            {presentationDeck.map((d) => (
              <label key={d.instanceId} className="checkbox-inline">
                <input
                  type="checkbox"
                  checked={!left.includes(d.instanceId)}
                  disabled={busy}
                  onChange={(e) => setLeft((l) => (e.target.checked ? l.filter((id) => id !== d.instanceId) : [...l, d.instanceId]))}
                />{' '}
                {d.title} <span className="muted">({d.slides})</span>
              </label>
            ))}
          </span>
        </span>
        <div className="presentation-start">
          <label className="checkbox-inline">
            <input type="checkbox" checked={autoplay} disabled={busy} onChange={(e) => setAutoplay(e.target.checked)} /> Play by itself
          </label>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || picked.length === 0}
            onClick={() => void act({ action: 'start-presentation', instanceIds: picked.map((d) => d.instanceId), autoplay })}
          >
            🎞 Present
          </button>
        </div>
      </div>
    );
  }

  const p = presentation;
  const atEnd = p.index === p.total - 1 && p.step === p.stepCount - 1;
  const atStart = p.index === 0 && p.step === 0;
  return (
    <div className="screen-panel presentation-panel is-live">
      <span className="grow stack gap-xs">
        <strong>
          🎞 On the big screen: {p.title}
          {p.slideCount > 1 ? ` · slide ${p.slide + 1} of ${p.slideCount}` : ''}
          {p.stepCount > 1 ? ` · ${p.step + 1} of ${p.stepCount}` : ''}
        </strong>
        <span className="muted small">
          Slide {p.index + 1} of {p.total} · {p.autoplay ? 'playing by itself' : atEnd ? 'the end' : 'you move it on'} · ← → step, Page Up / Down slide
        </span>
      </span>
      <div className="presentation-controls">
        <button type="button" className="btn btn-icon btn-secondary" aria-label="Previous slide" title="Previous slide (Page Up)" disabled={atStart} onClick={() => go('previous-slide')}>
          ⏮
        </button>
        <button type="button" className="btn btn-icon btn-secondary" aria-label="Back" title="Back (←)" disabled={atStart} onClick={() => go('previous')}>
          ◀
        </button>
        <button type="button" className="btn btn-icon btn-primary" aria-label="Next" title="Next (→)" disabled={atEnd} onClick={() => go('next')}>
          ▶
        </button>
        <button type="button" className="btn btn-icon btn-secondary" aria-label="Next slide" title="Next slide (Page Down)" disabled={p.index === p.total - 1} onClick={() => go('next-slide')}>
          ⏭
        </button>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void act({ action: 'autoplay-presentation', on: !p.autoplay })}>
          {p.autoplay ? '❙❙ Hold' : atEnd ? '↻ Play again' : '⏵ Play'}
        </button>
        <label className="sr-only" htmlFor="presentation-jump">
          Go to challenge
        </label>
        <select
          id="presentation-jump"
          className="input input-sm"
          value={p.instanceId}
          onChange={(e) => go({ instanceId: e.target.value })}
        >
          {presentationDeck
            .filter((d) => d.included)
            .map((d) => (
              <option key={d.instanceId} value={d.instanceId}>
                {d.title}
              </option>
            ))}
        </select>
        <button type="button" className="btn btn-danger btn-ghost" disabled={busy} onClick={() => void act({ action: 'stop-presentation' })}>
          ■ Stop
        </button>
      </div>
    </div>
  );
}

/**
 * What the big screen's spotlight shows (e.g. a Hot Take). It rotates by itself; the host can
 * put a chosen item on screen now, for a minute or held until they release it.
 */
function SpotlightPanel({ ctx, busy, act }: { ctx: HostCtx; busy: boolean; act: Act }) {
  const { spotlight, spotlightChoices } = ctx.snapshot;
  const keyOf = (c: { instanceId: string; itemId: string }) => `${c.instanceId}/${c.itemId}`;
  const [picked, setPicked] = useState('');
  const [hold, setHold] = useState(false);
  const choice = spotlightChoices.find((c) => keyOf(c) === picked) ?? spotlightChoices[0];
  const onScreen = spotlight ? spotlightChoices.find((c) => keyOf(c) === keyOf(spotlight)) : undefined;
  // Grouped per challenge, in board order.
  const groups = new Map<string, typeof spotlightChoices>();
  for (const c of spotlightChoices) groups.set(c.instanceId, [...(groups.get(c.instanceId) ?? []), c]);

  return (
    <div className="screen-panel spotlight-panel">
      <span className="grow stack gap-xs">
        <strong>
          🗣 Spotlight: {onScreen ? `“${onScreen.label}”` : 'nothing on screen yet'}
          {spotlight?.held ? ' · held' : ''}
        </strong>
        <span className="muted small">
          {spotlight?.held
            ? 'It stays on the big screen until you continue the rotation.'
            : 'A new statement every minute: the one with the most new answers, every one in turn. Pick one to show it now.'}
        </span>
      </span>
      {spotlight?.held && (
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void act({ action: 'release-spotlight' })}>
          ▶ Continue rotation
        </button>
      )}
      <div className="spotlight-pick">
        <label className="sr-only" htmlFor="spotlight-pick">
          Statement to show
        </label>
        <select id="spotlight-pick" className="input" value={choice ? keyOf(choice) : ''} disabled={busy} onChange={(e) => setPicked(e.target.value)}>
          {[...groups.values()].map((items) => (
            <optgroup key={items[0]!.instanceId} label={items[0]!.title}>
              {items.map((c) => (
                <option key={keyOf(c)} value={keyOf(c)}>
                  {c.label} ({c.activity} {c.activity === 1 ? 'answer change' : 'answer changes'})
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <label className="checkbox-inline">
          <input type="checkbox" checked={hold} disabled={busy} onChange={(e) => setHold(e.target.checked)} /> Keep it on screen
        </label>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !choice}
          onClick={() => choice && void act({ action: 'show-spotlight', instanceId: choice.instanceId, itemId: choice.itemId, hold })}
        >
          📺 Show now
        </button>
      </div>
    </div>
  );
}

/** The big screen only shows the race as of the last update, so the host decides when it changes. */
function BigScreenPanel({ ctx, busy, onUpdate }: { ctx: HostCtx; busy: boolean; onUpdate: () => void }) {
  const { standings, standingsFeed } = ctx.snapshot;
  const now = useNow(5000) + ctx.clockOffset;
  const latest = standings ? standingsFeed.filter((f) => f.at === standings.publishedAt) : [];
  return (
    <div className="screen-panel">
      <span className="grow stack gap-xs">
        <strong>📺 Big screen: {standings ? `race as of ${relativeTime(standings.publishedAt, now)}` : 'race not shown yet'}</strong>
        <span className="muted small">
          {standings
            ? latest.length
              ? `Last update: ${latest.map((f) => f.text).join(' · ')}.`
              : 'Last update: no changes in the ranking.'
            : 'Press update to put the current standings and graph on the big screen.'}{' '}
          Phones are not affected.
        </span>
      </span>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={onUpdate}>
        ↻ Update the big screen
      </button>
    </div>
  );
}
