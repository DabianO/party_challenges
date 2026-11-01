import type { PresentationMove } from '@challenge/contract';

/** How long a step stays on screen while the presentation plays by itself, unless the slide says otherwise. */
export const PRESENTATION_STEP_SECONDS = 10;

/** One slide in the running order of the whole presentation. */
export interface DeckSlide {
  instanceId: string;
  /** Index within its challenge's slides. */
  slide: number;
  steps: number;
  stepSeconds: number;
}

/** Where the presentation is: a step of a slide. `index` is the slide's place in the running order when it was shown. */
export interface DeckPosition {
  instanceId: string;
  slide: number;
  step: number;
  index: number;
}

/**
 * The position on the current deck. Challenges can drop out (reopened or reset) or change
 * their number of slides while the presentation runs: stay on the same slide when it still
 * exists, otherwise on the slide that took its place in the running order.
 */
export function locate(deck: DeckSlide[], at: DeckPosition): DeckPosition | null {
  if (deck.length === 0) return null;
  let index = deck.findIndex((d) => d.instanceId === at.instanceId && d.slide === at.slide);
  let step = at.step;
  if (index < 0) {
    index = Math.min(Math.max(0, at.index), deck.length - 1);
    step = 0;
  }
  const d = deck[index]!;
  return { instanceId: d.instanceId, slide: d.slide, step: Math.min(Math.max(0, step), d.steps - 1), index };
}

/** The position after a move, or null when there is nowhere to go (the start or the end). */
export function move(deck: DeckSlide[], at: DeckPosition, to: PresentationMove): DeckPosition | null {
  const go = (index: number, step = 0): DeckPosition | null => {
    const d = deck[index];
    return d ? { instanceId: d.instanceId, slide: d.slide, step, index } : null;
  };
  const current = deck[at.index]!;
  if (typeof to === 'object') {
    const index = deck.findIndex((d) => d.instanceId === to.instanceId && d.slide === (to.slide ?? 0));
    return index < 0 ? null : go(index);
  }
  switch (to) {
    case 'next':
      return at.step + 1 < current.steps ? go(at.index, at.step + 1) : go(at.index + 1);
    case 'previous':
      return at.step > 0 ? go(at.index, at.step - 1) : go(at.index - 1);
    case 'next-slide':
      return go(at.index + 1);
    case 'previous-slide':
      // Back to the start of this slide first, like a music player.
      return at.step > 0 ? go(at.index) : go(at.index - 1);
  }
}
