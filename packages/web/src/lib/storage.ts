export interface HostedGame {
  id: string;
  name: string;
  code: string;
  hostToken: string;
  createdAt: number;
}

export interface PlayerSession {
  code: string;
  gameId: string;
  gameName: string;
  playerId: string;
  displayName: string;
  sessionToken: string;
}

const HOSTED_KEY = 'cp.hostedGames';
const SESSIONS_KEY = 'cp.playerSessions';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable (private mode, quota) — the app still works for this session */
  }
}

export function listHostedGames(): HostedGame[] {
  const list = read<unknown>(HOSTED_KEY, []);
  return Array.isArray(list) ? (list as HostedGame[]).filter((g) => g && typeof g.id === 'string' && typeof g.hostToken === 'string') : [];
}

export function getHostedGame(id: string): HostedGame | undefined {
  return listHostedGames().find((g) => g.id === id);
}

export function saveHostedGame(game: HostedGame): void {
  const rest = listHostedGames().filter((g) => g.id !== game.id);
  write(HOSTED_KEY, [game, ...rest]);
}

export function removeHostedGame(id: string): void {
  write(
    HOSTED_KEY,
    listHostedGames().filter((g) => g.id !== id),
  );
}

export function listPlayerSessions(): PlayerSession[] {
  const list = read<unknown>(SESSIONS_KEY, []);
  return Array.isArray(list)
    ? (list as PlayerSession[]).filter((s) => s && typeof s.code === 'string' && typeof s.sessionToken === 'string')
    : [];
}

export function getPlayerSession(code: string): PlayerSession | undefined {
  const upper = code.toUpperCase();
  return listPlayerSessions().find((s) => s.code.toUpperCase() === upper);
}

export function savePlayerSession(session: PlayerSession): void {
  const rest = listPlayerSessions().filter((s) => s.code.toUpperCase() !== session.code.toUpperCase());
  write(SESSIONS_KEY, [{ ...session, code: session.code.toUpperCase() }, ...rest]);
}

export function removePlayerSession(code: string): void {
  const upper = code.toUpperCase();
  write(
    SESSIONS_KEY,
    listPlayerSessions().filter((s) => s.code.toUpperCase() !== upper),
  );
}
