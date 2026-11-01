import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type { JsonSchema } from '@challenge/contract';
import { errorMessage } from '../lib/api';
import { resolveMedia } from '../lib/media';

// ---------------------------------------------------------------------------
// Schema normalisation (JSON boundary)
// ---------------------------------------------------------------------------

export interface Prop {
  type: string;
  title?: string;
  description?: string;
  enum?: string[];
  /** Labels for `enum` values, in the same order (a common JSON Schema extension). */
  enumNames?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  format?: string;
  items?: Prop;
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, Prop>;
  required?: string[];
  /**
   * A special number besides the range, from `anyOf: [{ const: 0, title: "No time limit" },
   * { minimum: 5 }]`: offered as a checkbox next to the number.
   */
  special?: { value: number; label: string };
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function normaliseProp(raw: unknown): Prop {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  let type = 'string';
  if (typeof r.type === 'string') type = r.type;
  else if (Array.isArray(r.type)) type = r.type.find((t): t is string => typeof t === 'string' && t !== 'null') ?? 'string';
  else if (Array.isArray(r.enum)) type = 'string';
  else if (r.properties) type = 'object';
  const properties = r.properties && typeof r.properties === 'object' ? Object.fromEntries(Object.entries(r.properties as Record<string, unknown>).map(([k, v]) => [k, normaliseProp(v)])) : undefined;
  // A number that is either one titled constant or within a range.
  const branches = Array.isArray(r.anyOf) ? (r.anyOf as Record<string, unknown>[]).filter((b) => b && typeof b === 'object') : [];
  const constant = branches.find((b) => typeof b.const === 'number');
  const range = branches.find((b) => b !== constant);
  const special = constant ? { value: constant.const as number, label: str(constant.title) ?? String(constant.const) } : undefined;
  return {
    type,
    title: str(r.title),
    description: str(r.description),
    enum: Array.isArray(r.enum) ? r.enum.map(String) : undefined,
    enumNames: Array.isArray(r.enumNames) ? r.enumNames.map(String) : undefined,
    default: r.default,
    minimum: num(r.minimum) ?? num(range?.minimum),
    maximum: num(r.maximum) ?? num(range?.maximum),
    multipleOf: num(r.multipleOf),
    minLength: num(r.minLength),
    maxLength: num(r.maxLength),
    format: str(r.format),
    items: r.items ? normaliseProp(r.items) : undefined,
    minItems: num(r.minItems),
    maxItems: num(r.maxItems),
    properties,
    required: Array.isArray(r.required) ? r.required.filter((x): x is string => typeof x === 'string') : undefined,
    special,
  };
}

function defaultsFor(schema: Prop): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    if (prop.default !== undefined) out[name] = prop.default;
    else if (prop.type === 'array') out[name] = Array.from({ length: prop.minItems ?? 0 }, () => (prop.items?.type === 'object' ? {} : ''));
    else if (prop.type === 'boolean') out[name] = false;
  }
  return out;
}

/** Summary shown in challenge lists: the first non-empty string property. */
export function configSummary(schema: JsonSchema | undefined, configuration: Record<string, unknown> | undefined): string | null {
  if (!configuration) return null;
  const props = schema ? normaliseProp(schema).properties ?? {} : {};
  const order = [...Object.keys(props), ...Object.keys(configuration)];
  for (const key of order) {
    const v = configuration[key];
    if (typeof v === 'string' && v.trim() && props[key]?.format !== 'media-ref') return v;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

function validateField(prop: Prop, v: unknown, required: boolean): string | null {
  if (isEmpty(v)) return required ? 'Required' : null;
  switch (prop.type) {
    case 'string': {
      const s = String(v);
      if (prop.minLength !== undefined && s.length < prop.minLength) return `At least ${prop.minLength} characters`;
      if (prop.maxLength !== undefined && s.length > prop.maxLength) return `At most ${prop.maxLength} characters`;
      if (prop.enum && !prop.enum.includes(s)) return 'Pick one of the options';
      return null;
    }
    case 'number':
    case 'integer': {
      const n = Number(v);
      if (!Number.isFinite(n)) return 'Enter a number';
      if (prop.special && n === prop.special.value) return null;
      if (prop.type === 'integer' && !Number.isInteger(n)) return 'Enter a whole number';
      if (prop.minimum !== undefined && n < prop.minimum) return `Minimum is ${prop.minimum}`;
      if (prop.maximum !== undefined && n > prop.maximum) return `Maximum is ${prop.maximum}`;
      if (prop.multipleOf && Math.abs(n / prop.multipleOf - Math.round(n / prop.multipleOf)) > 1e-9) return `Must be a multiple of ${prop.multipleOf}`;
      return null;
    }
    case 'array': {
      const arr = Array.isArray(v) ? v : [];
      if (prop.minItems !== undefined && arr.length < prop.minItems) return `Add at least ${prop.minItems}`;
      if (prop.maxItems !== undefined && arr.length > prop.maxItems) return `At most ${prop.maxItems} allowed`;
      if (prop.items?.type === 'string' && arr.some((x) => String(x ?? '').trim() === '')) return 'Fill in every row (or remove empty ones)';
      return null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

export interface SchemaFormProps {
  schema: JsonSchema;
  initialValue?: Record<string, unknown>;
  onSubmit: (value: Record<string, unknown>) => Promise<void> | void;
  onCancel?: () => void;
  submitLabel?: string;
  busy?: boolean;
  /** Error message from the server ({error}) — the authoritative validation result. */
  serverError?: string | null;
  /** Uploads a file and resolves to its `media://` ref. Required for `media-ref` fields. */
  upload?: (file: File) => Promise<string>;
  /** Fields rendered before the schema fields, inside the same form (e.g. the challenge title). */
  leading?: ReactNode;
  /** Extra fields rendered after the schema fields, inside the same form (e.g. instance options). */
  extra?: ReactNode;
}

export function SchemaForm({ schema, initialValue, onSubmit, onCancel, submitLabel = 'Save', busy = false, serverError, upload, leading, extra }: SchemaFormProps) {
  const root = useMemo(() => normaliseProp(schema), [schema]);
  const [value, setValue] = useState<Record<string, unknown>>(() => ({ ...defaultsFor(root), ...(initialValue ?? {}) }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const props = Object.entries(root.properties ?? {});
  const required = new Set(root.required ?? []);

  const update = (name: string, v: unknown) => {
    setValue((cur) => ({ ...cur, [name]: v }));
    setErrors((cur) => {
      if (!cur[name]) return cur;
      const { [name]: _drop, ...rest } = cur;
      return rest;
    });
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const found: Record<string, string> = {};
    for (const [name, prop] of props) {
      const err = validateField(prop, value[name], required.has(name));
      if (err) found[name] = err;
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    // Drop empty optional fields so the server applies its own defaults.
    const cleaned: Record<string, unknown> = {};
    for (const [name, v] of Object.entries(value)) if (!isEmpty(v) || required.has(name)) cleaned[name] = v;
    void onSubmit(cleaned);
  };

  return (
    <form className="schema-form" onSubmit={handleSubmit} noValidate>
      {leading}
      {props.length === 0 && <p className="muted">This challenge needs no configuration.</p>}
      {props.map(([name, prop]) => (
        <Field key={name} name={name} prop={prop} required={required.has(name)} value={value[name]} error={errors[name]} onChange={(v) => update(name, v)} upload={upload} />
      ))}
      {extra}
      {serverError && (
        <p className="form-error" role="alert">
          {serverError}
        </p>
      )}
      <div className="form-actions">
        {onCancel && (
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy || undefined}>
          {busy ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

interface FieldProps {
  name: string;
  prop: Prop;
  required: boolean;
  value: unknown;
  error?: string;
  onChange: (v: unknown) => void;
  upload?: (file: File) => Promise<string>;
}

function Field(props: FieldProps) {
  const { name, prop, required, error } = props;
  const id = `f-${name}`;
  const label = prop.title ?? name;
  const inline = prop.type === 'boolean';
  return (
    <div className={`form-field${error ? ' has-error' : ''}`}>
      {!inline && (
        <label className="field-label" htmlFor={id}>
          {label}
          {required && (
            <span className="req" aria-label="required">
              {' '}
              *
            </span>
          )}
        </label>
      )}
      <FieldControl {...props} id={id} label={label} />
      {prop.description && (
        <p className="field-help" id={`${id}-help`}>
          {prop.description}
        </p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function FieldControl({ prop, value, onChange, upload, id, label, required }: FieldProps & { id: string; label: string }) {
  switch (prop.type) {
    case 'string':
      if (prop.format === 'media-ref') return <MediaField id={id} value={typeof value === 'string' ? value : ''} onChange={onChange} upload={upload} />;
      if (prop.enum) {
        return (
          <select id={id} className="input" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} required={required}>
            <option value="">— choose —</option>
            {prop.enum.map((opt, i) => (
              <option key={opt} value={opt}>
                {prop.enumNames?.[i] ?? opt}
              </option>
            ))}
          </select>
        );
      }
      if ((prop.maxLength ?? 0) > 120) {
        return <textarea id={id} className="input" rows={3} maxLength={prop.maxLength} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />;
      }
      return <input id={id} className="input" type="text" maxLength={prop.maxLength} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} autoComplete="off" />;
    case 'number':
    case 'integer': {
      const input = (
        <input
          id={id}
          className="input"
          type="number"
          inputMode={prop.type === 'integer' ? 'numeric' : 'decimal'}
          min={prop.minimum}
          max={prop.maximum}
          step={prop.multipleOf ?? (prop.type === 'integer' ? 1 : 'any')}
          value={typeof value === 'number' ? value : typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number.isNaN(e.target.valueAsNumber) ? e.target.value : e.target.valueAsNumber)}
        />
      );
      if (!prop.special) return input;
      const { value: specialValue, label: specialLabel } = prop.special;
      const isSpecial = value === specialValue;
      const fallback = typeof prop.default === 'number' && prop.default !== specialValue ? prop.default : prop.minimum;
      return (
        <div className="row gap-md align-center wrap">
          {isSpecial ? <input id={id} className="input input-special" type="text" value="—" disabled aria-label={label} /> : input}
          <label className="check-inline">
            <input type="checkbox" checked={isSpecial} onChange={(e) => onChange(e.target.checked ? specialValue : fallback)} />
            {specialLabel}
          </label>
        </div>
      );
    }
    case 'boolean':
      return (
        <label className="toggle" htmlFor={id}>
          <input id={id} type="checkbox" role="switch" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
          <span className="toggle-track" aria-hidden="true">
            <span className="toggle-thumb" />
          </span>
          <span className="toggle-label">
            {label} <span className="muted">({value ? 'on' : 'off'})</span>
          </span>
        </label>
      );
    case 'array':
      if (prop.items?.type === 'object' && prop.items.properties) {
        return <ObjectArrayField id={id} prop={prop} itemProps={prop.items.properties} value={Array.isArray(value) ? (value as Record<string, unknown>[]) : []} onChange={onChange} />;
      }
      return <StringArrayField id={id} prop={prop} value={Array.isArray(value) ? value.map((x) => String(x ?? '')) : []} onChange={onChange} />;
    default:
      return <JsonField id={id} value={value} onChange={onChange} />;
  }
}

function MediaField({ id, value, onChange, upload }: { id: string; value: string; onChange: (v: unknown) => void; upload?: (file: File) => Promise<string> }) {
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  const url = resolveMedia(value);

  const onFile = async (file: File | undefined) => {
    if (!file || !upload) return;
    setUploading(true);
    setErr(null);
    try {
      onChange(await upload(file));
      setBroken(false);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="media-field">
      {value && url && (
        <div className="media-preview">
          {!broken ? <img src={url} alt="Uploaded media preview" onError={() => setBroken(true)} /> : <span className="mono small">{value}</span>}
        </div>
      )}
      <div className="row gap-sm wrap">
        <label className={`btn btn-secondary${!upload || uploading ? ' is-disabled' : ''}`}>
          {uploading ? 'Uploading…' : value ? 'Replace file' : 'Upload file'}
          <input
            id={id}
            type="file"
            accept="image/*,video/*,audio/*"
            className="sr-only"
            disabled={!upload || uploading}
            onChange={(e) => {
              void onFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </label>
        {value && (
          <button type="button" className="btn btn-danger btn-ghost" onClick={() => onChange(undefined)}>
            Remove
          </button>
        )}
      </div>
      {!upload && <p className="field-help">Uploads are available once the game exists.</p>}
      {err && (
        <p className="field-error" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}

function move<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}

function StringArrayField({ id, prop, value, onChange }: { id: string; prop: Prop; value: string[]; onChange: (v: unknown) => void }) {
  const max = prop.maxItems;
  const min = prop.minItems ?? 0;
  return (
    <div className="array-field">
      {value.map((item, i) => (
        <div className="array-row" key={i}>
          <span className="array-index" aria-hidden="true">
            {i < 26 ? String.fromCharCode(65 + i) : i + 1}
          </span>
          <input
            id={i === 0 ? id : undefined}
            className="input"
            type="text"
            aria-label={`${prop.title ?? 'Item'} ${i + 1}`}
            maxLength={prop.items?.maxLength}
            value={item}
            onChange={(e) => onChange(value.map((x, j) => (j === i ? e.target.value : x)))}
          />
          <RowButtons index={i} length={value.length} canRemove={value.length > min} onMove={(to) => onChange(move(value, i, to))} onRemove={() => onChange(value.filter((_, j) => j !== i))} />
        </div>
      ))}
      <button type="button" className="btn btn-secondary btn-sm" disabled={max !== undefined && value.length >= max} onClick={() => onChange([...value, ''])}>
        + Add {prop.items?.title ?? 'item'}
        {max !== undefined && (
          <span className="muted">
            {' '}
            ({value.length}/{max})
          </span>
        )}
      </button>
    </div>
  );
}

function ObjectArrayField({
  id,
  prop,
  itemProps,
  value,
  onChange,
}: {
  id: string;
  prop: Prop;
  itemProps: Record<string, Prop>;
  value: Record<string, unknown>[];
  onChange: (v: unknown) => void;
}) {
  const columns = Object.entries(itemProps);
  const max = prop.maxItems;
  const min = prop.minItems ?? 0;
  const setCell = (row: number, key: string, v: unknown) => onChange(value.map((r, i) => (i === row ? { ...r, [key]: v } : r)));
  return (
    <div className="array-field table-scroll">
      <table className="table table-edit">
        <thead>
          <tr>
            <th scope="col">#</th>
            {columns.map(([key, p]) => (
              <th scope="col" key={key}>
                {p.title ?? key}
              </th>
            ))}
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {value.map((row, i) => (
            <tr key={i}>
              <td className="mono">{i + 1}</td>
              {columns.map(([key, p], c) => (
                <td key={key}>
                  <CellInput id={i === 0 && c === 0 ? id : undefined} prop={p} label={`${p.title ?? key} ${i + 1}`} value={row[key]} onChange={(v) => setCell(i, key, v)} />
                </td>
              ))}
              <td>
                <RowButtons index={i} length={value.length} canRemove={value.length > min} onMove={(to) => onChange(move(value, i, to))} onRemove={() => onChange(value.filter((_, j) => j !== i))} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="btn btn-secondary btn-sm" disabled={max !== undefined && value.length >= max} onClick={() => onChange([...value, {}])}>
        + Add row
      </button>
    </div>
  );
}

function CellInput({ id, prop, label, value, onChange }: { id?: string; prop: Prop; label: string; value: unknown; onChange: (v: unknown) => void }) {
  if (prop.type === 'boolean') return <input id={id} type="checkbox" aria-label={label} checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />;
  if (prop.type === 'number' || prop.type === 'integer') {
    return (
      <input
        id={id}
        className="input input-sm"
        type="number"
        aria-label={label}
        min={prop.minimum}
        max={prop.maximum}
        step={prop.multipleOf ?? (prop.type === 'integer' ? 1 : 'any')}
        value={typeof value === 'number' || typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.valueAsNumber)}
      />
    );
  }
  if (prop.enum) {
    return (
      <select id={id} className="input input-sm" aria-label={label} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {prop.enum.map((o, i) => (
          <option key={o} value={o}>
            {prop.enumNames?.[i] ?? o}
          </option>
        ))}
      </select>
    );
  }
  return <input id={id} className="input input-sm" type="text" aria-label={label} maxLength={prop.maxLength} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />;
}

function RowButtons({ index, length, canRemove, onMove, onRemove }: { index: number; length: number; canRemove: boolean; onMove: (to: number) => void; onRemove: () => void }) {
  return (
    <span className="row-buttons">
      <button type="button" className="btn btn-icon" aria-label={`Move item ${index + 1} up`} disabled={index === 0} onClick={() => onMove(index - 1)}>
        ↑
      </button>
      <button type="button" className="btn btn-icon" aria-label={`Move item ${index + 1} down`} disabled={index === length - 1} onClick={() => onMove(index + 1)}>
        ↓
      </button>
      <button type="button" className="btn btn-icon btn-danger btn-ghost" aria-label={`Remove item ${index + 1}`} disabled={!canRemove} onClick={onRemove}>
        ✕
      </button>
    </span>
  );
}

/** Escape hatch for schema types the form generator does not model. */
function JsonField({ id, value, onChange }: { id: string; value: unknown; onChange: (v: unknown) => void }) {
  const [text, setText] = useState(() => (value === undefined ? '' : JSON.stringify(value, null, 2)));
  const [bad, setBad] = useState(false);
  return (
    <>
      <textarea
        id={id}
        className="input mono"
        rows={4}
        value={text}
        aria-invalid={bad || undefined}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value.trim() === '') {
            setBad(false);
            onChange(undefined);
            return;
          }
          try {
            onChange(JSON.parse(e.target.value));
            setBad(false);
          } catch {
            setBad(true);
          }
        }}
      />
      <p className="field-help">{bad ? 'Invalid JSON' : 'Edited as JSON'}</p>
    </>
  );
}
