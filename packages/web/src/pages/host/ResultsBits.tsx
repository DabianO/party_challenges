import type { ChallengeResults, PlayerPublic } from '@challenge/contract';
import { UIView } from '../../components/UIRenderer';
import { formatPoints } from '../../lib/time';

export function nameOf(players: PlayerPublic[], playerId: string): string {
  return players.find((p) => p.id === playerId)?.displayName ?? 'Unknown player';
}

export function ScoresTable({ results, players }: { results: ChallengeResults; players: PlayerPublic[] }) {
  if (results.scores.length === 0) return <p className="muted">No points were awarded.</p>;
  const sorted = [...results.scores].sort((a, b) => b.points - a.points);
  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Player</th>
            <th scope="col" className="num">
              Points
            </th>
            <th scope="col">Reason</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((s, i) => (
            <tr key={`${s.playerId}-${i}`}>
              <td>{nameOf(players, s.playerId)}</td>
              <td className="num mono">{formatPoints(s.points)}</td>
              <td className="muted">{s.reason ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function secs(v: number | null): string {
  return v === null ? '–' : `${(Math.round(v * 10) / 10).toFixed(1)} s`;
}

export function GenericStats({ results }: { results: ChallengeResults }) {
  const g = results.generic;
  return (
    <dl className="stats-grid">
      <div>
        <dt>Participation</dt>
        <dd>
          {g.submissions}/{g.participants} <small>({Math.round(g.participationRate * 100)}%)</small>
        </dd>
      </div>
      <div>
        <dt>Avg time</dt>
        <dd>{secs(g.submissionTime.average)}</dd>
      </div>
      <div>
        <dt>Fastest</dt>
        <dd>{secs(g.submissionTime.min)}</dd>
      </div>
      <div>
        <dt>Median</dt>
        <dd>{secs(g.submissionTime.median)}</dd>
      </div>
    </dl>
  );
}

/** Full results block: module UI, generic stats and the per-player score table. */
export function ResultsDetail({ results, players, instanceKey }: { results: ChallengeResults; players: PlayerPublic[]; instanceKey: string }) {
  return (
    <div className="stack gap-md">
      <div className="card card-flat">
        <UIView key={instanceKey} node={results.ui} />
      </div>
      <GenericStats results={results} />
      <ScoresTable results={results} players={players} />
    </div>
  );
}
