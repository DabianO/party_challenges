import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModuleRegistry, discoverModules } from '@challenge/engine';
import { buildApp } from './app.ts';
import { SqliteRepository } from './sqlite.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

const dev = process.argv.includes('--dev');
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const DATA_DIR = resolve(process.env.DATA_DIR ?? join(repoRoot, 'data'));
const CHALLENGES_DIR = resolve(process.env.CHALLENGES_DIR ?? join(repoRoot, 'challenges'));
const WEB_DIST = resolve(process.env.WEB_DIST ?? join(repoRoot, 'packages/web/dist'));
const MEDIA_MAX_BYTES = Number(process.env.MEDIA_MAX_BYTES ?? 10 * 1024 * 1024);
const HOST_CREATE_PASSWORD = process.env.HOST_CREATE_PASSWORD || null;

/** Best-effort LAN address so phones on the same Wi-Fi can reach the join URL. */
function lanAddress(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

// In dev the Vite server (5173) is the origin browsers use; it proxies /api, /media and /ws.
const publicPort = Number(process.env.PUBLIC_PORT ?? (dev ? 5173 : PORT));
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://${lanAddress()}:${publicPort}`).replace(/\/$/, '');
const MEDIA_BASE_URL = (process.env.MEDIA_BASE_URL ?? '').replace(/\/$/, '');

async function main(): Promise<void> {
  const registry = new ModuleRegistry();
  const discovery = await discoverModules(CHALLENGES_DIR, registry);
  for (const m of discovery.loaded) console.log(`[modules] loaded ${m.manifest.id}@${m.manifest.version} (${m.manifest.name})`);
  for (const f of discovery.failed) console.error(`[modules] FAILED ${f.dir}: ${f.error}`);
  if (registry.size === 0) console.warn(`[modules] no modules found in ${CHALLENGES_DIR}`);

  const repo = new SqliteRepository(join(DATA_DIR, 'platform.sqlite'));
  const { app, engine } = await buildApp({
    registry,
    repo,
    dataDir: DATA_DIR,
    publicUrl: PUBLIC_URL,
    mediaBaseUrl: MEDIA_BASE_URL,
    mediaMaxBytes: MEDIA_MAX_BYTES,
    hostCreatePassword: HOST_CREATE_PASSWORD,
    webDistDir: WEB_DIST,
    logger: process.env.LOG === '1',
  });
  const { restored } = await engine.init();
  console.log(`[engine] restored ${restored} game(s) from ${DATA_DIR}`);

  await app.listen({ port: PORT, host: HOST });
  console.log(`[server] listening on http://${HOST}:${PORT}  (public URL: ${PUBLIC_URL})`);

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
