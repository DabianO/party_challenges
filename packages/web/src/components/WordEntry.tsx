import { useRef, useState } from 'react';
import type { WordEntryNode } from '@challenge/contract';

/**
 * A box for entering one answer after another (`word-entry`): Enter or the button sends the
 * text as a live action, empties the box and keeps the keyboard open for the next one.
 */
export function WordEntry({ node, onAction }: { node: WordEntryNode; onAction?: (payload: Record<string, unknown>) => void }) {
  const enabled = typeof onAction === 'function';
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const send = () => {
    const value = text.trim();
    if (!enabled || !value) return;
    onAction({ [node.action]: value });
    setText('');
    input.current?.focus();
  };

  return (
    <div className="word-entry">
      <input
        ref={input}
        className="input input-lg"
        type="text"
        value={text}
        placeholder={node.placeholder ?? 'Type an answer'}
        maxLength={node.maxLength}
        disabled={!enabled}
        autoFocus
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        enterKeyHint="send"
        aria-label={node.placeholder ?? 'Your answer'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter adds the answer; it must not submit the challenge's form.
          if (e.key === 'Enter') {
            e.preventDefault();
            send();
          }
        }}
      />
      <button
        type="button"
        className="btn btn-primary"
        disabled={!enabled || !text.trim()}
        // Keep the focus (and the phone's keyboard) in the box.
        onMouseDown={(e) => e.preventDefault()}
        onClick={send}
      >
        {node.buttonLabel ?? 'Add'}
      </button>
    </div>
  );
}
