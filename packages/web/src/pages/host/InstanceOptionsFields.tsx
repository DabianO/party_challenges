import type { Availability, EvaluationMode, InstanceOptions, ModuleInfo, PlayerPublic } from '@challenge/contract';
import { availabilityHelp, availabilityLabel, evaluationHelp, evaluationLabel } from '../../components/PhaseBadge';

const AVAILABILITIES: Availability[] = ['open', 'host-unlocked', 'assigned'];
const ALL_MODES: EvaluationMode[] = ['automatic', 'peer', 'host', 'hybrid'];

export const DEFAULT_OPTIONS: InstanceOptions = { title: '', category: '', availability: 'open', assignedPlayerIds: [], evaluationMode: null, allowReplay: false, inPresentation: true };

export const TITLE_MAX = 80;
export const CATEGORY_MAX = 40;

export function optionsOf(
  inst:
    | {
        customTitle?: string;
        category?: string;
        allowReplay?: boolean;
        inPresentation?: boolean;
        availability: Availability;
        assignedPlayerIds?: string[];
        evaluationMode?: EvaluationMode | null;
        evaluationModeOverride?: EvaluationMode | null;
      }
    | undefined,
  moduleDefault?: EvaluationMode,
): InstanceOptions {
  if (!inst) return DEFAULT_OPTIONS;
  return {
    title: inst.customTitle ?? '',
    category: inst.category ?? '',
    allowReplay: inst.allowReplay ?? false,
    inPresentation: inst.inPresentation ?? true,
    availability: inst.availability,
    assignedPlayerIds: inst.assignedPlayerIds ?? [],
    // Host snapshots carry the explicit override; fall back to inferring it from the effective mode.
    evaluationMode:
      inst.evaluationModeOverride !== undefined
        ? inst.evaluationModeOverride
        : inst.evaluationMode && inst.evaluationMode !== moduleDefault
          ? inst.evaluationMode
          : null,
  };
}

export function supportedModesOf(module: ModuleInfo | undefined): EvaluationMode[] {
  if (!module) return ALL_MODES;
  const declared = module.manifest.evaluation.supportedModes;
  const list = declared && declared.length > 0 ? declared : [module.manifest.evaluation.mode];
  return ALL_MODES.filter((m) => list.includes(m));
}

export interface InstanceOptionsFieldsProps {
  value: InstanceOptions;
  onChange: (next: InstanceOptions) => void;
  players: PlayerPublic[];
  module: ModuleInfo | undefined;
  disabled?: boolean;
  idPrefix?: string;
}

/** The title and category players see first: shown above the module configuration. */
export function TitleField({
  value,
  onChange,
  module,
  categories = [],
  disabled = false,
  idPrefix = 'opt',
}: Omit<InstanceOptionsFieldsProps, 'players'> & { categories?: string[] }) {
  return (
    <div className="title-fields">
      <div className="form-field">
        <label className="field-label" htmlFor={`${idPrefix}-title`}>
          Title
        </label>
        <input
          id={`${idPrefix}-title`}
          className="input input-lg"
          type="text"
          maxLength={TITLE_MAX}
          value={value.title}
          disabled={disabled}
          placeholder={module?.manifest.name ?? 'Challenge title'}
          onChange={(e) => onChange({ ...value, title: e.target.value })}
        />
        <p className="field-help">What players see on the tile. Leave empty to show “{module?.manifest.name ?? 'the module name'}”.</p>
      </div>
      <div className="form-field">
        <label className="field-label" htmlFor={`${idPrefix}-category`}>
          Category
        </label>
        <input
          id={`${idPrefix}-category`}
          className="input input-lg"
          type="text"
          maxLength={CATEGORY_MAX}
          value={value.category}
          disabled={disabled}
          placeholder="e.g. Intelligence"
          list={`${idPrefix}-categories`}
          onChange={(e) => onChange({ ...value, category: e.target.value })}
        />
        <datalist id={`${idPrefix}-categories`}>
          {categories.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <p className="field-help">Players' boards group challenges by category. Optional.</p>
      </div>
    </div>
  );
}

/** The game's categories in board order, for suggestions. */
export function categoriesOf(challenges: { category: string }[]): string[] {
  return [...new Set(challenges.map((c) => c.category).filter(Boolean))];
}

/** Engine-owned per-instance options (replays, availability, assignees, evaluation override) — shared by add and edit. */
export function InstanceOptionsFields({ value, onChange, players, module, disabled = false, idPrefix = 'opt' }: InstanceOptionsFieldsProps) {
  const supported = supportedModesOf(module);
  const moduleDefault = module?.manifest.evaluation.mode;
  const replayable = module === undefined || module.manifest.results === 'immediate';
  const togglePlayer = (id: string) => {
    const set = new Set(value.assignedPlayerIds);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    onChange({ ...value, assignedPlayerIds: [...set] });
  };

  return (
    <fieldset className="stack gap-md instance-options" disabled={disabled}>
      <legend className="section-title">Instance options</legend>

      <div className="form-field">
        {module?.manifest.attempts === 'repeat' ? (
          <p className="field-help">Players take part again and again by design (one turn at a time); every contribution scores.</p>
        ) : replayable ? (
          <>
            <label className="toggle">
              <input
                type="checkbox"
                role="switch"
                checked={value.allowReplay}
                disabled={disabled}
                onChange={(e) => onChange({ ...value, allowReplay: e.target.checked })}
              />
              <span className="toggle-track" aria-hidden="true">
                <span className="toggle-thumb" />
              </span>
              <span className="toggle-label">
                Players may play it again to improve <span className="muted">({value.allowReplay ? 'on' : 'off'})</span>
              </span>
            </label>
            <p className="field-help">Only each player's best attempt counts. Good for skill challenges.</p>
          </>
        ) : (
          <p className="field-help">This challenge scores everyone together when you close it, so each player plays it once.</p>
        )}
      </div>

      <div className="form-field">
        <label className="toggle">
          <input
            type="checkbox"
            role="switch"
            checked={value.inPresentation}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, inPresentation: e.target.checked })}
          />
          <span className="toggle-track" aria-hidden="true">
            <span className="toggle-thumb" />
          </span>
          <span className="toggle-label">
            In the results presentation <span className="muted">({value.inPresentation ? 'on' : 'off'})</span>
          </span>
        </label>
        <p className="field-help">Once it is closed, its results get a slide on the big screen when you present (no points on slides).</p>
      </div>

      <div className="form-field">
        <span className="field-label" id={`${idPrefix}-availability-label`}>
          Who can start it?
        </span>
        <div className="row gap-sm wrap" role="radiogroup" aria-labelledby={`${idPrefix}-availability-label`}>
          {AVAILABILITIES.map((a) => {
            const selected = value.availability === a;
            return (
              <button
                key={a}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`btn btn-secondary btn-sm${selected ? ' is-selected' : ''}`}
                disabled={disabled}
                onClick={() => onChange({ ...value, availability: a })}
              >
                {selected ? '✓ ' : ''}
                {availabilityLabel(a)}
              </button>
            );
          })}
        </div>
        <p className="field-help">{availabilityHelp(value.availability)}</p>
      </div>

      {value.availability === 'assigned' && (
        <div className="form-field">
          <span className="field-label">Assigned players ({value.assignedPlayerIds.length})</span>
          {players.length === 0 ? (
            <p className="field-help">No players have joined yet. You can assign players later from the Run tab.</p>
          ) : (
            <ul className="plain-list picker">
              {players.map((p) => {
                const checked = value.assignedPlayerIds.includes(p.id);
                return (
                  <li key={p.id}>
                    <label className={`picker-row${checked ? ' is-checked' : ''}`}>
                      <input type="checkbox" checked={checked} disabled={disabled} onChange={() => togglePlayer(p.id)} />
                      <span className="grow">{p.displayName}</span>
                      <span aria-hidden="true" className="picker-check">
                        {checked ? '✓' : ''}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {value.assignedPlayerIds.some((id) => !players.some((p) => p.id === id)) && (
            <p className="field-help">Some assigned players have left the game.</p>
          )}
        </div>
      )}

      <div className="form-field">
        <label className="field-label" htmlFor={`${idPrefix}-evaluation`}>
          Who evaluates this challenge?
        </label>
        {supported.length <= 1 ? (
          <p className="field-help">
            This module always uses <strong>{evaluationLabel(supported[0] ?? moduleDefault ?? 'automatic').toLowerCase()}</strong> — the game-level preference does not apply to it.
          </p>
        ) : (
          <>
            <select
              id={`${idPrefix}-evaluation`}
              className="input"
              value={value.evaluationMode ?? ''}
              disabled={disabled}
              onChange={(e) => onChange({ ...value, evaluationMode: (e.target.value || null) as EvaluationMode | null })}
            >
              <option value="">Module default{moduleDefault ? ` (${evaluationLabel(moduleDefault).toLowerCase()})` : ''} — follows the game preference</option>
              {supported.map((m) => (
                <option key={m} value={m}>
                  {evaluationLabel(m)}
                </option>
              ))}
            </select>
            <p className="field-help">{value.evaluationMode ? evaluationHelp(value.evaluationMode) : 'Leave on module default unless this challenge needs a different judge.'}</p>
          </>
        )}
      </div>
    </fieldset>
  );
}

/** Checkbox list used by the Run tab's "Assign to players…" action. */
export function PlayerPicker({ players, selected, onChange, disabled }: { players: PlayerPublic[]; selected: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  if (players.length === 0) return <p className="field-help">No players have joined yet.</p>;
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <ul className="plain-list picker">
      {players.map((p) => {
        const checked = selected.includes(p.id);
        return (
          <li key={p.id}>
            <label className={`picker-row${checked ? ' is-checked' : ''}`}>
              <input type="checkbox" checked={checked} disabled={disabled} onChange={() => toggle(p.id)} />
              <span className="grow">{p.displayName}</span>
              <span aria-hidden="true" className="picker-check">
                {checked ? '✓' : ''}
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
