/**
 * Setup files (JSON backups of a game's configuration) carry the media they reference,
 * so a setup imports on a fresh server. The walk is generic: any string value of the
 * form `media://<id>` in module configuration or branding counts as a reference; the
 * engine and modules stay unaware of this.
 */
import type { GameSetup } from '@challenge/contract';
import type { GameRuntime } from '@challenge/engine';
import { MediaError, type MediaService } from './media.ts';

const MEDIA_REF = /^media:\/\/[A-Za-z0-9_-]+$/;

/** Every `media://` reference inside a JSON value. */
export function collectMediaRefs(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    if (MEDIA_REF.test(value)) out.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectMediaRefs(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectMediaRefs(v, out);
  }
  return out;
}

/** A copy of a JSON value with media references swapped through `map` (unmapped refs stay). */
export function rewriteMediaRefs<T>(value: T, map: Map<string, string>): T {
  if (typeof value === 'string') return (map.get(value) ?? value) as T;
  if (Array.isArray(value)) return value.map((v) => rewriteMediaRefs(v, map)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewriteMediaRefs(v, map)])) as T;
  }
  return value;
}

/** The game's setup with every referenced media file embedded (base64). */
export async function exportSetupWithMedia(game: GameRuntime, media: MediaService): Promise<GameSetup> {
  const setup = game.exportSetup();
  const refs = collectMediaRefs([setup.game.branding, setup.challenges.map((c) => c.configuration)]);
  for (const ref of refs) {
    const file = await media.read(ref);
    if (file) setup.media[ref] = { mimeType: file.record.mimeType, name: file.record.originalName, data: file.data.toString('base64') };
  }
  return setup;
}

/**
 * Store the media embedded in an uploaded setup on this server and point the setup at the
 * new copies. Files that are missing or fail validation are reported, and their
 * references are left as they were (the affected challenge may then fail to import).
 */
export async function importSetupMedia(raw: unknown, media: MediaService, gameId: string | null): Promise<{ setup: unknown; warnings: string[] }> {
  if (!raw || typeof raw !== 'object') return { setup: raw, warnings: [] };
  const s = raw as Partial<GameSetup>;
  const embedded = s.media && typeof s.media === 'object' ? s.media : {};
  const refs = collectMediaRefs([s.game?.branding, Array.isArray(s.challenges) ? s.challenges.map((c) => c?.configuration) : []]);
  const map = new Map<string, string>();
  const warnings: string[] = [];
  for (const ref of refs) {
    const file = embedded[ref];
    if (!file || typeof file.data !== 'string' || typeof file.mimeType !== 'string') {
      warnings.push(`The setup file does not contain ${ref}; challenges using it may be skipped`);
      continue;
    }
    try {
      const stored = await media.store({
        data: Buffer.from(file.data, 'base64'),
        mimeType: file.mimeType,
        originalName: typeof file.name === 'string' ? file.name : undefined,
        gameId,
        owner: 'game',
      });
      map.set(ref, `media://${stored.id}`);
    } catch (err) {
      warnings.push(`${file.name ?? ref} could not be restored: ${err instanceof MediaError ? err.message : 'storage error'}`);
    }
  }
  const { media: _media, ...rest } = s;
  return { setup: { ...rewriteMediaRefs(rest, map), media: {} }, warnings };
}
