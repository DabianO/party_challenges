import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModuleRegistry, discoverModules } from '@challenge/engine';
import { buildApp } from './app.ts';
import { lanAddress, rankAddresses } from './network.ts';
import { SqliteRepository } from './sqlite.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

const dev = process.argv.includes('--dev');
const PORT = Number(process.env.PORT ?? 3000);
/** Internet mode: the host's own server on this port (bind it to this machine only), PORT is public. */
const ADMIN_PORT = process.env.ADMIN_PORT ? Number(process.env.ADMIN_PORT) : null;
const ADMIN_HOST = process.env.ADMIN_HOST ?? '127.0.0.1';
const MEDIA_MAX_PER_GAME_BYTES = process.env.MEDIA_MAX_PER_GAME_BYTES ? Number(process.env.MEDIA_MAX_PER_GAME_BYTES) : null;
const HOST = process.env.HOST ?? '0.0.0.0';
const DATA_DIR = resolve(process.env.DATA_DIR ?? join(repoRoot, 'data'));
const CHALLENGES_DIR = resolve(process.env.CHALLENGES_DIR ?? join(repoRoot, 'challenges'));
const WEB_DIST = resolve(process.env.WEB_DIST ?? join(repoRoot, 'packages/web/dist'));
const MEDIA_MAX_BYTES = Number(process.env.MEDIA_MAX_BYTES ?? 10 * 1024 * 1024);
const HOST_CREATE_PASSWORD = process.env.HOST_CREATE_PASSWORD || null;
/** Browsers on this machine may list every stored game (see AppConfig.localHostAccess). */
const LOCAL_HOST_ACCESS = process.env.LOCAL_HOST_ACCESS !== '0';

/** Secret behind the stable host tokens; created once and kept with the data. */
function loadHostKey(dir: string): string {
  const path = join(dir, 'host-key');
  if (existsSync(path)) {
    const key = readFileSync(path, 'utf8').trim();
    if (key.length >= 32) return key;
  }
  mkdirSync(dir, { recursive: true });
  const key = randomBytes(32).toString('base64url');
  writeFileSync(path, `${key}\n`, { mode: 0o600 });
  return key;
}

// In dev the Vite server (5173) is the origin browsers use; it proxies /api, /media and /ws.
const publicPort = Number(process.env.PUBLIC_PORT ?? (dev ? 5173 : PORT));
const MEDIA_BASE_URL = (process.env.MEDIA_BASE_URL ?? '').replace(/\/$/, '');

async function main(): Promise<void> {
  // Join links / QR codes must use an address phones on the Wi-Fi can reach (not a virtual adapter).
  const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://${await lanAddress()}:${publicPort}`).replace(/\/$/, '');
  const registry = new ModuleRegistry();
  const discovery = await discoverModules(CHALLENGES_DIR, registry);
  for (const m of discovery.loaded) console.log(`[modules] loaded ${m.manifest.id}@${m.manifest.version} (${m.manifest.name})`);
  for (const f of discovery.failed) console.error(`[modules] FAILED ${f.dir}: ${f.error}`);
  if (registry.size === 0) console.warn(`[modules] no modules found in ${CHALLENGES_DIR}`);

  const dbPath = join(DATA_DIR, 'platform.sqlite');
  const repo = new SqliteRepository(dbPath);
  const { app, engine, adminServer } = await buildApp({
    registry,
    repo,
    dataDir: DATA_DIR,
    publicUrl: PUBLIC_URL,
    mediaBaseUrl: MEDIA_BASE_URL,
    mediaMaxBytes: MEDIA_MAX_BYTES,
    hostCreatePassword: HOST_CREATE_PASSWORD,
    // In dev the client comes from Vite; a build in packages/web/dist may be out of date.
    webDistDir: dev ? null : WEB_DIST,
    webDevPort: dev ? publicPort : null,
    logger: process.env.LOG === '1',
    hostKey: loadHostKey(DATA_DIR),
    localHostAccess: LOCAL_HOST_ACCESS,
    adminSurface: ADMIN_PORT !== null,
    mediaMaxPerGameBytes: MEDIA_MAX_PER_GAME_BYTES,
  });
  const { restored } = await engine.init();
  console.log(`[engine] restored ${restored} game(s); every change is saved automatically to ${dbPath}`);

  await app.listen({ port: PORT, host: HOST });
  if (adminServer && ADMIN_PORT !== null) {
    await new Promise<void>((resolve, reject) => adminServer.once('error', reject).listen(ADMIN_PORT, ADMIN_HOST, () => resolve()));
    console.log(`[server] public (guests and big screen only) on http://${HOST}:${PORT}`);
    console.log(`[server] host controls on http://localhost:${ADMIN_PORT}/host (bound to ${ADMIN_HOST})`);
  } else {
    console.log(`[server] listening on http://${HOST}:${PORT}`);
  }
  console.log(`[server] join links / QR codes use ${PUBLIC_URL}`);
  if (!process.env.PUBLIC_URL) {
    const others = rankAddresses().filter((c) => !PUBLIC_URL.includes(`//${c.address}:`));
    if (others.length) console.log(`[server] other addresses on this machine: ${others.map((c) => `${c.address} (${c.name})`).join(', ')} — set PUBLIC_URL if phones need one of those`);
  }

  const shutdown = async (signal: string) => {
    console.log(`[server] ${signal} received, shutting down`);
    try {
      await engine.shutdown();
      await app.close();
      repo.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
