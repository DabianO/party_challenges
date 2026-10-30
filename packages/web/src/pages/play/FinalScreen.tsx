import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Leaderboard, rankClass } from '../../components/Leaderboard';
import { ProgressChart } from '../../components/ProgressChart';
import { UIView } from '../../components/UIRenderer';
import { formatPoints } from '../../lib/time';
import type { PlayCtx } from '../Play';

export function FinalScreen({ ctx }: { ctx: PlayCtx }) {
  const { game, leaderboard, board } = ctx.snapshot;
  const mine = leaderboard.find((e) => e.playerId === ctx.meId);
  const withResults = board.filter((b) => b.result || b.points !== null);
  const [open, setOpen] = useState<string | null>(null);

  if (!game.resultsRevealed) {
    return (
      <section className="stack gap-lg center-text">
        <div className="big-emoji" aria-hidden="true">
          🥁
        </div>
        <h1>That's a wrap!</h1>
        <p className="muted">The host will reveal the results in a moment — keep this screen open.</p>
        {game.branding.finalText && <p className="intro-text">{game.branding.finalText}</p>}
      </section>
    );
  }

  return (
    <section className="stack gap-lg">
      <div className="center-text stack gap-xs">
        <p className="eyebrow">Final results</p>
        {mine ? (
          <>
            <div className={`final-rank ${rankClass(mine.rank)}`} aria-label={`Rank ${mine.rank}`}>
              #{mine.rank}
            </div>
            <p className="subtitle">
              {formatPoints(mine.total)} pts · {mine.completed} {mine.completed === 1 ? 'challenge' : 'challenges'} completed
            </p>
            <p className="muted small">
              {mine.rank === 1 ? 'You won!' : `Out of ${leaderboard.length} players`}
            </p>
          </>
        ) : (
          <p className="muted">You were not ranked in this game.</p>
        )}
        {game.branding.finalText && <p className="intro-text">{game.branding.finalText}</p>}
      </div>

      <div className="stack gap-sm">
        <h2 className="section-title">Top 3</h2>
        <Leaderboard entries={leaderboard} meId={ctx.meId} limit={3} showDelta={false} showConnection={false} size="lg" />
      </div>
      <div className="stack gap-sm">
        <h2 className="section-title">The race</h2>
        <ProgressChart entries={leaderboard} players={ctx.snapshot.players} challengeCount={ctx.snapshot.challenges.length} meId={ctx.meId} height={260} />
      </div>
      {leaderboard.length > 3 && (
        <div className="stack gap-sm">
          <h2 className="section-title">Everyone</h2>
          <Leaderboard entries={leaderboard} meId={ctx.meId} showDelta={false} showConnection={false} />
        </div>
      )}

      {withResults.length > 0 && (
        <div className="stack gap-sm">
          <h2 className="section-title">Your challenges</h2>
          <ul className="plain-list stack gap-xs">
            {withResults.map((b) => {
              const isOpen = open === b.instanceId;
              return (
                <li key={b.instanceId} className="card card-flat stack gap-sm">
                  <button type="button" className="result-row" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : b.instanceId)}>
                    <span className="grow stack gap-xs">
                      <strong>{b.title}</strong>
                      <span className="muted small">
                        {b.status === 'scored' ? 'Scored' : b.status === 'missed' ? 'Time ran out' : b.status === 'closed' ? 'Closed' : b.status}
                      </span>
                    </span>
                    {b.points !== null && (
                      <span className={`points-badge ${b.points > 0 ? 'is-positive' : ''}`}>
                        {b.points > 0 ? '+' : ''}
                        {formatPoints(b.points)} pts
                      </span>
                    )}
                    <span aria-hidden="true" className="muted">
                      {isOpen ? '▾' : '▸'}
                    </span>
                  </button>
                  {isOpen && b.result && <UIView key={`${b.instanceId}-final`} node={b.result} />}
                  {isOpen && !b.result && <p className="muted small">No detailed result for this challenge.</p>}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <Link className="btn btn-secondary" to="/">
        Back to start
      </Link>
    </section>
  );
}
