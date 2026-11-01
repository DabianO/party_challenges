import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONTRACT_API_VERSION, type ChallengeModule, type EvaluationMode, type Manifest, type ModuleInfo } from '@challenge/contract';

export type AnyModule = ChallengeModule<any, any, any, any>;

export interface LoadedModule {
  module: AnyModule;
  manifest: Manifest;
  /** Directory the module was loaded from (for assets), if any. */
  dir: string | null;
}

export class ModuleLoadError extends Error {}

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function validateManifest(m: unknown, source: string): Manifest {
  if (!m || typeof m !== 'object') throw new ModuleLoadError(`${source}: manifest must be an object`);
  const man = m as Record<string, unknown>;
  const req = (key: string, type: string) => {
    if (typeof man[key] !== type) throw new ModuleLoadError(`${source}: manifest.${key} must be a ${type}`);
  };
  req('id', 'string');
  req('name', 'string');
  req('version', 'string');
  req('apiVersion', 'string');
  req('category', 'string');
  req('description', 'string');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(man.id as string)) throw new ModuleLoadError(`${source}: manifest.id must be kebab-case`);
  if (!SEMVER.test(man.version as string)) throw new ModuleLoadError(`${source}: manifest.version must be SemVer`);
  if (man.apiVersion !== CONTRACT_API_VERSION) {
    throw new ModuleLoadError(
      `${source}: module targets contract apiVersion ${String(man.apiVersion)}, engine supports ${CONTRACT_API_VERSION} (MR-5)`,
    );
  }
  if (!Array.isArray(man.capabilities)) throw new ModuleLoadError(`${source}: manifest.capabilities must be an array`);

  const MODES = ['automatic', 'peer', 'host', 'hybrid'];
  const ev = (typeof man.evaluation === 'string' ? { mode: man.evaluation } : man.evaluation) as Record<string, unknown> | undefined;
  if (!ev || typeof ev !== 'object' || !MODES.includes(ev.mode as string)) {
    throw new ModuleLoadError(`${source}: manifest.evaluation.mode must be automatic | peer | host | hybrid (MR-17)`);
  }
  const supported = Array.isArray(ev.supportedModes) ? (ev.supportedModes as string[]) : [ev.mode as string];
  if (!supported.includes(ev.mode as string)) supported.push(ev.mode as string);
  if (supported.some((m) => !MODES.includes(m))) throw new ModuleLoadError(`${source}: manifest.evaluation.supportedModes contains an unknown mode`);
  if (supported.some((m) => m !== 'automatic') && typeof ev.criteria !== 'string') {
    throw new ModuleLoadError(`${source}: non-automatic evaluation requires manifest.evaluation.criteria (MR-17)`);
  }
  const results = (man.results as string | undefined) ?? 'immediate';
  if (!['immediate', 'onClose'].includes(results)) throw new ModuleLoadError(`${source}: manifest.results must be immediate | onClose`);
  if (results === 'onClose' && supported.some((m) => m !== 'automatic')) {
    throw new ModuleLoadError(`${source}: onClose modules only support automatic evaluation`);
  }
  const attempts = (man.attempts as string | undefined) ?? 'once';
  if (!['once', 'repeat'].includes(attempts)) throw new ModuleLoadError(`${source}: manifest.attempts must be once | repeat`);
  if (attempts === 'repeat' && results !== 'immediate') throw new ModuleLoadError(`${source}: attempts "repeat" requires results "immediate"`);
  if (man.suggestedCategory !== undefined && (typeof man.suggestedCategory !== 'string' || man.suggestedCategory.length > 40)) {
    throw new ModuleLoadError(`${source}: manifest.suggestedCategory must be a string of at most 40 characters`);
  }
  if (man.suggestedReplay !== undefined && typeof man.suggestedReplay !== 'boolean') {
    throw new ModuleLoadError(`${source}: manifest.suggestedReplay must be true or false`);
  }
  if (man.supersededBy !== undefined && (typeof man.supersededBy !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(man.supersededBy))) {
    throw new ModuleLoadError(`${source}: manifest.supersededBy must be a module id`);
  }
  return {
    ...(man as unknown as Manifest),
    attempts: attempts as Manifest['attempts'],
    players: (man.players as Manifest['players']) ?? { min: 1, max: null },
    duration: (man.duration as Manifest['duration']) ?? { typicalSeconds: 60 },
    evaluation: {
      mode: ev.mode as EvaluationMode,
      supportedModes: supported as EvaluationMode[],
      criteria: ev.criteria as string | undefined,
      evidence: ev.evidence as Manifest['evaluation']['evidence'],
      hostScoring: ev.hostScoring as Manifest['evaluation']['hostScoring'],
      deadlineSeconds: typeof ev.deadlineSeconds === 'number' ? ev.deadlineSeconds : undefined,
    },
    results: results as Manifest['results'],
    resubmission: (man.resubmission as Manifest['resubmission']) ?? 'none',
  };
}

const REQUIRED_FUNCTIONS: (keyof AnyModule)[] = [
  'createInstance',
  'validateInput',
  'handleInput',
  'evaluate',
  'calculateScores',
  'getStatistics',
  'guestView',
  'resultsView',
];

export function validateModule(mod: unknown, source: string): AnyModule {
  if (!mod || typeof mod !== 'object') throw new ModuleLoadError(`${source}: module export must be an object`);
  const m = mod as Record<string, unknown>;
  for (const fn of REQUIRED_FUNCTIONS) {
    if (typeof m[fn] !== 'function') throw new ModuleLoadError(`${source}: module is missing ${fn}()`);
  }
  validateManifest(m.manifest, source);
  if ((typeof m.hostResolutionView === 'function') !== (typeof m.applyHostResolution === 'function')) {
    throw new ModuleLoadError(`${source}: hostResolutionView() and applyHostResolution() must be implemented together`);
  }
  if ((typeof m.validateAction === 'function') !== (typeof m.onAction === 'function')) {
    throw new ModuleLoadError(`${source}: validateAction() and onAction() must be implemented together`);
  }
  if (!m.configurationSchema || typeof m.configurationSchema !== 'object') {
    throw new ModuleLoadError(`${source}: configurationSchema must be a JSON Schema object`);
  }
  return mod as AnyModule;
}

/**
 * Challenge Library (spec §6): the catalog of installed modules. Multiple versions of
 * the same module may be installed side by side; games pin exact versions (MR-15), and
 * move to a newer minor of the same major only when the pinned one is gone (`compatible`).
 */
export class ModuleRegistry {
  private readonly byKey = new Map<string, LoadedModule>();

  register(module: AnyModule, dir: string | null = null): LoadedModule {
    const validated = validateModule(module, dir ?? module.manifest?.id ?? 'module');
    const manifest = validateManifest(validated.manifest, dir ?? validated.manifest.id);
    const key = `${manifest.id}@${manifest.version}`;
    if (this.byKey.has(key)) throw new ModuleLoadError(`Duplicate module ${key}`);
    const loaded: LoadedModule = { module: validated, manifest, dir };
    this.byKey.set(key, loaded);
    return loaded;
  }

  /** Exact version lookup (used by running games). */
  get(id: string, version: string): LoadedModule | undefined {
    return this.byKey.get(`${id}@${version}`);
  }

  /**
   * Newest installed version with the same major as `version` and not older than it.
   * Minor/patch releases must stay state-compatible, so games pinned to an older minor
   * move up to it when the exact pinned version is no longer installed.
   */
  compatible(id: string, version: string): LoadedModule | undefined {
    const major = version.split('.')[0];
    const candidates = [...this.byKey.values()].filter(
      (m) => m.manifest.id === id && m.manifest.version.split('.')[0] === major && compareSemver(m.manifest.version, version) >= 0,
    );
    candidates.sort((a, b) => compareSemver(b.manifest.version, a.manifest.version));
    return candidates[0];
  }

  /** Latest installed version of a module (used when hosts add new instances). */
  latest(id: string): LoadedModule | undefined {
    const candidates = [...this.byKey.values()].filter((m) => m.manifest.id === id);
    candidates.sort((a, b) => compareSemver(b.manifest.version, a.manifest.version));
    return candidates[0];
  }

  list(): LoadedModule[] {
    const latest = new Map<string, LoadedModule>();
    for (const m of this.byKey.values()) {
      const cur = latest.get(m.manifest.id);
      if (!cur || compareSemver(m.manifest.version, cur.manifest.version) > 0) latest.set(m.manifest.id, m);
    }
    return [...latest.values()].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  }

  info(): ModuleInfo[] {
    return this.list().map((m) => ({ manifest: m.manifest, configurationSchema: m.module.configurationSchema }));
  }

  get size(): number {
    return this.byKey.size;
  }
}

export function compareSemver(a: string, b: string): number {
  const pa = a.split('-')[0]!.split('.').map(Number);
  const pb = b.split('-')[0]!.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export interface DiscoveryResult {
  loaded: LoadedModule[];
  failed: { dir: string; error: string }[];
}

/**
 * FR-16 / MR-1: discover modules from a directory. Each sub-directory containing a
 * `manifest.json` is treated as a module package whose server entry is
 * `server/index.js` (built) or `server/index.ts` (source, when running under a TS loader).
 */
export async function discoverModules(root: string, registry: ModuleRegistry): Promise<DiscoveryResult> {
  const result: DiscoveryResult = { loaded: [], failed: [] };
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return result;
  }
  for (const name of entries.sort()) {
    const dir = join(root, name);
    try {
      if (!(await stat(dir)).isDirectory()) continue;
      const manifestPath = join(dir, 'manifest.json');
      let manifestRaw: string;
      try {
        manifestRaw = await readFile(manifestPath, 'utf8');
      } catch {
        continue; // not a module package
      }
      const manifest = validateManifest(JSON.parse(manifestRaw), name);
      const entry = await resolveEntry(dir);
      if (!entry) throw new ModuleLoadError(`${name}: no server/index.(js|ts) entry point`);
      const imported = (await import(pathToFileURL(entry).href)) as { default?: unknown };
      const mod = validateModule(imported.default, name);
      // The on-disk manifest is authoritative for identity; the module must agree.
      if (mod.manifest.id !== manifest.id || mod.manifest.version !== manifest.version) {
        throw new ModuleLoadError(`${name}: manifest.json (${manifest.id}@${manifest.version}) does not match module export`);
      }
      result.loaded.push(registry.register(mod, dir));
    } catch (err) {
      result.failed.push({ dir, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

async function resolveEntry(dir: string): Promise<string | null> {
  for (const candidate of ['server/index.js', 'server/index.mjs', 'server/index.ts']) {
    const p = join(dir, candidate);
    try {
      if ((await stat(p)).isFile()) return p;
    } catch {
      /* try next */
    }
  }
  return null;
}
