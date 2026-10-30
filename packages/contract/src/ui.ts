/**
 * Declarative UI model.
 *
 * Modules never ship frontend code. Instead, their view functions return a tree of
 * UI nodes which the platform renders with themed, accessible components on every
 * surface (main display, guest, host). This answers spec §22 Q1 (MR-13) in favour of a
 * declarative UI schema: it keeps theming (FR-61), XSS safety (SR-9) and sandboxing
 * guarantees entirely inside the platform.
 */

export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'muted';

export type TextVariant = 'display' | 'title' | 'subtitle' | 'body' | 'caption' | 'mono';

export interface StackNode {
  type: 'stack';
  direction?: 'column' | 'row';
  gap?: 'none' | 'sm' | 'md' | 'lg';
  align?: 'start' | 'center' | 'end' | 'stretch';
  justify?: 'start' | 'center' | 'end' | 'between';
  wrap?: boolean;
  children: UINode[];
}

export interface GridNode {
  type: 'grid';
  columns: number;
  gap?: 'none' | 'sm' | 'md' | 'lg';
  children: UINode[];
}

export interface TextNode {
  type: 'text';
  text: string;
  variant?: TextVariant;
  tone?: Tone;
  align?: 'start' | 'center' | 'end';
}

export interface ImageNode {
  type: 'image';
  /** Media reference (`media://<id>`) or absolute URL. */
  src: string;
  alt?: string;
  /** Maximum height as CSS length, e.g. '40vh'. */
  maxHeight?: string;
  /** Blur/hide the image (used for reveal/hide phases). */
  hidden?: boolean;
}

export interface VideoNode {
  type: 'video';
  src: string;
  maxHeight?: string;
}

export interface AudioNode {
  type: 'audio';
  src: string;
}

export interface TimerNode {
  type: 'timer';
  /** Tag of the timer scheduled through InstanceContext.schedule(). */
  tag: string;
  label?: string;
  size?: 'sm' | 'lg';
}

export interface BadgeNode {
  type: 'badge';
  text: string;
  tone?: Tone;
}

export interface ProgressNode {
  type: 'progress';
  value: number;
  max: number;
  label?: string;
}

export interface ListItem {
  label: string;
  value?: string;
  tone?: Tone;
  highlight?: boolean;
}

export interface ListNode {
  type: 'list';
  items: ListItem[];
}

export interface BarChartNode {
  type: 'bar-chart';
  bars: { label: string; value: number; highlight?: boolean; tone?: Tone }[];
  /** Show value labels as percentages of the total. */
  percent?: boolean;
}

export interface RankingRow {
  rank: number;
  name: string;
  value?: string;
  points?: number;
  highlight?: boolean;
}

export interface RankingNode {
  type: 'ranking';
  rows: RankingRow[];
}

export interface DividerNode {
  type: 'divider';
}

export interface SpacerNode {
  type: 'spacer';
  size?: 'sm' | 'md' | 'lg';
}

/** Emphasised container, e.g. for a "GO!" screen or a highlighted answer. */
export interface CardNode {
  type: 'card';
  tone?: Tone;
  children: UINode[];
}

// ---------------------------------------------------------------------------
// Input nodes (guest & host forms). Each input has a `name` which becomes a key in
// the submitted payload object.
// ---------------------------------------------------------------------------

export interface ChoiceOption {
  id: string;
  label: string;
  /** Optional media shown with the option. */
  image?: string;
  tone?: Tone;
}

export interface ChoicesInputNode {
  type: 'choices';
  name: string;
  options: ChoiceOption[];
  multiple?: boolean;
  /** Pre-selected option id(s) (e.g. when resubmission is allowed). */
  value?: string | string[];
  /** Layout hint. */
  columns?: 1 | 2 | 3 | 4;
  /** If true, tapping an option submits immediately (single choice only). */
  submitOnSelect?: boolean;
  disabled?: boolean;
}

export interface NumberInputNode {
  type: 'number-input';
  name: string;
  label?: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  placeholder?: string;
  value?: number;
  disabled?: boolean;
}

export interface TextInputNode {
  type: 'text-input';
  name: string;
  label?: string;
  maxLength?: number;
  placeholder?: string;
  multiline?: boolean;
  value?: string;
  disabled?: boolean;
}

export interface SliderInputNode {
  type: 'slider';
  name: string;
  label?: string;
  min: number;
  max: number;
  step?: number;
  value?: number;
  disabled?: boolean;
}

export interface ToggleInputNode {
  type: 'toggle';
  name: string;
  label: string;
  value?: boolean;
  disabled?: boolean;
}

/**
 * Evidence upload (§14.6). The platform uploads the chosen file through the media
 * service and places the resulting `media://<id>` reference in the payload under `name`.
 */
export interface FileInputNode {
  type: 'file-input';
  name: string;
  label?: string;
  /** MIME accept list, e.g. 'image/*'. */
  accept?: string;
  /** Prefer the device camera on phones. */
  capture?: 'environment' | 'user';
  value?: string;
  disabled?: boolean;
}

/**
 * A button. `action: 'submit'` submits the collected form fields (merged with
 * `payload`, if given). This lets modules build a "TAP!" button that submits a
 * fixed payload with no other inputs.
 */
export interface ButtonNode {
  type: 'button';
  label: string;
  action: 'submit';
  payload?: Record<string, unknown>;
  tone?: Tone;
  size?: 'md' | 'lg' | 'huge';
  disabled?: boolean;
}

/**
 * A big tap target for rapid, repeated taps (e.g. pumping). Taps are counted on the device
 * and sent as live actions (`onAction`) in batches: payload `{ [action]: tapsSinceLastBatch }`.
 * Not a submission: nothing is evaluated per tap.
 */
export interface TapPadNode {
  type: 'tap-pad';
  /** Payload key the tap count is sent under. */
  action: string;
  label?: string;
  sublabel?: string;
  /** `#rrggbb`; anything else falls back to the accent colour. */
  color?: string;
  /** How often counted taps are sent, in ms (default 300). */
  batchMs?: number;
}

/**
 * A stopwatch timed on the player's device, so network delay plays no part in the result.
 * The player taps Start, then Stop; both moments come from the touch events themselves
 * (millisecond accuracy; browsers do not offer finer timing). Start sends the live action
 * `{ [name]: 'start' }` (the module may note its own server time to check the result);
 * Stop submits `{ [name]: elapsedMs }`, a whole number of milliseconds.
 */
export interface StopwatchNode {
  type: 'stopwatch';
  /** Payload key for the start action and the submitted time. */
  name: string;
  /** Hide the running time once this many seconds have passed (absent = always visible). */
  hideAfterSeconds?: number;
  startLabel?: string;
  stopLabel?: string;
}

/**
 * An answer the player can change at any time, without submitting: every change is sent at
 * once as the live action `{ [action]: { id, value } }` (the module's `onAction`). Shown as a
 * slider from `min` to `max`, or as one button per entry of `options`. `value: null` means
 * not answered yet; tapping the slider without moving it answers its current position.
 */
export interface LiveAnswerNode {
  type: 'live-answer';
  /** Payload key of the live action. */
  action: string;
  /** Which question this answers (sent back with every change). */
  id: string;
  value: number | null;
  min: number;
  max: number;
  step?: number;
  /** Shown after the number, e.g. "min" or "%". */
  unit?: string;
  /** Words under the slider at these values, e.g. both ends and the middle. */
  marks?: { value: number; label: string }[];
  /** One word per step from `min` to `max`, shown instead of the number (e.g. "Mostly agree"). */
  stepLabels?: string[];
  /** Where an unanswered slider starts (default: the middle). */
  start?: number;
  /** Buttons instead of a slider: one per value. */
  options?: { value: number; label: string; tone?: Tone }[];
}

/**
 * How a group answered on a scale: one column per value or range, as tall as its share of the
 * answers. For the big screen and results; never shows who answered what.
 */
export interface DistributionNode {
  type: 'distribution';
  /** In axis order. */
  columns: { label: string; count: number; tone?: Tone }[];
  /** Words under the axis: start, middle and end. */
  axis?: { start?: string; middle?: string; end?: string };
  /** A line across the chart at a position 0..1 along the axis, e.g. the average. */
  marker?: { at: number; label: string };
  /** Index of a column to emphasise, e.g. the viewer's own answer. */
  highlight?: number;
  /**
   * Many narrow columns (a histogram of ranges): no label under every column and only the
   * tallest column's share, so the axis words carry the scale and the chart stays calm.
   */
  compact?: boolean;
}

/** One player's territory in a `blob-field`. */
export interface BlobSpec {
  id: string;
  /** The owner code used in `BlobFieldNode.cells` (see `blobCells`). */
  slot: number;
  /** `#rrggbb`. */
  color: string;
  label?: string;
  /** Share of the field this blob holds (0..1). */
  share: number;
  /** Increases whenever the blob is pumped (animates a pulse). */
  pulse?: number;
}

/**
 * A field of liquid territories on a grid: every cell is empty or owned by one blob. The
 * platform renders it as embossed liquid shapes (`live`, animating between updates) or as a
 * gapless picture of who held which part of the field (`final`).
 */
export interface BlobFieldNode {
  type: 'blob-field';
  fieldId: string;
  mode: 'live' | 'final';
  cols: number;
  rows: number;
  /** Row-major, one character per cell: `blobCells.EMPTY` or `blobCells.encode(slot)`. */
  cells: string;
  blobs: BlobSpec[];
}

/** Encoding of `BlobFieldNode.cells`: compact ASCII for the first 78 slots, wider characters after. */
export const blobCells = {
  EMPTY: '.',
  encode(slot: number): string {
    return String.fromCharCode(slot < 78 ? 0x30 + slot : 0x100 + slot);
  },
  /** Slot of a cell character, or -1 for empty. */
  decode(ch: string): number {
    const c = ch.charCodeAt(0);
    if (ch === '.' || Number.isNaN(c)) return -1;
    return c >= 0x100 ? c - 0x100 : c - 0x30;
  },
};

export type UINode =
  | StackNode
  | GridNode
  | TextNode
  | ImageNode
  | VideoNode
  | AudioNode
  | TimerNode
  | BadgeNode
  | ProgressNode
  | ListNode
  | BarChartNode
  | RankingNode
  | DividerNode
  | SpacerNode
  | CardNode
  | ChoicesInputNode
  | NumberInputNode
  | TextInputNode
  | SliderInputNode
  | ToggleInputNode
  | FileInputNode
  | ButtonNode
  | TapPadNode
  | StopwatchNode
  | LiveAnswerNode
  | DistributionNode
  | BlobFieldNode;

export type InputNode = ChoicesInputNode | NumberInputNode | TextInputNode | SliderInputNode | ToggleInputNode | FileInputNode;

export function isInputNode(node: UINode): node is InputNode {
  return (
    node.type === 'choices' ||
    node.type === 'number-input' ||
    node.type === 'text-input' ||
    node.type === 'slider' ||
    node.type === 'toggle' ||
    node.type === 'file-input'
  );
}

/** Depth-first walk over a UI tree. */
export function walkUI(node: UINode, visit: (n: UINode) => void): void {
  visit(node);
  if ('children' in node) {
    for (const child of node.children) walkUI(child, visit);
  }
}

// ---------------------------------------------------------------------------
// Builder helpers – keep module code terse and readable.
// ---------------------------------------------------------------------------

export const ui = {
  stack: (children: UINode[], opts: Omit<StackNode, 'type' | 'children'> = {}): StackNode => ({
    type: 'stack',
    children,
    ...opts,
  }),
  row: (children: UINode[], opts: Omit<StackNode, 'type' | 'children' | 'direction'> = {}): StackNode => ({
    type: 'stack',
    direction: 'row',
    children,
    ...opts,
  }),
  grid: (columns: number, children: UINode[], opts: Omit<GridNode, 'type' | 'children' | 'columns'> = {}): GridNode => ({
    type: 'grid',
    columns,
    children,
    ...opts,
  }),
  text: (text: string, opts: Omit<TextNode, 'type' | 'text'> = {}): TextNode => ({ type: 'text', text, ...opts }),
  title: (text: string, opts: Omit<TextNode, 'type' | 'text' | 'variant'> = {}): TextNode => ({
    type: 'text',
    text,
    variant: 'title',
    ...opts,
  }),
  subtitle: (text: string, opts: Omit<TextNode, 'type' | 'text' | 'variant'> = {}): TextNode => ({
    type: 'text',
    text,
    variant: 'subtitle',
    ...opts,
  }),
  display: (text: string, opts: Omit<TextNode, 'type' | 'text' | 'variant'> = {}): TextNode => ({
    type: 'text',
    text,
    variant: 'display',
    align: 'center',
    ...opts,
  }),
  caption: (text: string, opts: Omit<TextNode, 'type' | 'text' | 'variant'> = {}): TextNode => ({
    type: 'text',
    text,
    variant: 'caption',
    tone: 'muted',
    ...opts,
  }),
  image: (src: string, opts: Omit<ImageNode, 'type' | 'src'> = {}): ImageNode => ({ type: 'image', src, ...opts }),
  video: (src: string, opts: Omit<VideoNode, 'type' | 'src'> = {}): VideoNode => ({ type: 'video', src, ...opts }),
  audio: (src: string): AudioNode => ({ type: 'audio', src }),
  timer: (tag: string, opts: Omit<TimerNode, 'type' | 'tag'> = {}): TimerNode => ({ type: 'timer', tag, ...opts }),
  badge: (text: string, tone: Tone = 'neutral'): BadgeNode => ({ type: 'badge', text, tone }),
  progress: (value: number, max: number, label?: string): ProgressNode => ({ type: 'progress', value, max, label }),
  list: (items: ListItem[]): ListNode => ({ type: 'list', items }),
  barChart: (bars: BarChartNode['bars'], opts: Omit<BarChartNode, 'type' | 'bars'> = {}): BarChartNode => ({
    type: 'bar-chart',
    bars,
    ...opts,
  }),
  ranking: (rows: RankingRow[]): RankingNode => ({ type: 'ranking', rows }),
  divider: (): DividerNode => ({ type: 'divider' }),
  spacer: (size: SpacerNode['size'] = 'md'): SpacerNode => ({ type: 'spacer', size }),
  card: (children: UINode[], tone: Tone = 'neutral'): CardNode => ({ type: 'card', children, tone }),
  choices: (
    name: string,
    options: ChoiceOption[],
    opts: Omit<ChoicesInputNode, 'type' | 'name' | 'options'> = {},
  ): ChoicesInputNode => ({
    type: 'choices',
    name,
    options,
    ...opts,
  }),
  numberInput: (name: string, opts: Omit<NumberInputNode, 'type' | 'name'> = {}): NumberInputNode => ({
    type: 'number-input',
    name,
    ...opts,
  }),
  textInput: (name: string, opts: Omit<TextInputNode, 'type' | 'name'> = {}): TextInputNode => ({
    type: 'text-input',
    name,
    ...opts,
  }),
  slider: (
    name: string,
    min: number,
    max: number,
    opts: Omit<SliderInputNode, 'type' | 'name' | 'min' | 'max'> = {},
  ): SliderInputNode => ({
    type: 'slider',
    name,
    min,
    max,
    ...opts,
  }),
  toggle: (name: string, label: string, opts: Omit<ToggleInputNode, 'type' | 'name' | 'label'> = {}): ToggleInputNode => ({
    type: 'toggle',
    name,
    label,
    ...opts,
  }),
  fileInput: (name: string, opts: Omit<FileInputNode, 'type' | 'name'> = {}): FileInputNode => ({ type: 'file-input', name, ...opts }),
  submit: (label: string, opts: Omit<ButtonNode, 'type' | 'label' | 'action'> = {}): ButtonNode => ({
    type: 'button',
    label,
    action: 'submit',
    ...opts,
  }),
  tapPad: (action: string, opts: Omit<TapPadNode, 'type' | 'action'> = {}): TapPadNode => ({ type: 'tap-pad', action, ...opts }),
  stopwatch: (name: string, opts: Omit<StopwatchNode, 'type' | 'name'> = {}): StopwatchNode => ({ type: 'stopwatch', name, ...opts }),
  liveAnswer: (action: string, id: string, value: number | null, opts: Omit<LiveAnswerNode, 'type' | 'action' | 'id' | 'value'>): LiveAnswerNode => ({
    type: 'live-answer',
    action,
    id,
    value,
    ...opts,
  }),
  distribution: (columns: DistributionNode['columns'], opts: Omit<DistributionNode, 'type' | 'columns'> = {}): DistributionNode => ({
    type: 'distribution',
    columns,
    ...opts,
  }),
  blobField: (fieldId: string, mode: BlobFieldNode['mode'], grid: { cols: number; rows: number; cells: string }, blobs: BlobSpec[]): BlobFieldNode => ({
    type: 'blob-field',
    fieldId,
    mode,
    ...grid,
    blobs,
  }),
};
