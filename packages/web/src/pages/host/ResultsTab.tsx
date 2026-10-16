import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ChallengeResults, ScoreLedgerEntry } from '@challenge/contract';
import { Leaderboard } from '../../components/Leaderboard';
import { EvaluationBadge, PhaseBadge } from '../../components/PhaseBadge';
import { api, errorMessage } from '../../lib/api';
import { formatClock, formatPoints } from '../../lib/time';
import { statsLine } from './ChallengeControls';
import type { HostCtx } from './hostApi';
import { ResultsDetail, nameOf } from './ResultsBits';

type Loaded = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ok'; results: ChallengeResults | null };

export function ResultsTab({ ctx }: { ctx: HostCtx }) {
  const { game, leaderboard, challenges, players, results } = ctx.snapshot;
  const [open, setOpen] = useState<Record<string, Loaded>>({});
  const [ledger, setLedger] = useState<ScoreLedgerEntry[] | null>(null);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  const leaderboardKey = leaderboard.map((e) => `${e.playerId}:${e.total}`).join('|');

  useEffect(() => {
    let cancelled = false;
    api
      .ledger(ctx.gameId, ctx.token)
      .then((l) => {
        if (!cancelled) {
          setLedger(l);
          setLedgerError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setLedgerError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [ctx.gameId, ctx.token, leaderboardKey]);

  const toggle = async (instanceId: string) => {
    if (open[instanceId]) {
      setOpen((o) => {
        const { [instanceId]: _drop, ...rest } = o;
        return rest;
      });
      return;
    }
    const fromSnapshot = results[instanceId];
    if (fromSnapshot) {
      setOpen((o) => ({ ...o, [instanceId]: { state: 'ok', results: fromSnapshot } }));
      return;
    }
    setOpen((o) => ({ ...o, [instanceId]: { state: 'loading' } }));
    try {
      const fetched = await api.challengeResults(ctx.gameId, ctx.token, instanceId);
      setOpen((o) => ({ ...o, [instanceId]: { state: 'ok', results: fetched } }));
    } catch (e) {
      setOpen((o) => ({ ...o, [instanceId]: { state: 'error', message: errorMessage(e) } }));
    }
  };

  return (
    <div className="stack gap-lg">
      <section className="stack gap-sm">
        <div className="row align-center justify-between wrap gap-sm">
          <h2 className="section-title">Leaderboard</h2>
          <div className="row gap-sm wrap">
            <a className="btn btn-secondary btn-sm" href={api.exportUrl(ctx.gameId, ctx.token)} download={`game-${game.code}.json`}>
              Export JSON
            </a>
            {(game.status === 'GAME_RESULTS' || game.status === 'FINISHED') && (
              <Link className="btn btn-secondary btn-sm" to={`/results/${ctx.gameId}`} target="_blank">
                Public page ↗
              </Link>
            )}
          </div>
        </div>
        <Leaderboard entries={leaderboard} showDelta={false} showCompleted />
      </section>

      <section className="stack gap-sm">
        <h2 className="section-title">Per challenge</h2>
        {challenges.length === 0 && <p className="muted">No challenges in this game.</p>}
        <ol className="plain-list stack gap-sm">
          {challenges.map((c, i) => {
            const loaded = open[c.id];
            // Shared results exist once the instance is in RESULTS; immediate modules also expose partial results earlier.
            const hasResults = c.phase === 'RESULTS' || Boolean(results[c.id]) || c.stats.scored > 0;
            return (
              <li key={c.id} className="card card-flat stack gap-sm">
                <div className="row gap-sm align-center wrap">
                  <span className="mono muted">{i + 1}</span>
                  <span className="grow stack gap-xs">
                    <strong>{c.moduleName}</strong>
                    {c.title && <span className="muted small clamp">{c.title}</span>}
                    <span className="row gap-xs wrap">
                      <EvaluationBadge mode={c.evaluationMode} short />
                      <span className="muted small mono">{statsLine(c)}</span>
                    </span>
                  </span>
                  <PhaseBadge phase={c.phase} />
                  {hasResults && (
                    <button type="button" className="btn btn-secondary btn-sm" aria-expanded={Boolean(loaded)} onClick={() => void toggle(c.id)}>
                      {loaded ? 'Hide' : 'Show results'}
                    </button>
                  )}
                </div>
                {loaded?.state === 'loading' && <p className="muted small">Loading…</p>}
                {loaded?.state === 'error' && (
                  <p className="field-error" role="alert">
                    {loaded.message}
                  </p>
                )}
                {loaded?.state === 'ok' &&
                  (loaded.results ? <ResultsDetail results={loaded.results} players={players} instanceKey={`${c.id}-results`} /> : <p className="muted small">No results yet for this challenge.</p>)}
              </li>
            );
          })}
        </ol>
      </section>

      <section className="stack gap-sm">
        <h2 className="section-title">Score ledger</h2>
        {ledgerError && (
          <p className="field-error" role="alert">
            {ledgerError}
          </p>
        )}
        {ledger === null && !ledgerError && <p className="muted small">Loading…</p>}
        {ledger && ledger.length === 0 && <p className="muted">No points awarded yet.</p>}
        {ledger && ledger.length > 0 && (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Player</th>
                  <th scope="col" className="num">
                    Points
                  </th>
                  <th scope="col">Source</th>
                  <th scope="col">Challenge</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {[...ledger].reverse().map((row) => (
                  <tr key={row.id}>
                    <td className="mono small">{formatClock(row.createdAt)}</td>
                    <td>{nameOf(players, row.playerId)}</td>
                    <td className={`num mono ${row.points < 0 ? 'tone-danger' : ''}`}>
                      {row.points > 0 ? '+' : ''}
                      {formatPoints(row.points)}
                    </td>
                    <td>
                      <span className={`badge ${row.source === 'manual' ? 'tone-warning' : 'tone-muted'}`}>{row.source}</span>
                    </td>
                    <td className="muted small">{row.challengeInstanceId ? challenges.find((c) => c.id === row.challengeInstanceId)?.moduleName ?? '—' : '—'}</td>
                    <td className="muted small">{row.reason ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
