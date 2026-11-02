/**
 * Public and admin surfaces.
 *
 * When the server is put on the internet it listens twice: a **public** listener that only
 * serves what guests and the big screen need, and an **admin** listener for the host, bound to
 * the host machine only. The public listener works from an allow-list: anything not listed
 * here (host pages, host-token APIs, creating or importing games, the host machine's game
 * list) does not exist there, so a route added later stays private until it is listed.
 */

export type Surface = 'public' | 'admin';

/** Static files of the built web client: hashed bundles and the few files at the root. */
const STATIC_FILE = /^\/(?:assets\/[\w.-]+|[\w.-]+\.(?:js|css|svg|png|ico|webmanifest|txt|woff2?))$/;
/** Client pages players and the big screen open. `/host` is deliberately not one of them. */
const PAGE = /^\/(?:|join(?:\/[\w-]*)?|display\/[\w-]+|results\/[\w-]+)$/;

type Rule = { methods: string[]; path: RegExp };

const API: Rule[] = [
  { methods: ['GET'], path: /^\/api\/health$/ },
  { methods: ['GET'], path: /^\/api\/games\/by-code\/[\w-]+$/ },
  { methods: ['POST'], path: /^\/api\/join$/ },
  { methods: ['POST'], path: /^\/api\/join\/resume$/ },
  { methods: ['GET'], path: /^\/api\/games\/[\w-]+\/results$/ },
  { methods: ['POST'], path: /^\/api\/evidence$/ },
  { methods: ['POST', 'DELETE'], path: /^\/api\/avatar$/ },
  { methods: ['GET'], path: /^\/media\/[\w.-]+$/ },
];

/**
 * May this request be served on the public listener? `url` is the raw request URL (path and
 * query). WebSockets: players (code + session) and the big screen by game code; never the
 * host, nor the big screen signed in with a host token.
 */
export function isPublicRequest(method: string, url: string): boolean {
  // Must be a plain path: "//x" would parse as a host name.
  if (!url.startsWith('/') || url.startsWith('//')) return false;
  let parsed: URL;
  try {
    parsed = new URL(url, 'http://surface.invalid');
  } catch {
    return false;
  }
  const path = parsed.pathname;
  // Encoded or doubled separators never belong to a legitimate client request.
  if (/%2f|%5c|\/\/|\\|\/\.\.?(?:\/|$)/i.test(path)) return false;
  const m = method.toUpperCase();
  const read = m === 'GET' || m === 'HEAD';

  if (path === '/ws') {
    if (m !== 'GET') return false;
    const role = parsed.searchParams.get('role');
    if (role === 'player') return true;
    return role === 'main' && !parsed.searchParams.has('gameId') && !parsed.searchParams.has('token');
  }
  if (read && (PAGE.test(path) || STATIC_FILE.test(path))) return true;
  return API.some((r) => (r.methods.includes(m) || (m === 'HEAD' && r.methods.includes('GET'))) && r.path.test(path));
}

/**
 * Headers for every response: no framing, no sniffing, no referrers (host links carry tokens),
 * and a strict content policy (the client loads nothing from other origins and has no inline
 * scripts; React sets inline styles). Media files keep their own sandbox policy.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

/** Requests per minute per client address on the public listener, by kind of request. */
export const PUBLIC_LIMITS = {
  /** Everything together (a page load is about ten requests; a party on one Wi-Fi shares an address). */
  all: 3000,
  join: 60,
  lookup: 240,
  upload: 240,
  socket: 600,
} as const;

export type LimitKind = keyof typeof PUBLIC_LIMITS;

/** The specific limit a public request counts towards (besides `all`), if any. */
export function limitKindOf(method: string, url: string): Exclude<LimitKind, 'all'> | null {
  const path = url.split('?')[0]!;
  const m = method.toUpperCase();
  if (path === '/ws') return 'socket';
  if (m === 'POST' && (path === '/api/join' || path === '/api/join/resume')) return 'join';
  if (path.startsWith('/api/games/by-code/')) return 'lookup';
  if (path === '/api/evidence' || path === '/api/avatar') return 'upload';
  return null;
}

/**
 * Fixed one-minute windows per client and kind. In memory: a restart forgets them, which is
 * fine for slowing down abuse. Old windows are dropped as the map grows.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limits: Record<string, number>,
    private readonly clock: () => number = Date.now,
    private readonly windowMs = 60_000,
  ) {}

  /** Counts the request; returns the seconds to wait when it is over the limit, else 0. */
  hit(client: string, kind: string): number {
    const limit = this.limits[kind];
    if (limit === undefined) return 0;
    const now = this.clock();
    if (this.windows.size > 20_000) {
      for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k);
    }
    const key = `${kind}|${client}`;
    let w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      w = { start: now, count: 0 };
      this.windows.set(key, w);
    }
    w.count += 1;
    return w.count > limit ? Math.max(1, Math.ceil((w.start + this.windowMs - now) / 1000)) : 0;
  }
}
