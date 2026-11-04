import { createContext, useCallback, useContext, useEffect, useMemo, useState, type FormEvent } from 'react';
import type {
  AudioNode,
  BadgeNode,
  BarChartNode,
  ButtonNode,
  CardNode,
  ChoicesInputNode,
  FileInputNode,
  GridNode,
  ImageNode,
  InputNode,
  ListNode,
  NumberInputNode,
  ProgressNode,
  RankingNode,
  SliderInputNode,
  StackNode,
  TapPadNode,
  StopwatchNode,
  LiveAnswerNode,
  PairMatchNode,
  WordEntryNode,
  DPadNode,
  QuickRoundsNode,
  TextInputNode,
  TextNode,
  TimerInfo,
  TimerNode,
  ToggleInputNode,
  Tone,
  UINode,
  VideoNode,
} from '@challenge/contract';
import { isInputNode, walkUI } from '@challenge/contract';
import { resolveMedia } from '../lib/media';
import { readDraft, saveDraft } from '../lib/storage';
import { formatPoints } from '../lib/time';
import { BlobField } from './blobs/BlobField';
import { Countdown } from './Countdown';
import { TapPad } from './TapPad';
import { Stopwatch } from './Stopwatch';
import { LiveAnswer } from './LiveAnswer';
import { Distribution } from './Distribution';
import { QuickRounds } from './QuickRounds';
import { Spool } from './Spool';
import { PairMatch } from './PairMatch';
import { WordEntry } from './WordEntry';
import { DPad } from './DPad';
import { AimField } from './AimField';

/** Uploads a guest evidence file (FR-57) and resolves to its `media://` reference. */
export type EvidenceUploader = (file: File) => Promise<{ ref: string; url?: string }>;

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

type Payload = Record<string, unknown>;

interface FormCtx {
  values: Record<string, unknown>;
  setValue(name: string, value: unknown): void;
  /** False on read-only surfaces (main display, host preview). */
  interactive: boolean;
  disabled: boolean;
  submitting: boolean;
  submit(extra?: Payload, override?: Payload, final?: boolean): void;
  /** Present on guest surfaces that may upload evidence for `file-input` nodes. */
  uploadEvidence?: EvidenceUploader;
  /** Present where live actions may be sent (`tap-pad`, `stopwatch` start). */
  action?: (payload: Payload) => void;
}

const FormContext = createContext<FormCtx>({
  values: {},
  setValue: () => undefined,
  interactive: false,
  disabled: true,
  submitting: false,
  submit: () => undefined,
});

interface TimerCtx {
  timers: TimerInfo[];
  clockOffset: number;
  paused: boolean;
}

const TimerContext = createContext<TimerCtx>({ timers: [], clockOffset: 0, paused: false });

const NO_TIMERS: TimerInfo[] = [];

// ---------------------------------------------------------------------------
// Form state helpers
// ---------------------------------------------------------------------------

function collectInputs(node: UINode | null | undefined): InputNode[] {
  const inputs: InputNode[] = [];
  if (node) walkUI(node, (n) => (isInputNode(n) ? inputs.push(n) : undefined));
  return inputs;
}

function serverValuesOf(inputs: InputNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const input of inputs) if (input.value !== undefined) out[input.name] = input.value;
  return out;
}

/** Converts raw field state into the typed payload modules expect. */
function buildPayload(inputs: InputNode[], values: Record<string, unknown>): Payload {
  const payload: Payload = {};
  for (const input of inputs) {
    const v = values[input.name];
    switch (input.type) {
      case 'choices':
        if (input.multiple) payload[input.name] = Array.isArray(v) ? v.map(String) : [];
        else if (typeof v === 'string') payload[input.name] = v;
        break;
      case 'number-input': {
        if (v === undefined || v === null || v === '') break;
        const n = typeof v === 'number' ? v : Number(v);
        if (Number.isFinite(n)) payload[input.name] = n;
        break;
      }
      case 'slider': {
        const n = typeof v === 'number' ? v : Number(v);
        payload[input.name] = Number.isFinite(n) ? n : input.min;
        break;
      }
      case 'toggle':
        payload[input.name] = Boolean(v);
        break;
      case 'text-input':
        payload[input.name] = typeof v === 'string' ? v : '';
        break;
      case 'file-input':
        if (typeof v === 'string' && v) payload[input.name] = v;
        break;
    }
  }
  return payload;
}

/** True when the tree already contains a submit button (so callers know whether to add one). */
export function hasSubmitButton(node: UINode | null | undefined): boolean {
  let found = false;
  if (node) {
    walkUI(node, (n) => {
      if (n.type === 'button') found = true;
    });
  }
  return found;
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export interface UIViewProps {
  node: UINode | null | undefined;
  /** When given, inputs and buttons are live and submit through this callback (`final: false` keeps the attempt open). */
  onSubmit?: (payload: Payload, opts: { final: boolean }) => void | Promise<unknown>;
  disabled?: boolean;
  timers?: TimerInfo[];
  clockOffset?: number;
  paused?: boolean;
  className?: string;
  /** Enables `file-input` nodes (guest evidence uploads). */
  uploadEvidence?: EvidenceUploader;
  /** Enables `tap-pad` nodes and `stopwatch` start signals: live actions for the module's `onAction` (not submissions). */
  onAction?: (payload: Payload) => void;
  /**
   * Keeps what the player filled in (text, an uploaded photo) for this browser tab under this
   * key, so a page reload does not lose it. Use one key per attempt.
   */
  draftKey?: string;
}

/**
 * Renders a module UI tree. Give it a `key` that changes per challenge instance so
 * form state resets between challenges.
 */
export function UIView({ node, onSubmit, disabled = false, timers = NO_TIMERS, clockOffset = 0, paused = false, className, uploadEvidence, onAction, draftKey }: UIViewProps) {
  const inputs = useMemo(() => collectInputs(node), [node]);
  const serverValues = useMemo(() => serverValuesOf(inputs), [inputs]);
  const [edits, setEdits] = useState<Record<string, unknown>>(() => (draftKey ? readDraft(draftKey) : {}));
  useEffect(() => {
    if (draftKey) saveDraft(draftKey, edits);
  }, [draftKey, edits]);
  const [submitting, setSubmitting] = useState(false);
  const values = useMemo(() => ({ ...serverValues, ...edits }), [serverValues, edits]);
  const interactive = typeof onSubmit === 'function';

  const setValue = useCallback((name: string, value: unknown) => setEdits((e) => ({ ...e, [name]: value })), []);

  const submit = useCallback(
    (extra?: Payload, override?: Payload, final = true) => {
      if (!onSubmit || disabled || submitting) return;
      const payload = { ...buildPayload(inputs, { ...values, ...override }), ...extra };
      const result = onSubmit(payload, { final });
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        setSubmitting(true);
        void (result as Promise<unknown>).finally(() => setSubmitting(false));
      }
    },
    [onSubmit, disabled, submitting, inputs, values],
  );

  const formCtx = useMemo<FormCtx>(
    () => ({ values, setValue, interactive, disabled: disabled || !interactive, submitting, submit, uploadEvidence, action: paused ? undefined : onAction }),
    [values, setValue, interactive, disabled, submitting, submit, uploadEvidence, paused, onAction],
  );
  const timerCtx = useMemo<TimerCtx>(() => ({ timers, clockOffset, paused }), [timers, clockOffset, paused]);

  if (!node) return null;

  // Enter in a text box: what the screen's first button does (e.g. Save rather than lock in).
  const onFormSubmit = (e: FormEvent) => {
    e.preventDefault();
    const first = firstButton(node);
    submit(first?.payload, undefined, first?.final !== false);
  };

  const body = <Node node={node} />;
  return (
    <TimerContext.Provider value={timerCtx}>
      <FormContext.Provider value={formCtx}>
        {interactive ? (
          <form className={`ui-root${className ? ` ${className}` : ''}`} onSubmit={onFormSubmit} noValidate>
            {body}
          </form>
        ) : (
          <div className={`ui-root ui-readonly${className ? ` ${className}` : ''}`}>{body}</div>
        )}
      </FormContext.Provider>
    </TimerContext.Provider>
  );
}

function TapPadNodeView({ node }: { node: TapPadNode }) {
  const form = useContext(FormContext);
  return <TapPad node={node} onAction={form.action} />;
}

function LiveAnswerNodeView({ node }: { node: LiveAnswerNode }) {
  const form = useContext(FormContext);
  return <LiveAnswer node={node} onAction={form.interactive ? form.action : undefined} />;
}

function PairMatchNodeView({ node }: { node: PairMatchNode }) {
  const form = useContext(FormContext);
  return <PairMatch node={node} onAction={form.interactive ? form.action : undefined} />;
}

function WordEntryNodeView({ node }: { node: WordEntryNode }) {
  const form = useContext(FormContext);
  return <WordEntry node={node} onAction={form.interactive ? form.action : undefined} />;
}

function DPadNodeView({ node }: { node: DPadNode }) {
  const form = useContext(FormContext);
  return <DPad node={node} onAction={form.interactive ? form.action : undefined} />;
}

function StopwatchNodeView({ node }: { node: StopwatchNode }) {
  const form = useContext(FormContext);
  return <Stopwatch node={node} enabled={form.interactive && !form.disabled} submitting={form.submitting} onStart={form.action} onStop={(payload) => form.submit(payload)} />;
}

function QuickRoundsNodeView({ node }: { node: QuickRoundsNode }) {
  const form = useContext(FormContext);
  return <QuickRounds node={node} enabled={form.interactive && !form.disabled} submitting={form.submitting} onStart={form.action} onDone={(payload) => form.submit(payload)} />;
}

// ---------------------------------------------------------------------------
// Node dispatcher
// ---------------------------------------------------------------------------

function Node({ node }: { node: UINode }) {
  switch (node.type) {
    case 'stack':
      return <Stack node={node} />;
    case 'grid':
      return <Grid node={node} />;
    case 'text':
      return <Text node={node} />;
    case 'image':
      return <Image node={node} />;
    case 'video':
      return <Video node={node} />;
    case 'audio':
      return <Audio node={node} />;
    case 'timer':
      return <Timer node={node} />;
    case 'badge':
      return <Badge node={node} />;
    case 'progress':
      return <Progress node={node} />;
    case 'list':
      return <List node={node} />;
    case 'bar-chart':
      return <BarChart node={node} />;
    case 'ranking':
      return <Ranking node={node} />;
    case 'divider':
      return <hr className="divider" />;
    case 'spacer':
      return <div className={`spacer spacer-${node.size ?? 'md'}`} aria-hidden="true" />;
    case 'card':
      return <Card node={node} />;
    case 'choices':
      return <Choices node={node} />;
    case 'number-input':
      return <NumberInput node={node} />;
    case 'text-input':
      return <TextInput node={node} />;
    case 'slider':
      return <Slider node={node} />;
    case 'toggle':
      return <Toggle node={node} />;
    case 'file-input':
      return <FileInput node={node} />;
    case 'button':
      return <Button node={node} />;
    case 'tap-pad':
      return <TapPadNodeView node={node} />;
    case 'stopwatch':
      return <StopwatchNodeView node={node} />;
    case 'live-answer':
      return <LiveAnswerNodeView node={node} />;
    case 'distribution':
      return <Distribution node={node} />;
    case 'blob-field':
      // Keyed by mode: the closing picture starts fresh instead of animating out of the live field.
      return <BlobField key={node.mode} node={node} />;
    case 'quick-rounds':
      return <QuickRoundsNodeView node={node} />;
    case 'spool':
      // Another sentence starts afresh; new entries of the same sentence roll in.
      return <Spool key={node.parts.join('\u0000')} node={node} />;
    case 'pair-match':
      return <PairMatchNodeView node={node} />;
    case 'word-entry':
      return <WordEntryNodeView node={node} />;
    case 'd-pad':
      return <DPadNodeView node={node} />;
    case 'aim-field':
      return <AimField node={node} />;
    default: {
      // The server knows content this page does not: the page is older than the server
      // (opened before an update, or kept asleep in a phone's background). Reloading fixes it.
      const type = (node as { type?: unknown }).type;
      return (
        <span className="ui-outdated" role="alert">
          <span>This screen needs the latest version of the app.</span>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => window.location.reload()}>
            ↻ Reload
          </button>
          {typeof type === 'string' && <span className="muted small">Unknown content: {type}</span>}
        </span>
      );
    }
  }
}

function Children({ nodes }: { nodes: UINode[] }) {
  return (
    <>
      {nodes.map((child, i) => (
        <Node key={i} node={child} />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function Stack({ node }: { node: StackNode }) {
  const cls = [
    'ui-stack',
    `dir-${node.direction ?? 'column'}`,
    `gap-${node.gap ?? 'md'}`,
    `align-${node.align ?? 'stretch'}`,
    `justify-${node.justify ?? 'start'}`,
    node.wrap ? 'wrap' : '',
  ].join(' ');
  return (
    <div className={cls}>
      <Children nodes={node.children} />
    </div>
  );
}

function Grid({ node }: { node: GridNode }) {
  const columns = Math.max(1, Math.min(6, Math.floor(node.columns) || 1));
  return (
    <div className={`ui-grid gap-${node.gap ?? 'md'}`} style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      <Children nodes={node.children} />
    </div>
  );
}

function Card({ node }: { node: CardNode }) {
  return (
    <section className={`card tone-${node.tone ?? 'neutral'}`}>
      <div className="ui-stack dir-column gap-md align-stretch justify-start">
        <Children nodes={node.children} />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

function Text({ node }: { node: TextNode }) {
  const variant = node.variant ?? 'body';
  const cls = `ui-text ui-text-${variant} tone-${node.tone ?? 'neutral'} align-${node.align ?? 'start'}`;
  switch (variant) {
    case 'display':
      return <div className={cls}>{node.text}</div>;
    case 'title':
      return <h2 className={cls}>{node.text}</h2>;
    case 'subtitle':
      return <h3 className={cls}>{node.text}</h3>;
    case 'mono':
      return (
        <pre className={cls}>
          <code>{node.text}</code>
        </pre>
      );
    default:
      return <p className={cls}>{node.text}</p>;
  }
}

function Image({ node }: { node: ImageNode }) {
  const src = resolveMedia(node.src);
  const hidden = node.hidden === true;
  return (
    <figure className={`ui-image${hidden ? ' is-hidden' : ''}`} style={node.maxHeight ? { maxHeight: node.maxHeight } : undefined}>
      <img
        src={src}
        alt={hidden ? 'Hidden image' : node.alt ?? ''}
        style={node.maxHeight ? { maxHeight: node.maxHeight } : undefined}
        draggable={false}
        onContextMenu={hidden ? (e) => e.preventDefault() : undefined}
      />
      {hidden && (
        <figcaption className="ui-image-veil">
          <span className="ui-image-veil-icon" aria-hidden="true">
            ◌
          </span>
          <span>Hidden</span>
        </figcaption>
      )}
    </figure>
  );
}

function Video({ node }: { node: VideoNode }) {
  const src = resolveMedia(node.src);
  const style = node.maxHeight ? { maxHeight: node.maxHeight } : undefined;
  return (
    <figure className="ui-video" style={style}>
      <video src={src} controls playsInline preload="metadata" style={style}>
        Your browser cannot play this video.
      </video>
    </figure>
  );
}

function Audio({ node }: { node: AudioNode }) {
  const src = resolveMedia(node.src);
  return (
    <figure className="ui-audio">
      <audio src={src} controls preload="metadata">
        Your browser cannot play this audio.
      </audio>
    </figure>
  );
}

function Timer({ node }: { node: TimerNode }) {
  const { timers, clockOffset, paused } = useContext(TimerContext);
  const timer = timers.find((t) => t.tag === node.tag);
  if (!timer) return null;
  return (
    <Countdown endsAt={timer.endsAt} startedAt={timer.startedAt} clockOffset={clockOffset} paused={paused} size={node.size ?? 'sm'} label={node.label} />
  );
}

function Badge({ node }: { node: BadgeNode }) {
  return <span className={`badge tone-${node.tone ?? 'neutral'}`}>{node.text}</span>;
}

function Progress({ node }: { node: ProgressNode }) {
  const max = node.max > 0 ? node.max : 1;
  const value = Math.min(max, Math.max(0, node.value));
  return (
    <div className="ui-progress">
      <div className="ui-progress-head">
        <span>{node.label}</span>
        <span className="mono">
          {formatPoints(node.value)} / {formatPoints(node.max)}
        </span>
      </div>
      <div className="progress-track" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} aria-label={node.label ?? 'Progress'}>
        <div className="progress-fill" style={{ width: `${(value / max) * 100}%` }} />
      </div>
    </div>
  );
}

function List({ node }: { node: ListNode }) {
  return (
    <ul className="ui-list">
      {node.items.map((item, i) => (
        <li key={i} className={`ui-list-item tone-${item.tone ?? 'neutral'}${item.highlight ? ' is-highlight' : ''}`}>
          <span className="ui-list-label">
            {item.highlight && (
              <span className="mark" aria-label="highlighted">
                ★{' '}
              </span>
            )}
            {item.label}
          </span>
          {item.value !== undefined && <span className="ui-list-value">{item.value}</span>}
        </li>
      ))}
    </ul>
  );
}

function BarChart({ node }: { node: BarChartNode }) {
  const values = node.bars.map((b) => Math.max(0, b.value));
  const total = values.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...values);
  return (
    <div className="ui-bars" role="table" aria-label="Bar chart">
      {node.bars.map((bar, i) => {
        const v = Math.max(0, bar.value);
        const label = node.percent ? `${total > 0 ? Math.round((v / total) * 100) : 0}%` : formatPoints(v);
        return (
          <div key={i} className={`ui-bar tone-${bar.tone ?? 'neutral'}${bar.highlight ? ' is-highlight' : ''}`} role="row">
            <span className="ui-bar-label" role="cell">
              {bar.highlight && (
                <span className="mark" aria-label="correct">
                  ✓{' '}
                </span>
              )}
              {bar.label}
            </span>
            <span className="ui-bar-track" role="cell" aria-label={`${bar.label}: ${label}`}>
              <span className="ui-bar-fill" style={{ width: `${(v / max) * 100}%` }} />
            </span>
            <span className="ui-bar-value mono" role="cell">
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Ranking({ node }: { node: RankingNode }) {
  return (
    <ol className="ui-ranking">
      {node.rows.map((row, i) => (
        <li key={i} className={`ui-ranking-row ${row.rank >= 1 && row.rank <= 3 ? `rank-${row.rank}` : 'rank-n'}${row.highlight ? ' is-highlight' : ''}`}>
          <span className="lb-rank" aria-label={`Rank ${row.rank}`}>
            {row.rank}
          </span>
          <span className="ui-ranking-name">
            {row.name}
            {row.highlight && (
              <span className="mark" aria-label="highlighted">
                {' '}
                ★
              </span>
            )}
          </span>
          {row.value !== undefined && <span className="ui-ranking-value">{row.value}</span>}
          {row.points !== undefined && (
            <span className="ui-ranking-points">
              {row.points > 0 ? '+' : ''}
              {formatPoints(row.points)} <small>pts</small>
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

function letterFor(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

function Choices({ node }: { node: ChoicesInputNode }) {
  const form = useContext(FormContext);
  const raw = form.values[node.name];
  const selected = new Set<string>(
    node.multiple ? (Array.isArray(raw) ? raw.map(String) : []) : typeof raw === 'string' ? [raw] : [],
  );
  const disabled = node.disabled === true || form.disabled || form.submitting;
  const columns = node.columns ?? (node.options.length > 4 ? 2 : 1);

  const pick = (id: string) => {
    if (disabled) return;
    if (node.multiple) {
      const next = selected.has(id) ? [...selected].filter((x) => x !== id) : [...selected, id];
      form.setValue(node.name, next);
      return;
    }
    form.setValue(node.name, id);
    if (node.submitOnSelect) form.submit(undefined, { [node.name]: id });
  };

  return (
    <div
      className="ui-choices"
      role={node.multiple ? 'group' : 'radiogroup'}
      aria-label={node.name}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {node.options.map((opt, i) => {
        const isSelected = selected.has(opt.id);
        return (
          <button
            key={opt.id}
            type="button"
            role={node.multiple ? 'checkbox' : 'radio'}
            aria-checked={isSelected}
            className={`choice tone-${opt.tone ?? 'neutral'}${isSelected ? ' is-selected' : ''}`}
            disabled={disabled}
            onClick={() => pick(opt.id)}
          >
            <span className="choice-letter" aria-hidden="true">
              {letterFor(i)}
            </span>
            {opt.image && <img className="choice-image" src={resolveMedia(opt.image)} alt="" draggable={false} />}
            <span className="choice-label">{opt.label}</span>
            <span className="choice-check" aria-hidden="true">
              {isSelected ? '✓' : ''}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function NumberInput({ node }: { node: NumberInputNode }) {
  const form = useContext(FormContext);
  const raw = form.values[node.name];
  const display = raw === undefined || raw === null ? '' : String(raw);
  const disabled = node.disabled === true || form.disabled || form.submitting;
  return (
    <label className="field">
      {node.label && <span className="field-label">{node.label}</span>}
      <span className="field-row">
        <input
          className="input input-lg"
          type="number"
          inputMode="decimal"
          name={node.name}
          min={node.min}
          max={node.max}
          step={node.step ?? 'any'}
          placeholder={node.placeholder}
          value={display}
          disabled={disabled}
          onChange={(e) => form.setValue(node.name, e.target.value)}
        />
        {node.unit && <span className="field-unit">{node.unit}</span>}
      </span>
    </label>
  );
}

function TextInput({ node }: { node: TextInputNode }) {
  const form = useContext(FormContext);
  const raw = form.values[node.name];
  const value = typeof raw === 'string' ? raw : '';
  const disabled = node.disabled === true || form.disabled || form.submitting;
  const common = {
    name: node.name,
    maxLength: node.maxLength,
    placeholder: node.placeholder,
    value,
    disabled,
    onChange: (e: { target: { value: string } }) => form.setValue(node.name, e.target.value),
  };
  return (
    <label className="field">
      {node.label && <span className="field-label">{node.label}</span>}
      {node.multiline ? <textarea className="input" rows={3} {...common} /> : <input className="input input-lg" type="text" autoComplete="off" {...common} />}
      {node.maxLength !== undefined && (
        <span className="field-help mono">
          {value.length}/{node.maxLength}
        </span>
      )}
    </label>
  );
}

function Slider({ node }: { node: SliderInputNode }) {
  const form = useContext(FormContext);
  const raw = form.values[node.name];
  const n = typeof raw === 'number' ? raw : Number(raw);
  const value = Number.isFinite(n) ? n : node.min;
  const disabled = node.disabled === true || form.disabled || form.submitting;
  return (
    <label className="field">
      <span className="field-label field-label-row">
        <span>{node.label}</span>
        <output className="mono">{value}</output>
      </span>
      <input
        className="range"
        type="range"
        name={node.name}
        min={node.min}
        max={node.max}
        step={node.step ?? 1}
        value={value}
        disabled={disabled}
        onChange={(e) => form.setValue(node.name, Number(e.target.value))}
      />
      <span className="field-help field-label-row">
        <span>{node.min}</span>
        <span>{node.max}</span>
      </span>
    </label>
  );
}

function Toggle({ node }: { node: ToggleInputNode }) {
  const form = useContext(FormContext);
  const checked = Boolean(form.values[node.name]);
  const disabled = node.disabled === true || form.disabled || form.submitting;
  return (
    <label className="toggle">
      <input type="checkbox" role="switch" name={node.name} checked={checked} disabled={disabled} onChange={(e) => form.setValue(node.name, e.target.checked)} />
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-thumb" />
      </span>
      <span className="toggle-label">
        {node.label} <span className="muted">({checked ? 'on' : 'off'})</span>
      </span>
    </label>
  );
}

type FileKind = 'image' | 'video' | 'audio' | 'file';

function fileKind(accept: string | undefined): FileKind {
  if (!accept) return 'file';
  if (accept.startsWith('image')) return 'image';
  if (accept.startsWith('video')) return 'video';
  if (accept.startsWith('audio')) return 'audio';
  return 'file';
}

const FILE_ICON: Record<FileKind, string> = { image: '📷', video: '🎬', audio: '🎙', file: '📎' };

function fileButtonText(kind: FileKind, hasValue: boolean, capture: FileInputNode['capture']): string {
  if (hasValue) return `Replace ${kind === 'file' ? 'file' : kind}`;
  if (capture) return kind === 'video' ? 'Record a video' : kind === 'audio' ? 'Record audio' : 'Take a photo';
  return kind === 'file' ? 'Choose a file' : `Choose ${kind === 'audio' ? 'an' : 'a'} ${kind}`;
}

/**
 * Evidence upload (§14.6): the chosen file goes to the media service right away and the
 * resulting `media://` ref becomes the field value, so submitting stays a plain payload.
 */
function FileInput({ node }: { node: FileInputNode }) {
  const form = useContext(FormContext);
  const raw = form.values[node.name];
  const value = typeof raw === 'string' ? raw : '';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const kind = fileKind(node.accept);
  const canUpload = typeof form.uploadEvidence === 'function';
  const disabled = node.disabled === true || form.disabled || form.submitting || busy || !canUpload;
  const inputId = `file-${node.name}`;
  const url = value ? resolveMedia(value) : undefined;

  const onFile = async (file: File | undefined) => {
    if (!file || !form.uploadEvidence) return;
    setBusy(true);
    setError(null);
    setFileName(file.name || null);
    try {
      const res = await form.uploadEvidence(file);
      form.setValue(node.name, res.ref);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`file-input${value ? ' has-value' : ''}`}>
      {node.label && <span className="field-label">{node.label}</span>}
      {url && (
        <div className="file-preview">
          {kind === 'image' && <img src={url} alt={fileName ? `Uploaded: ${fileName}` : 'Uploaded image'} />}
          {kind === 'video' && <video src={url} controls playsInline preload="metadata" />}
          {kind === 'audio' && <audio src={url} controls preload="metadata" />}
          {kind === 'file' && <span className="mono small">{fileName ?? value}</span>}
          <span className="file-preview-ok" role="status">
            <span aria-hidden="true">✓</span> Uploaded
          </span>
        </div>
      )}
      <label className={`file-drop${disabled ? ' is-disabled' : ''}`} htmlFor={inputId}>
        <span className="file-drop-icon" aria-hidden="true">
          {busy ? '⟳' : FILE_ICON[kind]}
        </span>
        <span className="file-drop-text">{busy ? 'Uploading…' : fileButtonText(kind, Boolean(value), node.capture)}</span>
        <input
          id={inputId}
          className="sr-only"
          type="file"
          name={node.name}
          accept={node.accept}
          capture={node.capture}
          disabled={disabled}
          aria-describedby={error ? `${inputId}-error` : undefined}
          onChange={(e) => {
            void onFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </label>
      {!canUpload && form.interactive && <p className="field-help">Uploads are not available on this screen.</p>}
      {busy && (
        <div className="progress-track" role="progressbar" aria-label="Uploading" aria-busy="true">
          <div className="progress-fill progress-indeterminate" />
        </div>
      )}
      {error && (
        <p className="field-error" role="alert" id={`${inputId}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

const BUTTON_TONE: Record<Tone, string> = {
  neutral: 'btn-primary',
  primary: 'btn-primary',
  success: 'btn-success',
  warning: 'btn-warning',
  danger: 'btn-danger',
  muted: 'btn-secondary',
};

function firstButton(node: UINode): ButtonNode | undefined {
  let found: ButtonNode | undefined;
  walkUI(node, (n) => {
    if (!found && n.type === 'button') found = n;
  });
  return found;
}

function Button({ node }: { node: ButtonNode }) {
  const form = useContext(FormContext);
  const disabled = node.disabled === true || form.disabled || form.submitting;
  return (
    <button
      type="button"
      className={`btn ${BUTTON_TONE[node.tone ?? 'primary']} btn-${node.size ?? 'md'}`}
      disabled={disabled}
      aria-busy={form.submitting || undefined}
      onClick={() => form.submit(node.payload, undefined, node.final !== false)}
    >
      {form.submitting ? 'Sending…' : node.label}
    </button>
  );
}
