import { Fragment, useState } from 'react';
import type { SpoolNode } from '@challenge/contract';

/**
 * A sentence with everyone's entries rolling through its blanks. Every entry is in each blank
 * (all but one invisible), stacked in one grid cell: the blank is as wide as its longest entry,
 * so the sentence never moves. A new `index` drops the next entry in and the last one out;
 * going back rolls the other way.
 */
export function Spool({ node }: { node: SpoolNode }) {
  const count = node.entries.length;
  const index = count === 0 ? 0 : Math.min(Math.max(0, Math.round(node.index)), count - 1);
  const [shown, setShown] = useState(index);
  const [leaving, setLeaving] = useState<number | null>(null);
  const [back, setBack] = useState(false);
  if (index !== shown) {
    setLeaving(shown);
    setBack(index < shown);
    setShown(index);
  }
  const blanks = Math.max(0, node.parts.length - 1);
  const state = (j: number) => (j === shown ? ' is-in' : j === leaving ? ' is-out' : '');
  const hasBy = node.entries.some((e) => e.by);

  return (
    <div className={`spool${back ? ' is-back' : ''}`}>
      <p className="spool-sentence" aria-live="polite">
        {node.parts.map((part, i) => (
          <Fragment key={i}>
            {part}
            {i < blanks && (
              <span className="spool-blank">
                {count === 0 ? (
                  <span className="spool-word is-in">…</span>
                ) : (
                  node.entries.map((e, j) => (
                    <span key={j} className={`spool-word${state(j)}`} aria-hidden={j !== shown || undefined}>
                      {e.blanks[i]?.trim() || '…'}
                    </span>
                  ))
                )}
              </span>
            )}
          </Fragment>
        ))}
      </p>
      {hasBy && (
        <p className="spool-by">
          <span className="spool-blank spool-blank-plain">
            {node.entries.map((e, j) => (
              <span key={j} className={`spool-word${state(j)}`} aria-hidden={j !== shown || undefined}>
                {e.by ? `— ${e.by}` : ''}
              </span>
            ))}
          </span>
        </p>
      )}
      {count > 1 && (
        <p className="spool-count">
          {shown + 1} / {count}
        </p>
      )}
      {count === 0 && <span className="sr-only">No entries yet</span>}
    </div>
  );
}
