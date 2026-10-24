import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { GameSnapshot, LeaderboardEntry } from '@challenge/contract';
import { ConnectionDot, Leaderboard, rankClass } from '../components/Leaderboard';
import { ProgressChart } from '../components/ProgressChart';
import { QrCode } from '../components/QrCode';
import { UIView } from '../components/UIRenderer';
import { useBranding } from '../lib/branding';
import { resolveMedia } from '../lib/media';
import { useGameSocket } from '../lib/socket';
import { formatPoints, relativeTime, useNow } from '../lib/time';
import { normaliseCode } from './Landing';

const CURSOR_HIDE_MS = 4000;

function useIdleCursor(): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    let timer = window.setTimeout(() => setIdle(true), CURSOR_HIDE_MS);
    const wake = () => {
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), CURSOR_HIDE_MS);
    };
    window.addEventListener('mousemove', wake);
    window.addEventListener('keydown', wake);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('mousemove', wake);
      window.removeEventListener('keydown', wake);
    };
  }, []);
  return idle;
}

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

export function Display() {
  const { code: codeParam } = useParams();
  const code = normaliseCode(codeParam ?? '');
  const sock = useGameSocket(code ? { role: 'main', code } : null);
  const { snapshot, status, fatal } = sock;
  const idle = useIdleCursor();
  useBranding(snapshot?.game.branding, 'dark');

  const logo = resolveMedia(snapshot?.game.branding.logo);
  const hostName = snapshot?.game.branding.hostName;
  const showJoin = snapshot && snapshot.game.status !== 'LOBBY' && snapshot.game.status !== 'FINISHED';

  return (
    <div className={`display${idle ? ' cursor-hidden' : ''}`}>
      <header className="display-header">
        <div className="row gap-md align-center grow">
          {logo && <img className="brand-logo brand-logo-lg" src={logo} alt="" />}
          <div className="stack">
            <span className="display-game-name">{snapshot?.game.name ?? 'Challenge Platform'}</span>
            {hostName && <span className="display-host muted">Hosted by {hostName}</span>}
          </div>
        </div>
        {showJoin && (
          <div className="display-join" aria-label="How to join">
            <QrCode value={snapshot.joinUrl} size={72} label={`QR code to join ${snapshot.game.name}`} />
            <div className="stack">
              <span className="display-join-label muted">
                {snapshot.game.status === 'IN_PROGRESS' && snapshot.game.settings.allowLateJoin ? 'Join now' : 'Game code'}
              </span>
              <span className="display-code-chip">{snapshot.game.code}</span>
              <span className="display-join-url">{shortUrl(snapshot.joinUrl)}</span>
            </div>
          </div>
        )}
      </header>

      <main className="display-body">
        {fatal ? (
          <div className="display-center">
            <h1 className="display-h1">This game code is no longer active</h1>
            <p className="display-p muted">{fatal.message}</p>
          </div>
        ) : !snapshot ? (
          <div className="display-center">
            <p className="display-p muted" role="status">
              Connecting to game {code}…
            </p>
          </div>
        ) : (
          <DisplayBody snapshot={snapshot} clockOffset={sock.clockOffset} />
        )}
      </main>

      {snapshot?.game.paused && (
        <div className="overlay" role="status">
          <div className="overlay-card">
            <span className="overlay-icon" aria-hidden="true">
              ❙❙
            </span>
            <span>Paused</span>
          </div>
        </div>
      )}
      {(status === 'reconnecting' || status === 'connecting') && snapshot && (
        <div className="display-banner" role="alert">
          ⟳ Connection lost — reconnecting…
        </div>
      )}
    </div>
  );
}

function DisplayBody({ snapshot, clockOffset }: { snapshot: GameSnapshot; clockOffset: number }) {
  switch (snapshot.game.status) {
    case 'DRAFT':
      return (
        <div className="display-center">
          <h1 className="display-h1">{snapshot.game.name}</h1>
          <p className="display-p muted">The host is setting things up…</p>
        </div>
      );
    case 'LOBBY':
      return <Lobby snapshot={snapshot} />;
    case 'IN_PROGRESS':
      return <Dashboard snapshot={snapshot} clockOffset={clockOffset} />;
    case 'GAME_RESULTS':
    case 'FINISHED':
      return <Final snapshot={snapshot} />;
  }
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

function Lobby({ snapshot }: { snapshot: GameSnapshot }) {
  const { game, players, joinUrl } = snapshot;
  return (
    <div className="display-lobby">
      <section className="lobby-join">
        <h1 className="display-h1">{game.name}</h1>
        {game.branding.introText && <p className="display-p intro-text">{game.branding.introText}</p>}
        <p className="display-p">
          Join at <strong className="lobby-url">{shortUrl(joinUrl)}</strong>
        </p>
        <div className="lobby-code" aria-label={`Game code ${game.code}`}>
          {game.code}
        </div>
        <QrCode value={joinUrl} size={260} label={`QR code to join ${game.name}`} />
      </section>
      <section className="lobby-players">
        <h2 className="display-h2">
          {players.length} {players.length === 1 ? 'player' : 'players'} joined
        </h2>
        {players.length === 0 ? (
          <p className="display-p muted">Scan the code to be the first!</p>
        ) : (
          <ul className="player-grid">
            {players.map((p) => (
              <li key={p.id} className={`player-chip${p.connected ? '' : ' is-off'}`} title={p.connected ? 'Connected' : 'Disconnected'}>
                {p.displayName}
                {!p.connected && <span className="sr-only"> (disconnected)</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live dashboard
// ---------------------------------------------------------------------------

/** Before results are revealed: who has finished how many challenges, no points or ranks. */
function Progress({ entries, total, limit }: { entries: LeaderboardEntry[]; total: number; limit: number }) {
  if (entries.length === 0) return <p className="display-p muted">No players yet.</p>;
  return (
    <ol className="progress-list" aria-label="Player progress">
      {entries.slice(0, limit).map((e) => (
        <li key={e.playerId} className="progress-row">
          <ConnectionDot connected={e.connected} />
          <span className="progress-name">{e.displayName}</span>
          <span className="progress-count mono">
            <span aria-hidden="true">✓</span> {e.completed}
            <span className="muted">/{total}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The big screen during the game: the points race as the host last published it
 * ("Update the big screen" in the Run tab).
 */
function Dashboard({ snapshot, clockOffset }: { snapshot: GameSnapshot; clockOffset: number }) {
  const { standings, players, challenges } = snapshot;
  const now = useNow(5000) + clockOffset;
  // Live big-screen panels from challenges (e.g. Blob War) take the right half of the screen.
  const panels = challenges.filter((c) => c.displayPanel);
  return (
    <div className={`race${panels.length ? ' has-panels' : ''}`}>
      <section className="race-main" aria-label="The race">
        <div className="race-head">
          <h2 className="display-h2">The race</h2>
          {standings && <span className="race-updated muted">Updated {relativeTime(standings.publishedAt, now)}</span>}
        </div>
        <div className="race-chart">
          {standings ? (
            <ProgressChart
              key={standings.publishedAt}
              entries={standings.entries}
              playerOrder={players.map((p) => p.id)}
              challengeCount={challenges.length}
              size="lg"
              fillHeight
              animate
              showRank
            />
          ) : (
            <div className="race-empty">
              <span className="race-empty-icon" aria-hidden="true">
                🏁
              </span>
              <p className="display-p">The race is on!</p>
              <p className="display-p muted">
                {players.length} {players.length === 1 ? 'player' : 'players'} · the standings appear here when the host updates the scoreboard
              </p>
            </div>
          )}
        </div>
      </section>
      {panels.length > 0 && (
        <div className="race-side">
          {panels.map((c) => (
            <section key={c.id} className="race-panel" aria-label={c.title}>
              <h2 className="display-h2">{c.title}</h2>
              <div className="race-panel-body">
                <UIView node={c.displayPanel} />
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

/** Closing pictures from challenges with a big-screen panel (e.g. Blob War's territory map). */
function Artworks({ snapshot }: { snapshot: GameSnapshot }) {
  const art = snapshot.challenges.filter((c) => c.displayPanel);
  if (art.length === 0) return null;
  return (
    <>
      {art.map((c) => (
        <section key={c.id} className="artwork" aria-label={c.title}>
          <p className="display-eyebrow">{c.title}</p>
          <div className="artwork-body">
            <UIView node={c.displayPanel} />
          </div>
        </section>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Final
// ---------------------------------------------------------------------------

function Podium({ entries }: { entries: LeaderboardEntry[] }) {
  const top = entries.slice(0, 3);
  if (top.length === 0) return <p className="display-p muted">Nobody scored.</p>;
  // Visual order 2 – 1 – 3, with the winner in the middle.
  const order = [top[1], top[0], top[2]].filter((e): e is LeaderboardEntry => e !== undefined);
  return (
    <ol className="podium" aria-label="Top three">
      {order.map((e) => (
        <li key={e.playerId} className={`podium-slot ${rankClass(e.rank)}`}>
          <span className="podium-name">{e.displayName}</span>
          <span className="podium-points">{formatPoints(e.total)} pts</span>
          <span className="podium-step">
            <span className="podium-rank">{e.rank}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function Final({ snapshot }: { snapshot: GameSnapshot }) {
  const { game, leaderboard, challenges, results } = snapshot;
  const withResults = challenges.filter((c) => results[c.id]);
  if (!game.resultsRevealed) {
    return (
      <div className="stack gap-lg">
        <Artworks snapshot={snapshot} />
        <div className="display-center">
          <p className="display-eyebrow">That's a wrap</p>
          <h1 className="display-h1">{game.name}</h1>
          <p className="display-p muted">The results are about to be revealed…</p>
          <Progress entries={leaderboard} total={challenges.length} limit={20} />
        </div>
      </div>
    );
  }
  return (
    <div className="stack gap-lg">
      <Artworks snapshot={snapshot} />
      <div className="display-split">
        <div className="display-center">
          <p className="display-eyebrow">Final results</p>
          <h1 className="display-h1">{game.name}</h1>
          <Podium entries={leaderboard} />
          {game.branding.finalText && <p className="display-p intro-text">{game.branding.finalText}</p>}
        </div>
        <aside className="display-side">
          <h2 className="display-h2">Leaderboard</h2>
          <Leaderboard entries={leaderboard} showDelta={false} showConnection={false} showCompleted size="lg" />
        </aside>
      </div>
      <section className="card stack gap-sm" aria-label="Points race">
        <h2 className="display-h2">The race</h2>
        <ProgressChart entries={leaderboard} playerOrder={snapshot.players.map((p) => p.id)} challengeCount={challenges.length} size="lg" height={420} />
      </section>
      {withResults.length > 0 && (
        <section className="stack gap-md">
          <h2 className="display-h2">Challenge results</h2>
          <div className="results-grid">
            {withResults.map((c) => (
              <article key={c.id} className="card results-card">
                <p className="display-eyebrow">{c.title}</p>
                <UIView key={`${c.id}-final`} node={results[c.id]!.ui} className="ui-display ui-display-compact" />
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
