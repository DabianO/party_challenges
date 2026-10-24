import type {
  Branding,
  ChallengeInstanceSummary,
  ChallengeResults,
  CreateGameResponse,
  GameSettings,
  GameSetup,
  GameSnapshot,
  GameSummary,
  HostAction,
  ImportSetupResponse,
  InstanceOptions,
  JoinResponse,
  LeaderboardEntry,
  LocalGameInfo,
  ModuleInfo,
  PlayerPublic,
  PublicGameInfo,
  ScoreLedgerEntry,
} from '@challenge/contract';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  token?: string;
  formData?: FormData;
  headers?: Record<string, string>;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body: BodyInit | undefined;
  if (opts.formData) {
    body = opts.formData;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(path, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body });
  } catch {
    throw new ApiError('Network error — check your connection', 0);
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const err = (data ?? {}) as { error?: unknown; code?: unknown };
    throw new ApiError(
      typeof err.error === 'string' ? err.error : `Request failed (${res.status})`,
      res.status,
      typeof err.code === 'string' ? err.code : undefined,
    );
  }
  return data as T;
}

export interface MediaUploadResponse {
  id: string;
  ref: string;
  url: string;
  mimeType: string;
  size: number;
}

export interface HostActionResponse {
  ok: boolean;
  message?: string;
  game: GameSummary;
}

export interface PublicResultsResponse {
  game: GameSummary;
  leaderboard: LeaderboardEntry[];
  challenges: ChallengeInstanceSummary[];
  players: PlayerPublic[];
  /** Shared results of every challenge that reached RESULTS, keyed by instance id. */
  results: Record<string, ChallengeResults>;
}

export interface GamePatch {
  name?: string;
  settings?: Partial<GameSettings>;
  branding?: Branding;
}

/** Body of POST/PATCH /challenges: module configuration plus engine-owned instance options. */
export interface ChallengeBody extends Partial<InstanceOptions> {
  configuration?: Record<string, unknown>;
}

export const api = {
  modules: () => request<{ modules: ModuleInfo[] }>('/api/modules').then((r) => r.modules),

  createGame: (body: { name: string; hostPassword?: string }) => request<CreateGameResponse>('/api/games', { body }),

  /** The game's configuration (board, settings, branding, media) as a JSON backup. */
  exportSetup: (id: string, token: string) => request<GameSetup>(`/api/games/${id}/setup`, { token }),

  /** New DRAFT game with this game's setup (no players or scores). */
  duplicateGame: (id: string, token: string) => request<ImportSetupResponse>(`/api/games/${id}/duplicate`, { method: 'POST', token }),

  /** New game from a setup backup. */
  importSetup: (setup: unknown, hostPassword?: string) =>
    request<ImportSetupResponse>('/api/games/import', { body: hostPassword ? { setup, hostPassword } : { setup } }),

  /** Every game stored on the server, with host tokens — answered only for a browser on the host machine. */
  localGames: () => request<{ games: LocalGameInfo[] }>('/api/local/games').then((r) => r.games),

  getGame: (id: string, token: string) => request<{ snapshot: GameSnapshot }>(`/api/games/${id}`, { token }).then((r) => r.snapshot),

  patchGame: (id: string, token: string, patch: GamePatch) =>
    request<{ game: GameSummary }>(`/api/games/${id}`, { method: 'PATCH', token, body: patch }).then((r) => r.game),

  deleteGame: (id: string, token: string) => request<{ ok: true }>(`/api/games/${id}`, { method: 'DELETE', token }),

  ledger: (id: string, token: string) => request<{ ledger: ScoreLedgerEntry[] }>(`/api/games/${id}/ledger`, { token }).then((r) => r.ledger),

  exportUrl: (id: string, token: string) => `/api/games/${id}/export?hostToken=${encodeURIComponent(token)}`,

  addChallenge: (id: string, token: string, moduleId: string, body: ChallengeBody) =>
    request<{ challenge: ChallengeInstanceSummary }>(`/api/games/${id}/challenges`, { token, body: { moduleId, ...body } }).then((r) => r.challenge),

  updateChallenge: (id: string, token: string, instanceId: string, body: ChallengeBody) =>
    request<{ challenge: ChallengeInstanceSummary }>(`/api/games/${id}/challenges/${instanceId}`, { method: 'PATCH', token, body }).then(
      (r) => r.challenge,
    ),

  removeChallenge: (id: string, token: string, instanceId: string) =>
    request<{ ok: true }>(`/api/games/${id}/challenges/${instanceId}`, { method: 'DELETE', token }),

  reorderChallenges: (id: string, token: string, order: string[]) =>
    request<{ ok: true }>(`/api/games/${id}/challenges/reorder`, { token, body: { order } }),

  challengeResults: (id: string, token: string, instanceId: string) =>
    request<{ results: ChallengeResults | null }>(`/api/games/${id}/challenges/${instanceId}/results`, { token }).then((r) => r.results),

  hostAction: (id: string, token: string, action: HostAction) =>
    request<HostActionResponse>(`/api/games/${id}/actions`, { token, body: action }),

  /** Host upload for challenge configuration and branding (FR-56). */
  uploadMedia: (id: string, token: string, file: File) => {
    const formData = new FormData();
    formData.append('file', file, file.name);
    return request<MediaUploadResponse>(`/api/games/${id}/media`, { token, formData });
  },

  /** Guest evidence upload (FR-57, §14.6), authenticated with the player's session. */
  uploadEvidence: (code: string, sessionToken: string, file: File) => {
    const formData = new FormData();
    formData.append('file', file, file.name || 'evidence');
    return request<MediaUploadResponse>('/api/evidence', { formData, headers: { 'X-Game-Code': code, 'X-Session-Token': sessionToken } });
  },

  gameByCode: (code: string) => request<PublicGameInfo>(`/api/games/by-code/${encodeURIComponent(code)}`),

  join: (code: string, displayName: string) => request<JoinResponse>('/api/join', { body: { code, displayName } }),

  resume: (code: string, sessionToken: string) => request<JoinResponse>('/api/join/resume', { body: { code, sessionToken } }),

  publicResults: (id: string) => request<PublicResultsResponse>(`/api/games/${id}/results`),
};

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}
