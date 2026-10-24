import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { GameSnapshot, HostAction, ModuleInfo } from '@challenge/contract';
import { ConnectionBanner } from '../components/Banner';
import { StatusBadge } from '../components/PhaseBadge';
import { useToast } from '../components/Toast';
import { api, errorMessage, type HostActionResponse } from '../lib/api';
import { useBranding } from '../lib/branding';
import { resolveMedia } from '../lib/media';
import { useGameSocket } from '../lib/socket';
import { getHostedGame, saveHostedGame } from '../lib/storage';
import type { HostCtx } from './host/hostApi';
import { ResultsTab } from './host/ResultsTab';
import { RunTab } from './host/RunTab';
import { SetupTab } from './host/SetupTab';

type Tab = 'setup' | 'run' | 'results';

const TABS: { id: Tab; label: string }[] = [
  { id: 'setup', label: 'Setup' },
  { id: 'run', label: 'Run' },
  { id: 'results', label: 'Results' },
];

export function HostGame() {
  const { gameId = '' } = useParams();
  // Remount per game so switching games (e.g. to a fresh copy) never reuses another game's token.
  return <HostGameForId key={gameId} gameId={gameId} />;
}

function HostGameForId({ gameId }: { gameId: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const stored = getHostedGame(gameId);
  const [token, setToken] = useState(() => {
    // A token passed in the URL (e.g. from the demo seeder) is stored once and removed from the address bar.
    const fromUrl = searchParams.get('hostToken')?.trim();
    if (fromUrl) {
      saveHostedGame({ id: gameId, name: stored?.name ?? 'Game', code: stored?.code ?? '', hostToken: fromUrl, createdAt: stored?.createdAt ?? Date.now() });
      return fromUrl;
    }
    return stored?.hostToken ?? '';
  });
  useEffect(() => {
    if (searchParams.has('hostToken')) setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);

  if (!token) return <TokenForm gameId={gameId} onToken={setToken} />;
  return <HostGameInner key={token} gameId={gameId} token={token} onForgetToken={() => setToken('')} />;
}

function TokenForm({ gameId, onToken }: { gameId: string; onToken: (t: string) => void }) {
  const [value, setValue] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = value.trim();
    if (!t) return;
    const existing = getHostedGame(gameId);
    saveHostedGame({ id: gameId, name: existing?.name ?? 'Game', code: existing?.code ?? '', hostToken: t, createdAt: existing?.createdAt ?? Date.now() });
    onToken(t);
  };
  return (
    <main className="page page-narrow stack gap-md">
      <h1>Host token needed</h1>
      <p className="muted">This device has no host token for this game. Paste the token you received when the game was created.</p>
      <form className="stack gap-md" onSubmit={submit}>
        <label className="field">
          <span className="field-label">Host token</span>
          <input className="input" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        <button type="submit" className="btn btn-primary" disabled={!value.trim()}>
          Continue
        </button>
      </form>
      <Link className="btn btn-ghost" to="/host">
        ← All games
      </Link>
    </main>
  );
}

function HostGameInner({ gameId, token, onForgetToken }: { gameId: string; token: string; onForgetToken: () => void }) {
  const toast = useToast();
  const sock = useGameSocket({ role: 'host', gameId, token });
  const { snapshot, fatal, lastEvent } = sock;
  const [modules, setModules] = useState<ModuleInfo[]>([]);
  const [tab, setTab] = useState<Tab | null>(null);
  useBranding(snapshot?.game.branding);

  useEffect(() => {
    api
      .modules()
      .then(setModules)
      .catch((e: unknown) => toast(`Could not load the challenge library: ${errorMessage(e)}`, 'danger'));
  }, [toast]);

  // Keep the saved list fresh and pick a sensible starting tab.
  useEffect(() => {
    if (!snapshot) return;
    const existing = getHostedGame(gameId);
    saveHostedGame({ id: gameId, name: snapshot.game.name, code: snapshot.game.code, hostToken: token, createdAt: existing?.createdAt ?? snapshot.game.createdAt });
    setTab((t) => t ?? (snapshot.game.status === 'DRAFT' ? 'setup' : snapshot.game.status === 'GAME_RESULTS' || snapshot.game.status === 'FINISHED' ? 'results' : 'run'));
  }, [snapshot, gameId, token]);

  useEffect(() => {
    if (!lastEvent) return;
    const payload = (lastEvent.payload ?? {}) as { displayName?: unknown; message?: unknown };
    const who = typeof payload.displayName === 'string' ? payload.displayName : 'A player';
    switch (lastEvent.type) {
      case 'MODULE_ERROR':
        toast(`Module error: ${typeof payload.message === 'string' ? payload.message : 'unknown error'}`, 'danger');
        break;
      case 'EVALUATION_ESCALATED':
        toast('A submission needs your judgement', 'warning');
        break;
      case 'PLAYER_JOINED':
        toast(`${who} joined`, 'info');
        break;
      case 'PLAYER_DISCONNECTED':
        toast(`${who} disconnected`, 'warning');
        break;
      case 'PLAYER_RECONNECTED':
        toast(`${who} is back`, 'success');
        break;
      case 'RESULTS_AVAILABLE':
        toast('Results are in', 'success');
        break;
      default:
        break;
    }
  }, [lastEvent, toast]);

  useEffect(() => {
    if (sock.error) toast(sock.error, 'danger');
  }, [sock.error, toast]);

  const act = useCallback(
    async (action: HostAction): Promise<HostActionResponse | null> => {
      try {
        return await api.hostAction(gameId, token, action);
      } catch (e) {
        toast(errorMessage(e), 'danger');
        return null;
      }
    },
    [gameId, token, toast],
  );

  const upload = useCallback(async (file: File) => (await api.uploadMedia(gameId, token, file)).ref, [gameId, token]);

  const ctx = useMemo<HostCtx | null>(
    () => (snapshot ? { gameId, token, snapshot, modules, clockOffset: sock.clockOffset, act, upload, toast } : null),
    [gameId, token, snapshot, modules, sock.clockOffset, act, upload, toast],
  );

  if (fatal) {
    return (
      <main className="page page-narrow stack gap-md">
        <h1>Unauthorized</h1>
        <p role="alert">{fatal.message}. The stored host token is not valid for this game (or the game was deleted).</p>
        <div className="row gap-sm wrap">
          <button type="button" className="btn btn-primary" onClick={onForgetToken}>
            Enter a different token
          </button>
          <Link className="btn btn-secondary" to="/host">
            All games
          </Link>
        </div>
      </main>
    );
  }

  return (
    <div className="host">
      <HostHeader snapshot={snapshot} />
      <ConnectionBanner status={sock.status} />
      {snapshot && ctx && tab && (
        <>
          <nav className="tabs" aria-label="Host sections">
            {TABS.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`tab${tab === t.id ? ' is-active' : ''}`} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>
          <main className="page host-body">
            {tab === 'setup' && <SetupTab ctx={ctx} />}
            {tab === 'run' && <RunTab ctx={ctx} />}
            {tab === 'results' && <ResultsTab ctx={ctx} />}
          </main>
        </>
      )}
      {!snapshot && (
        <main className="page center-text">
          <p className="muted" role="status">
            Loading game…
          </p>
        </main>
      )}
    </div>
  );
}

function HostHeader({ snapshot }: { snapshot: GameSnapshot | null }) {
  const toast = useToast();
  const logo = resolveMedia(snapshot?.game.branding.logo);
  const copyJoinLink = async () => {
    if (!snapshot) return;
    try {
      await navigator.clipboard.writeText(snapshot.joinUrl);
      toast('Join link copied', 'success');
    } catch {
      window.prompt('Copy the join link', snapshot.joinUrl);
    }
  };
  return (
    <header className="host-header">
      <div className="row gap-sm align-center wrap">
        <Link className="btn btn-ghost btn-sm" to="/host" aria-label="All games">
          ←
        </Link>
        {logo && <img className="brand-logo" src={logo} alt="" />}
        <h1 className="host-title">{snapshot?.game.name ?? 'Game'}</h1>
        {snapshot && <StatusBadge status={snapshot.game.status} />}
        {snapshot && (
          <span className="code-chip" aria-label={`Game code ${snapshot.game.code}`}>
            {snapshot.game.code}
          </span>
        )}
      </div>
      {snapshot && (
        <div className="row gap-sm wrap">
          <a className="btn btn-secondary btn-sm" href={`/display/${snapshot.game.code}`} target="_blank" rel="noopener">
            Open display ↗
          </a>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void copyJoinLink()}>
            Copy join link
          </button>
        </div>
      )}
    </header>
  );
}
