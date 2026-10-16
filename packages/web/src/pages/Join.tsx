import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { PublicGameInfo } from '@challenge/contract';
import { ApiError, api, errorMessage } from '../lib/api';
import { useBranding } from '../lib/branding';
import { getPlayerSession, removePlayerSession, savePlayerSession, type PlayerSession } from '../lib/storage';
import { StatusBadge } from '../components/PhaseBadge';
import { CodeInput, normaliseCode } from './Landing';
import { Play } from './Play';

const NAME_MAX = 20;

type Stage = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'form'; info: PublicGameInfo } | { kind: 'playing'; session: PlayerSession };

export function Join() {
  const { code: codeParam } = useParams();
  const code = codeParam ? normaliseCode(codeParam) : '';
  if (!code) return <CodeEntry />;
  return <JoinFlow key={code} code={code} />;
}

function CodeEntry() {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  return (
    <main className="page page-narrow">
      <h1>Join a game</h1>
      <form
        className="stack gap-md"
        onSubmit={(e) => {
          e.preventDefault();
          if (code.length >= 4) navigate(`/join/${code}`);
        }}
      >
        <CodeInput value={code} onChange={setCode} autoFocus />
        <button type="submit" className="btn btn-primary btn-lg" disabled={code.length < 4}>
          Continue
        </button>
      </form>
    </main>
  );
}

function JoinFlow({ code }: { code: string }) {
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });
  const [info, setInfo] = useState<PublicGameInfo | null>(null);
  useBranding(info?.branding);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const game = await api.gameByCode(code);
        if (cancelled) return;
        setInfo(game);
        const stored = getPlayerSession(code);
        if (stored) {
          try {
            const resumed = await api.resume(code, stored.sessionToken);
            if (cancelled) return;
            const session: PlayerSession = { ...stored, ...resumed, code };
            savePlayerSession(session);
            setStage({ kind: 'playing', session });
            return;
          } catch (err) {
            if (err instanceof ApiError && err.status === 401) removePlayerSession(code);
            else if (err instanceof ApiError && err.status !== 404) {
              // Server hiccup: keep the session and offer to try again.
              if (!cancelled) setStage({ kind: 'error', message: errorMessage(err) });
              return;
            }
          }
        }
        if (!cancelled) setStage({ kind: 'form', info: game });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof ApiError && err.status === 404 ? 'No game with that code. Check the code on the big screen.' : errorMessage(err);
        setStage({ kind: 'error', message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (stage.kind === 'loading') {
    return (
      <main className="page page-narrow center-text">
        <p className="muted" role="status">
          Looking up game {code}…
        </p>
      </main>
    );
  }

  if (stage.kind === 'error') {
    return (
      <main className="page page-narrow center-text stack gap-md">
        <h1>Hmm.</h1>
        <p role="alert">{stage.message}</p>
        <Link className="btn btn-primary" to="/">
          Try another code
        </Link>
      </main>
    );
  }

  if (stage.kind === 'playing') {
    return (
      <Play
        code={code}
        session={stage.session}
        onSessionInvalid={() => {
          removePlayerSession(code);
          setStage(info ? { kind: 'form', info } : { kind: 'error', message: 'Your session has expired.' });
        }}
      />
    );
  }

  return <NameForm code={code} info={stage.info} onJoined={(session) => setStage({ kind: 'playing', session })} />;
}

function NameForm({ code, info, onJoined }: { code: string; info: PublicGameInfo; onJoined: (s: PlayerSession) => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const displayName = name.trim();
    if (!displayName) {
      setError('Enter a display name');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.join(code, displayName);
      const session: PlayerSession = { code, ...res };
      savePlayerSession(session);
      onJoined(session);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page page-narrow">
      <header className="stack gap-xs">
        <p className="eyebrow">Joining</p>
        <h1>{info.name}</h1>
        <div className="row gap-sm wrap">
          <StatusBadge status={info.status} />
          <span className="muted">
            {info.playerCount} {info.playerCount === 1 ? 'player' : 'players'} · code {code}
          </span>
        </div>
        {info.branding.hostName && <p className="muted">Hosted by {info.branding.hostName}</p>}
      </header>

      {!info.joinable ? (
        <div className="stack gap-md">
          <p role="alert">
            {info.status === 'DRAFT'
              ? 'This game is still being set up. Ask the host to open the lobby.'
              : info.status === 'IN_PROGRESS'
                ? 'This game has already started and the host disabled late joining.'
                : 'This game is not accepting players right now.'}
          </p>
          <Link className="btn btn-secondary" to="/">
            Back
          </Link>
        </div>
      ) : (
        <form className="stack gap-md" onSubmit={submit}>
          <label className="field">
            <span className="field-label">Your display name</span>
            <input
              className="input input-lg"
              type="text"
              autoComplete="nickname"
              maxLength={NAME_MAX}
              value={name}
              autoFocus
              aria-invalid={error ? true : undefined}
              onChange={(e) => setName(e.target.value)}
            />
            <span className="field-help mono">
              {name.length}/{NAME_MAX}
            </span>
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="btn btn-primary btn-lg" disabled={busy || !name.trim()}>
            {busy ? 'Joining…' : "Let's go"}
          </button>
        </form>
      )}
    </main>
  );
}
