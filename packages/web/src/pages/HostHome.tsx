import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { GameStatus } from '@challenge/contract';
import { StatusBadge } from '../components/PhaseBadge';
import { useToast } from '../components/Toast';
import { ApiError, api, errorMessage } from '../lib/api';
import { readSetupFile } from '../lib/setupFile';
import { listHostedGames, removeHostedGame, saveHostedGame, type HostedGame } from '../lib/storage';
import { formatDate } from '../lib/time';

type Known = { status: GameStatus } | { status: 'gone' } | null;

export function HostHome() {
  const navigate = useNavigate();
  const toast = useToast();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [needsPassword, setNeedsPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [games, setGames] = useState<HostedGame[]>(() => listHostedGames());
  const [statuses, setStatuses] = useState<Record<string, Known>>({});
  const [importing, setImporting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // On the host machine the server lists every saved game, so nothing is lost when this
  // browser forgot them (another port or address means another browser storage).
  useEffect(() => {
    let cancelled = false;
    api
      .localGames()
      .then((list) => {
        if (cancelled) return;
        const known = new Map(listHostedGames().map((g) => [g.id, g]));
        for (const { game, hostToken } of [...list].reverse()) {
          if (!known.has(game.id)) saveHostedGame({ id: game.id, name: game.name, code: game.code, hostToken, createdAt: game.createdAt });
        }
        setGames(listHostedGames().sort((a, b) => b.createdAt - a.createdAt));
        setStatuses((s) => ({ ...s, ...Object.fromEntries(list.map(({ game }) => [game.id, { status: game.status }])) }));
      })
      .catch(() => {
        /* not the host machine (or an older server): the games saved in this browser still show */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    for (const g of games) {
      api
        .getGame(g.id, g.hostToken)
        .then((snap) => {
          if (cancelled) return;
          setStatuses((s) => ({ ...s, [g.id]: { status: snap.game.status } }));
          if (snap.game.name !== g.name || snap.game.code !== g.code) saveHostedGame({ ...g, name: snap.game.name, code: snap.game.code });
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          if (e instanceof ApiError && (e.status === 404 || e.status === 401)) setStatuses((s) => ({ ...s, [g.id]: { status: 'gone' } }));
        });
    }
    return () => {
      cancelled = true;
    };
    // Only on mount: statuses for the games saved on this device.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Give your game a name');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.createGame(needsPassword ? { name: trimmed, hostPassword: password } : { name: trimmed });
      saveHostedGame({ id: res.game.id, name: res.game.name, code: res.game.code, hostToken: res.hostToken, createdAt: res.game.createdAt });
      navigate(`/host/${res.game.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setNeedsPassword(true);
        setError(password ? 'Wrong host password' : 'This server requires a host password');
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const importFile = async (file: File) => {
    setImporting(true);
    setError(null);
    try {
      const setup = await readSetupFile(file);
      const res = await api.importSetup(setup, needsPassword ? password : undefined);
      saveHostedGame({ id: res.game.id, name: res.game.name, code: res.game.code, hostToken: res.hostToken, createdAt: res.game.createdAt });
      if (res.warnings.length > 0) toast(`Imported with ${res.warnings.length} warning(s): ${res.warnings.join(' · ')}`, 'warning');
      else toast(`Imported "${res.game.name}"`, 'success');
      navigate(`/host/${res.game.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setNeedsPassword(true);
        setError(password ? 'Wrong host password' : 'This server requires a host password — enter it, then import again');
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setImporting(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const remove = async (g: HostedGame) => {
    const known = statuses[g.id];
    const gone = known?.status === 'gone';
    if (!window.confirm(gone ? `Remove "${g.name}" from this list?` : `Delete "${g.name}" for everyone? This cannot be undone.`)) return;
    try {
      if (!gone) await api.deleteGame(g.id, g.hostToken);
      removeHostedGame(g.id);
      setGames(listHostedGames());
      toast(gone ? 'Removed from list' : 'Game deleted', 'success');
    } catch (err) {
      toast(errorMessage(err), 'danger');
    }
  };

  return (
    <main className="page page-narrow stack gap-lg">
      <header className="row align-center justify-between">
        <h1>Host</h1>
        <Link className="btn btn-ghost" to="/">
          ← Start
        </Link>
      </header>

      <section className="card stack gap-md">
        <h2 className="section-title">New game</h2>
        <form className="stack gap-md" onSubmit={create}>
          <label className="field">
            <span className="field-label">Game name</span>
            <input className="input input-lg" type="text" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="Friday quiz night" autoFocus />
          </label>
          {needsPassword && (
            <label className="field">
              <span className="field-label">Host password</span>
              <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              <span className="field-help">Set by whoever runs this server.</span>
            </label>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="btn btn-primary btn-lg" disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create game'}
          </button>
        </form>
        <div className="stack gap-xs">
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            id="import-setup"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importFile(file);
            }}
          />
          <button type="button" className="btn btn-secondary" disabled={importing} onClick={() => fileInput.current?.click()}>
            {importing ? 'Importing…' : '⬆ Import a setup file'}
          </button>
          <span className="field-help">Restores a backup downloaded from a game's Setup tab as a new game.</span>
        </div>
      </section>

      <section className="stack gap-sm">
        <h2 className="section-title">Your games</h2>
        {games.length === 0 && <p className="muted">Games you host on this device appear here.</p>}
        {games.map((g) => {
          const known = statuses[g.id];
          return (
            <div key={g.id} className="list-row card card-flat">
              <Link className="grow stack gap-xs link-plain" to={`/host/${g.id}`}>
                <span className="row gap-sm align-center wrap">
                  <strong>{g.name}</strong>
                  {known === undefined || known === null ? (
                    <span className="badge tone-muted">…</span>
                  ) : known.status === 'gone' ? (
                    <span className="badge tone-danger">Unavailable</span>
                  ) : (
                    <StatusBadge status={known.status} />
                  )}
                </span>
                <span className="muted small">
                  Code {g.code} · created {formatDate(g.createdAt)}
                </span>
              </Link>
              <button type="button" className="btn btn-icon btn-danger btn-ghost" aria-label={`Delete ${g.name}`} onClick={() => void remove(g)}>
                🗑
              </button>
            </div>
          );
        })}
      </section>
    </main>
  );
}
