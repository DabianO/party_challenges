/**
 * Media service (spec §15, SR-8).
 *
 * Uploads are validated (type allow-list, size limit, magic-byte sniffing), stored on
 * disk under an opaque id and served from /media/<id> with a sandboxing CSP and
 * `nosniff`, so a hostile upload cannot execute in the application origin. For a
 * hardened deployment set MEDIA_BASE_URL to a separate origin.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, createReadStream, existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { newId } from '@challenge/engine';
import type { MediaRecord, SqliteRepository } from './sqlite.ts';

const ALLOWED: Record<string, { ext: string; sniff?: (b: Buffer) => boolean }> = {
  'image/png': { ext: 'png', sniff: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/jpeg': { ext: 'jpg', sniff: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/gif': { ext: 'gif', sniff: (b) => b.subarray(0, 3).toString('ascii') === 'GIF' },
  'image/webp': { ext: 'webp', sniff: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP' },
  'video/mp4': { ext: 'mp4', sniff: (b) => b.subarray(4, 8).toString('ascii') === 'ftyp' },
  'video/webm': { ext: 'webm', sniff: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  'audio/mpeg': { ext: 'mp3', sniff: (b) => b.subarray(0, 3).toString('ascii') === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) },
  'audio/ogg': { ext: 'ogg', sniff: (b) => b.subarray(0, 4).toString('ascii') === 'OggS' },
  'audio/wav': { ext: 'wav', sniff: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WAVE' },
};

export class MediaError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

export class MediaService {
  constructor(
    private readonly dir: string,
    private readonly repo: SqliteRepository,
    readonly maxBytes: number,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  static allowedTypes(): string[] {
    return Object.keys(ALLOWED);
  }

  async store(input: {
    data: Buffer;
    mimeType: string;
    originalName?: string;
    gameId: string | null;
    owner: 'game' | 'challenge_instance' | 'submission' | 'player';
  }): Promise<MediaRecord> {
    const mime = input.mimeType.toLowerCase().split(';')[0]!.trim();
    const spec = ALLOWED[mime];
    if (!spec) throw new MediaError(`Unsupported media type ${mime}`, 415);
    if (input.data.length === 0) throw new MediaError('Empty upload');
    if (input.data.length > this.maxBytes) throw new MediaError(`File exceeds ${Math.round(this.maxBytes / 1024 / 1024)} MB limit`, 413);
    if (spec.sniff && !spec.sniff(input.data)) throw new MediaError('File content does not match its declared type');

    const id = newId('m').replace(/[^A-Za-z0-9_-]/g, '');
    const storageRef = `${id}.${spec.ext}`;
    await writeFile(join(this.dir, storageRef), input.data);
    const record: MediaRecord = {
      id,
      gameId: input.gameId,
      owner: input.owner,
      mimeType: mime,
      storageRef,
      size: input.data.length,
      checksum: createHash('sha256').update(input.data).digest('hex'),
      originalName: input.originalName ? input.originalName.slice(0, 200) : null,
      createdAt: Date.now(),
    };
    this.repo.insertMedia(record);
    return record;
  }

  get(id: string): { record: MediaRecord; stream: () => NodeJS.ReadableStream } | null {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
    const record = this.repo.getMedia(id);
    if (!record) return null;
    const path = join(this.dir, record.storageRef);
    if (!existsSync(path)) return null;
    return { record, stream: () => createReadStream(path) };
  }

  /** Whole file contents for a `media://<id>` reference (setup exports); null when unknown or missing. */
  async read(ref: string): Promise<{ record: MediaRecord; data: Buffer } | null> {
    const id = MediaService.idOf(ref);
    const found = id ? this.get(id) : null;
    if (!found) return null;
    return { record: found.record, data: await readFile(join(this.dir, found.record.storageRef)) };
  }

  /** The media id of a `media://<id>` reference, or null for anything else. */
  static idOf(ref: string): string | null {
    return /^media:\/\/([A-Za-z0-9_-]+)$/.exec(ref)?.[1] ?? null;
  }

  static ref(id: string): string {
    return `media://${id}`;
  }

  /** Resolve `media://<id>` to a URL clients can load; other strings pass through. */
  static resolveUrl(ref: string, baseUrl: string): string {
    const m = /^media:\/\/([A-Za-z0-9_-]+)$/.exec(ref);
    return m ? `${baseUrl}/media/${m[1]}` : ref;
  }
}
