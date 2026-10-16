import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { ChallengeInstanceSummary, ChallengeResults, GameSnapshot, LeaderboardEntry } from '@challenge/contract';
import { ActivityFeed } from '../components/ActivityFeed';
import { Leaderboard, rankClass } from '../components/Leaderboard';
import { EvaluationBadge, PhaseBadge } from '../components/PhaseBadge';
import { QrCode } from '../components/QrCode';
import { UIView } from '../components/UIRenderer';
import { useBranding } from '../lib/branding';
import { resolveMedia } from '../lib/media';
import { useGameSocket } from '../lib/socket';
import { formatPoints } from '../lib/time';
import { normaliseCode } from './Landing';

const CURSOR_HIDE_MS = 4000;
const SPOTLIGHT_MS = 15000;

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

function Dashboard({ snapshot, clockOffset }: { snapshot: GameSnapshot; clockOffset: number }) {
  const { leaderboard, challenges, activity, results, players } = snapshot;
  const withResults = challenges.filter((c) => c.phase === 'RESULTS' && results[c.id]);
  return (
    <div className="dash">
      <section className="dash-col dash-leaderboard" aria-label="Leaderboard">
        <h2 className="display-h2">Leaderboard</h2>
        {leaderboard.length === 0 ? (
          <p className="display-p muted">{players.length} players, no points yet.</p>
        ) : (
          <Leaderboard entries={leaderboard} limit={10} showDelta showConnection showCompleted size="lg" />
        )}
        {leaderboard.length > 10 && <p className="muted">+{leaderboard.length - 10} more players</p>}
      </section>

      <section className="dash-col dash-board" aria-label="Challenge board">
        <h2 className="display-h2">
          Challenges <span className="muted">({challenges.length})</span>
        </h2>
        <ul className="plain-list dash-cards">
          {challenges.map((c) => (
            <DisplayChallengeCard key={c.id} c={c} playerCount={players.length} hasResults={Boolean(results[c.id])} />
          ))}
        </ul>
        {withResults.length > 0 && <Spotlight instances={withResults} results={results} />}
      </section>

      <section className="dash-col dash-activity" aria-label="Live activity">
        <h2 className="display-h2">Live</h2>
        <ActivityFeed items={activity} clockOffset={clockOffset} limit={14} size="lg" emptyText="Waiting for the first move…" />
      </section>
    </div>
  );
}

function DisplayChallengeCard({ c, playerCount, hasResults }: { c: ChallengeInstanceSummary; playerCount: number; hasResults: boolean }) {
  const secret = c.availability === 'assigned';
  const s = c.stats;
  return (
    <li className={`dash-card phase-${c.phase}${secret ? ' is-secret' : ''}`}>
      <div className="dash-card-head">
        <PhaseBadge phase={c.phase} />
        {!secret && <span className="badge tone-muted">{c.moduleCategory}</span>}
      </div>
      <h3 className="dash-card-title">{secret ? 'Secret challenge' : c.moduleName}</h3>
      {secret ? (
        <p className="muted dash-card-desc">
          <span aria-hidden="true">🎯</span> Assigned to selected players
        </p>
      ) : (
        <p className="muted dash-card-desc">{c.moduleDescription}</p>
      )}
      <div className="dash-card-foot">
        <EvaluationBadge mode={c.evaluationMode} short />
        {c.phase !== 'PENDING' && (
          <span className="dash-stats mono" aria-label={`${s.started} started, ${s.submitted} submitted, ${s.scored} scored`}>
            <span title="Started">▶ {s.started}</span>
            <span title="Submitted">📨 {s.submitted}</span>
            <span title="Scored">🏅 {s.scored}</span>
            {playerCount > 0 && <span className="muted">/ {playerCount}</span>}
          </span>
        )}
      </div>
      {c.phase !== 'PENDING' && (s.averagePoints !== null || s.bestPoints !== null) && (
        <p className="dash-points mono muted">
          {s.averagePoints !== null && <span>avg {formatPoints(s.averagePoints)}</span>}
          {s.bestPoints !== null && <span>best {formatPoints(s.bestPoints)}</span>}
        </p>
      )}
      {hasResults && (
        <p className="dash-card-results">
          <span aria-hidden="true">★</span> Results below
        </p>
      )}
    </li>
  );
}

/** Rotates through the shared results of closed challenges. */
function Spotlight({ instances, results }: { instances: ChallengeInstanceSummary[]; results: Record<string, ChallengeResults> }) {
  const [index, setIndex] = useState(0);
  const count = instances.length;
  useEffect(() => {
    if (count <= 1) return;
    const id = window.setInterval(() => setIndex((i) => (i + 1) % count), SPOTLIGHT_MS);
    return () => window.clearInterval(id);
  }, [count]);
  const current = instances[Math.min(index, count - 1)];
  const res = current ? results[current.id] : undefined;
  if (!current || !res) return null;
  return (
    <section className="spotlight" aria-live="polite" aria-label="Challenge results">
      <div className="spotlight-head">
        <p className="display-eyebrow">
          <span aria-hidden="true">★</span> Results · {current.moduleName}
        </p>
        {count > 1 && (
          <span className="spotlight-dots" aria-label={`${index + 1} of ${count}`}>
            {instances.map((inst, i) => (
              <span key={inst.id} className={`spotlight-dot${i === index ? ' is-active' : ''}`} aria-hidden="true" />
            ))}
            <span className="muted mono small">
              {index + 1}/{count}
            </span>
          </span>
        )}
      </div>
      <UIView key={`${current.id}-spotlight`} node={res.ui} className="ui-display ui-display-compact" />
    </section>
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
  return (
    <div className="stack gap-lg">
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
      {withResults.length > 0 && (
        <section className="stack gap-md">
          <h2 className="display-h2">Challenge results</h2>
          <div className="results-grid">
            {withResults.map((c) => (
              <article key={c.id} className="card results-card">
                <p className="display-eyebrow">{c.moduleName}</p>
                <UIView key={`${c.id}-final`} node={results[c.id]!.ui} className="ui-display ui-display-compact" />
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
