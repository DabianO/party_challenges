import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Leaderboard } from '../components/Leaderboard';
import { ProgressChart } from '../components/ProgressChart';
import { EvaluationBadge, PhaseBadge, StatusBadge } from '../components/PhaseBadge';
import { UIView } from '../components/UIRenderer';
import { api, errorMessage, type PublicResultsResponse } from '../lib/api';
import { useBranding } from '../lib/branding';
import { formatDate, formatPoints } from '../lib/time';

export function PublicResults() {
  const { gameId = '' } = useParams();
  const [data, setData] = useState<PublicResultsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useBranding(data?.game.branding);

  useEffect(() => {
    let cancelled = false;
    api
      .publicResults(gameId)
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [gameId]);

  if (error) {
    return (
      <main className="page page-narrow center-text stack gap-md">
        <h1>Results unavailable</h1>
        <p role="alert">{error}</p>
        <Link className="btn btn-secondary" to="/">
          Back to start
        </Link>
      </main>
    );
  }
  if (!data) {
    return (
      <main className="page page-narrow center-text">
        <p className="muted" role="status">
          Loading results…
        </p>
      </main>
    );
  }

  const { game, leaderboard, challenges, players } = data;
  const results = data.results ?? {};
  return (
    <main className="page page-narrow stack gap-lg">
      <header className="stack gap-xs">
        <p className="eyebrow">Results</p>
        <h1>{game.name}</h1>
        <div className="row gap-sm wrap align-center">
          <StatusBadge status={game.status} />
          {game.finishedAt && <span className="muted">Finished {formatDate(game.finishedAt)}</span>}
        </div>
        {game.branding.finalText && <p className="intro-text">{game.branding.finalText}</p>}
      </header>

      <section className="stack gap-sm">
        <h2 className="section-title">Leaderboard</h2>
        {game.resultsRevealed ? (
          <>
            <Leaderboard entries={leaderboard} showDelta={false} showConnection={false} showCompleted />
            <ProgressChart entries={leaderboard} players={players} challengeCount={challenges.length} />
          </>
        ) : (
          <p className="muted">The host has not revealed the results yet.</p>
        )}
      </section>

      <section className="stack gap-sm">
        <h2 className="section-title">Challenges</h2>
        <ol className="plain-list stack gap-sm">
          {challenges.map((c, i) => {
            const res = results[c.id];
            return (
              <li key={c.id} className="card card-flat stack gap-sm">
                <div className="row gap-sm align-center wrap">
                  <span className="mono muted">{i + 1}</span>
                  <span className="grow stack gap-xs">
                    <strong>{c.availability === 'assigned' ? 'Secret challenge' : c.title}</strong>
                    <span className="row gap-xs wrap">
                      <span className="badge tone-muted">{c.moduleCategory}</span>
                      <EvaluationBadge mode={c.evaluationMode} short />
                    </span>
                  </span>
                  <PhaseBadge phase={c.phase} />
                </div>
                {c.phase !== 'PENDING' && (
                  <p className="muted small mono">
                    {c.stats.started} started · {c.stats.submitted} submitted · {c.stats.scored} scored
                    {c.stats.averagePoints !== null && ` · avg ${formatPoints(c.stats.averagePoints)}`}
                  </p>
                )}
                {res && <UIView key={`${c.id}-public`} node={res.ui} />}
              </li>
            );
          })}
        </ol>
      </section>

      <p className="muted">
        {players.length} {players.length === 1 ? 'player' : 'players'} took part.
      </p>
    </main>
  );
}
