import type { PlayCtx } from '../Play';
import { AvatarEditor } from './AvatarEditor';

export function LobbyScreen({ ctx }: { ctx: PlayCtx }) {
  const { game, players, challenges } = ctx.snapshot;
  return (
    <section className="stack gap-lg lobby-wait">
      <div className="stack gap-sm center-text">
        <div className="big-emoji" aria-hidden="true">
          🎉
        </div>
        <h1>You're in!</h1>
        <p className="muted">Waiting for the host to open the board…</p>
        <p>
          <span className="badge tone-primary">
            {players.length} {players.length === 1 ? 'player' : 'players'} joined
          </span>
        </p>
        {game.branding.introText && <p className="intro-text">{game.branding.introText}</p>}
      </div>

      <div className="card">
        <AvatarEditor ctx={ctx} />
      </div>

      {challenges.length > 0 && (
        <div className="stack gap-sm">
          <h2 className="section-title">Coming up</h2>
          <ol className="plain-list stack gap-xs">
            {challenges.map((c, i) => (
              <li key={c.id} className="list-row card card-flat lobby-challenge">
                <span className="challenge-index mono" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="grow stack gap-xs">
                  <strong>{c.title}</strong>
                  {c.title !== c.moduleName && <span className="muted small">{c.moduleName}</span>}
                </span>
              </li>
            ))}
          </ol>
          <p className="muted small center-text">Once the game starts, tap a challenge to play it at your own pace.</p>
        </div>
      )}
    </section>
  );
}
