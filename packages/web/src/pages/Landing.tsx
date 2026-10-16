import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { listHostedGames, listPlayerSessions, removePlayerSession } from '../lib/storage';

const CODE_LENGTH = 6;

export function normaliseCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
}

export function CodeInput({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return (
    <input
      className="input code-input"
      type="text"
      inputMode="text"
      autoCapitalize="characters"
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      maxLength={CODE_LENGTH}
      placeholder="ABC123"
      aria-label="Game code"
      value={value}
      autoFocus={autoFocus}
      onChange={(e) => onChange(normaliseCode(e.target.value))}
    />
  );
}

export function Landing() {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [sessions, setSessions] = useState(() => listPlayerSessions());
  const hosted = listHostedGames();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (code.length < 4) return;
    navigate(`/join/${code}`);
  };

  return (
    <main className="page page-narrow landing">
      <header className="hero">
        <div className="logo-mark" aria-hidden="true">
          ✦
        </div>
        <h1>Challenge Platform</h1>
        <p className="muted">Enter the code on the big screen to play.</p>
      </header>

      <form className="stack gap-md" onSubmit={submit}>
        <label className="field">
          <span className="field-label">Game code</span>
          <CodeInput value={code} onChange={setCode} autoFocus />
        </label>
        <button type="submit" className="btn btn-primary btn-lg" disabled={code.length < 4}>
          Join game
        </button>
      </form>

      {sessions.length > 0 && (
        <section className="stack gap-sm">
          <h2 className="section-title">Your games</h2>
          {sessions.map((s) => (
            <div key={s.code} className="list-row">
              <Link className="btn btn-secondary grow" to={`/join/${s.code}`}>
                Rejoin {s.gameName} <span className="muted">as {s.displayName}</span>
              </Link>
              <button
                type="button"
                className="btn btn-icon"
                aria-label={`Forget ${s.gameName}`}
                onClick={() => {
                  removePlayerSession(s.code);
                  setSessions(listPlayerSessions());
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </section>
      )}

      <footer className="landing-footer">
        <Link className="btn btn-ghost" to="/host">
          Host a game{hosted.length > 0 ? ` (${hosted.length} saved)` : ''} →
        </Link>
      </footer>
    </main>
  );
}
