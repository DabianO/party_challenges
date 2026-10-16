import type { Availability, EvaluationMode, InstanceOptions, ModuleInfo, PlayerPublic } from '@challenge/contract';
import { availabilityHelp, availabilityLabel, evaluationHelp, evaluationLabel } from '../../components/PhaseBadge';

const AVAILABILITIES: Availability[] = ['open', 'host-unlocked', 'assigned'];
const ALL_MODES: EvaluationMode[] = ['automatic', 'peer', 'host', 'hybrid'];

export const DEFAULT_OPTIONS: InstanceOptions = { availability: 'open', assignedPlayerIds: [], evaluationMode: null };

export function optionsOf(
  inst: { availability: Availability; assignedPlayerIds?: string[]; evaluationMode?: EvaluationMode | null; evaluationModeOverride?: EvaluationMode | null } | undefined,
  moduleDefault?: EvaluationMode,
): InstanceOptions {
  if (!inst) return DEFAULT_OPTIONS;
  return {
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

/** Engine-owned per-instance options (availability, assignees, evaluation override) — shared by add and edit. */
export function InstanceOptionsFields({ value, onChange, players, module, disabled = false, idPrefix = 'opt' }: InstanceOptionsFieldsProps) {
  const supported = supportedModesOf(module);
  const moduleDefault = module?.manifest.evaluation.mode;
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
