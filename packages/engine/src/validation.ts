import { Ajv, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';

// ajv-formats is CJS with both module.exports and .default set; normalise across loaders.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (ajv: Ajv) => Ajv;
import type { JsonSchema } from '@challenge/contract';

const ajv = new Ajv({ allErrors: true, useDefaults: true, coerceTypes: true, strict: false });
addFormats(ajv);
// MR-8: media references produced by the platform media service.
ajv.addFormat('media-ref', /^media:\/\/[A-Za-z0-9_-]+$/);

const cache = new WeakMap<JsonSchema, ValidateFunction>();

export interface ConfigValidation {
  ok: boolean;
  /** Configuration with schema defaults applied (and types coerced). */
  value: Record<string, unknown>;
  errors: string[];
}

/** MR-7: validate module configuration server-side against the module's schema. */
export function validateConfiguration(schema: JsonSchema, configuration: unknown): ConfigValidation {
  let validate = cache.get(schema);
  if (!validate) {
    validate = ajv.compile(schema);
    cache.set(schema, validate);
  }
  const value = structuredClone(configuration ?? {}) as Record<string, unknown>;
  const ok = validate(value) as boolean;
  const errors = ok
    ? []
    : (validate.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'is invalid'}`.trim());
  return { ok, value, errors };
}

// ---------------------------------------------------------------------------
// Display names (FR-31)
// ---------------------------------------------------------------------------

export const DISPLAY_NAME_MAX = 20;

const BLOCKED_WORDS = ['fuck', 'shit', 'cunt', 'nigger', 'faggot', 'bitch', 'hitler', 'nazi'];

// Control characters, zero-width characters, bidi overrides and BOM.
const UNSAFE_CHARS = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u2028-\\u202E\\uFEFF]', 'g');

export type NameValidation = { ok: true; name: string } | { ok: false; reason: string };

export function sanitizeDisplayName(raw: unknown): NameValidation {
  if (typeof raw !== 'string') return { ok: false, reason: 'Name is required' };
  const name = raw.replace(UNSAFE_CHARS, '').replace(/\s+/g, ' ').trim();
  if (name.length === 0) return { ok: false, reason: 'Name is required' };
  if (name.length > DISPLAY_NAME_MAX) return { ok: false, reason: `Name must be at most ${DISPLAY_NAME_MAX} characters` };
  const lowered = name.toLowerCase().replace(/[^a-z]/g, '');
  if (BLOCKED_WORDS.some((w) => lowered.includes(w))) return { ok: false, reason: 'Please choose a different name' };
  return { ok: true, name };
}

/** Auto-suffix on collision: "Sam" → "Sam (2)". */
export function uniqueDisplayName(name: string, taken: Iterable<string>): string {
  const takenLower = new Set([...taken].map((n) => n.toLowerCase()));
  if (!takenLower.has(name.toLowerCase())) return name;
  for (let i = 2; i < 1000; i++) {
    const suffix = ` (${i})`;
    const base = name.slice(0, DISPLAY_NAME_MAX - suffix.length);
    const candidate = `${base}${suffix}`;
    if (!takenLower.has(candidate.toLowerCase())) return candidate;
  }
  return `${name.slice(0, DISPLAY_NAME_MAX - 5)}-${Math.floor(Math.random() * 9999)}`;
}
