import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useParams } from 'react-router-dom';
import type { GameSnapshot, LeaderboardEntry, SpotlightView } from '@challenge/contract';
import { ConnectionDot, Leaderboard, rankClass } from '../components/Leaderboard';
import { PlayerAvatar } from '../components/PlayerAvatar';
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
    <div className={`display${idle ? ' cursor-hidden' : ''}${snapshot?.game.status === 'IN_PROGRESS' && !fatal ? ' is-dashboard' : ''}`}>
      <header className="display-header">
        <div className="display-brand">{logo && <img className="brand-logo brand-logo-lg" src={logo} alt="" />}</div>
        <div className="display-title">
          <span className="display-game-name">{snapshot?.game.name ?? 'Challenge Platform'}</span>
          {hostName && <span className="display-host muted">Hosted by {hostName}</span>}
        </div>
        {showJoin ? (
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
        ) : (
          <span aria-hidden="true" />
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
  const { standings, players, challenges, spotlight } = snapshot;
  const now = useNow(5000) + clockOffset;
  // Everything shares one screen, never scrolling: the race, live panels from challenges
  // (e.g. Blob War) and the spotlight (e.g. Hot Takes), in a grid of up to 2 × 2 (more rows if needed).
  const panels = challenges.filter((c) => c.displayPanel);
  const tiles = 1 + panels.length + (spotlight ? 1 : 0);
  return (
    <div className="dashboard">
      <PlayerKey snapshot={snapshot} />
      <div className={`race tiles-${Math.min(tiles, 5)}`}>
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
              players={players}
              challengeCount={challenges.length}
              size="lg"
              fillHeight
              animate
              legend={false}
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
      {/* Reading order: race, the first live panel, the spotlight, then any other panels. */}
      {panels.slice(0, 1).map(panelTile)}
      {spotlight && <Spotlight spot={spotlight} clockOffset={clockOffset} />}
      {panels.slice(1).map(panelTile)}
      </div>
    </div>
  );
}

/** Tallest row in the key, and the text size as a share of the row. */
const KEY_ROW_MAX = 34;
const KEY_TEXT_SHARE = 0.6;

/**
 * Every player's colour, once for the whole screen (the graph, the blobs and anything else
 * that colours players). In the order of the last published standings, with the rank, so it
 * doubles as the leaderboard; players who joined since come last. One column: names are never
 * shortened (the key is as wide as the longest name) and rows and text shrink to fit everyone.
 */
function PlayerKey({ snapshot }: { snapshot: GameSnapshot }) {
  const { players, standings } = snapshot;
  const ref = useRef<HTMLElement>(null);
  const [rowHeight, setRowHeight] = useState(KEY_ROW_MAX);
  const rows = Math.max(1, players.length);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const pad = parseFloat(getComputedStyle(el).paddingTop) + parseFloat(getComputedStyle(el).paddingBottom);
      setRowHeight(Math.min(KEY_ROW_MAX, (el.clientHeight - pad) / rows));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rows]);

  if (players.length === 0) return null;
  const rankOf = new Map((standings?.entries ?? []).map((e, i) => [e.playerId, { rank: e.rank, order: i }] as const));
  const ordered = [...players].sort((a, b) => (rankOf.get(a.id)?.order ?? Infinity) - (rankOf.get(b.id)?.order ?? Infinity));
  const fontSize = Math.max(7, Math.min(16, rowHeight * KEY_TEXT_SHARE));
  const style = { '--key-rows': rows, '--key-row-max': `${KEY_ROW_MAX}px`, fontSize: `${fontSize}px` } as CSSProperties;
  return (
    <aside ref={ref} className="player-key" aria-label="Players and their colours" style={style}>
      <ol className="player-key-list">
        {ordered.map((p) => {
          const rank = rankOf.get(p.id)?.rank;
          return (
            <li key={p.id} className={p.connected ? undefined : 'is-off'}>
              <PlayerAvatar player={p} size={Math.max(10, Math.round(rowHeight * 0.86))} />
              {rank !== undefined && <span className="player-key-rank">{rank}</span>}
              <span className="player-key-name">{p.displayName}</span>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

/**
 * A bar that runs down until the spotlight moves on. Where it starts is worked out once, when
 * the item appears: recomputing it on every snapshot would restart the animation further
 * along each time and make the bar run out early.
 */
function SpotlightTime({ startedAt, endsAt, clockOffset }: { startedAt: number; endsAt: number; clockOffset: number }) {
  const [timing] = useState(() => {
    const duration = Math.max(1, endsAt - startedAt);
    const elapsed = Math.min(duration, Math.max(0, Date.now() + clockOffset - startedAt));
    return { animationDuration: `${duration}ms`, animationDelay: `-${elapsed}ms` };
  });
  return (
    <span className="spotlight-time" aria-hidden="true">
      <span style={timing} />
    </span>
  );
}

function panelTile(c: GameSnapshot['challenges'][number]) {
  return (
    <section key={c.id} className="race-panel" aria-label={c.title}>
      <h2 className="display-h2">{c.title}</h2>
      <div className="race-panel-body">
        <UIView node={c.displayPanel} />
      </div>
    </section>
  );
}

/** One statement (or other module spotlight item) for a minute, with a bar running down the time, or held by the host. */
function Spotlight({ spot, clockOffset }: { spot: SpotlightView; clockOffset: number }) {
  return (
    <section className="race-panel race-spotlight" aria-label={spot.category || spot.title}>
      <div className="race-head">
        <h2 className="display-h2">{spot.category || spot.title}</h2>
        <span className="race-updated muted">
          {[spot.category && spot.category !== spot.title ? spot.title : '', !spot.held && spot.total > 1 ? `${spot.total} take turns` : ''].filter(Boolean).join(' · ')}
        </span>
      </div>
      {!spot.held && <SpotlightTime key={spot.startedAt} startedAt={spot.startedAt} endsAt={spot.endsAt} clockOffset={clockOffset} />}
      <div className="race-panel-body">
        <UIView key={`${spot.instanceId}/${spot.itemId}`} node={spot.ui} className="ui-display ui-spotlight" />
      </div>
    </section>
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
        <ProgressChart entries={leaderboard} players={snapshot.players} challengeCount={challenges.length} size="lg" height={420} />
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
