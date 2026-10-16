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
  | ButtonNode;

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
};
