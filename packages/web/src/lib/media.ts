const MEDIA_PREFIX = 'media://';

/** Turns a `media://<id>` reference into a URL the browser can load; other strings pass through. */
export function resolveMedia(ref: string): string;
export function resolveMedia(ref: string | undefined | null): string | undefined;
export function resolveMedia(ref: string | undefined | null): string | undefined {
  if (!ref) return undefined;
  if (ref.startsWith(MEDIA_PREFIX)) return `/media/${encodeURIComponent(ref.slice(MEDIA_PREFIX.length))}`;
  return ref;
}

export function isMediaRef(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(MEDIA_PREFIX);
}
