import { useCallback, useState } from 'react';
import type { AttemptStatus, BoardEntry } from '@challenge/contract';
import { Countdown } from '../../components/Countdown';
import { useToast } from '../../components/Toast';
import { formatPoints } from '../../lib/time';
import type { PlayCtx } from '../Play';

const ORDER: Record<AttemptStatus, number> = {
  in_progress: 0,
  available: 1,
  waiting: 1.8,
  submitted: 2,
  scored: 3,
  closed: 4,
  missed: 5,
  locked: 6,
};

export function sortBoard(board: BoardEntry[]): BoardEntry[] {
  // Playable first (a replayable tile counts as playable), the board order otherwise.
  const rank = (b: BoardEntry) => (b.canReplay && ORDER[b.status] > 1 ? 1.5 : ORDER[b.status]);
  return [...board].sort((a, b) => rank(a) - rank(b));
}

export interface BoardGroup {
  /** '' when the host gave no category. */
  category: string;
  entries: BoardEntry[];
}

/**
 * Challenges grouped by the host's category, in board order (a category sits where its first
 * challenge is). Challenges without a category come last. Inside a group, playable ones first.
 */
export function groupBoard(board: BoardEntry[]): BoardGroup[] {
  const groups = new Map<string, BoardEntry[]>();
  for (const entry of board) {
    const key = entry.category ?? '';
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? 1 : 0) - (b === '' ? 1 : 0))
    .map(([category, entries]) => ({ category, entries: sortBoard(entries) }));
}

/** The player's own `lock` timer for an attempt, if any. */
export function lockTimer(entry: BoardEntry, meId: string) {
  return entry.timers.find((t) => t.tag === 'lock' && t.playerId === meId);
}

/** Start (or replay) a challenge and open it once the server has started the attempt. */
export function useStartChallenge(ctx: PlayCtx) {
  const toast = useToast();
  const [starting, setStarting] = useState<string | null>(null);
  const { sock, openChallenge } = ctx;
  const start = useCallback(
    async (instanceId: string) => {
      setStarting(instanceId);
      const res = await sock.start(instanceId);
      setStarting(null);
      // The server sends the new snapshot before its ACK, so the attempt is already live here.
      if (res.ok) openChallenge(instanceId);
      else toast(res.reason ?? 'Could not start', 'danger');
    },
    [sock, openChallenge, toast],
  );
  return { starting, start };
}

export function BoardScreen({ ctx }: { ctx: PlayCtx }) {
  const { board, game } = ctx.snapshot;
  const { starting, start } = useStartChallenge(ctx);
  // Where the player is needed right now (e.g. their turn) goes above everything else.
  const urgent = board.filter((b) => b.urgent);
  const groups = groupBoard(board.filter((b) => !b.urgent));
  // Headings only once the host has used categories.
  const headed = groups.some((g) => g.category !== '');
  const doneIn = (entries: BoardEntry[]) => entries.filter((b) => b.attempts > 0 && b.status !== 'in_progress').length;
  const tiles = (entries: BoardEntry[]) => (
    <ul className="plain-list tiles">
      {entries.map((entry) => (
        <Tile
          key={entry.instanceId}
          entry={entry}
          ctx={ctx}
          revealed={game.resultsRevealed}
          paused={game.paused}
          starting={starting === entry.instanceId}
          busy={starting !== null}
          onStart={() => void start(entry.instanceId)}
        />
      ))}
    </ul>
  );

  return (
    <section className="stack gap-md">
      <div className="row align-center justify-between gap-sm">
        <h1>Challenges</h1>
        {board.length > 0 && (
          <span className="badge tone-muted">
            {doneIn(board)}/{board.length} done
          </span>
        )}
      </div>
      {board.length === 0 && <p className="muted">No challenges are available to you yet. Keep an eye on this screen.</p>}
      {urgent.length > 0 && (
        <section className="board-urgent stack gap-sm" aria-label="Your turn">
          {tiles(urgent)}
        </section>
      )}
      {headed
        ? groups.map((g) => (
            <section key={g.category} className="board-group stack gap-sm" aria-label={g.category || 'Other challenges'}>
              <div className="row align-center justify-between gap-sm">
                <h2 className="board-group-title">{g.category || 'Other'}</h2>
                <span className="muted small mono">
                  {doneIn(g.entries)}/{g.entries.length}
                </span>
              </div>
              {tiles(g.entries)}
            </section>
          ))
        : groups[0] && tiles(groups[0].entries)}
    </section>
  );
}

type TileAction = 'start' | 'open' | null;

function tileAction(entry: BoardEntry, revealed: boolean): TileAction {
  if (entry.status === 'in_progress') return 'open';
  if (entry.status === 'available' && entry.repeat) return 'start'; // e.g. it is your turn
  // Once results are revealed a finished tile opens the player's result (with "play again" there).
  if (revealed && entry.result) return 'open';
  if (entry.status === 'available' || entry.canReplay) return 'start';
  return null;
}

function tileState(entry: BoardEntry, revealed: boolean): { icon: string; label: string } {
  const again = entry.canReplay ? ' · tap to play again' : '';
  // The module's own words (e.g. "Your turn!") win over the generic labels.
  if (entry.statusText && (entry.status === 'available' || entry.status === 'waiting')) {
    return { icon: entry.status === 'available' ? '▶' : '⏳', label: entry.statusText };
  }
  switch (entry.status) {
    case 'available':
      return { icon: '▶', label: 'Tap to play' };
    case 'waiting':
      return { icon: '⏳', label: 'Not your turn yet' };
    case 'in_progress':
      return { icon: '⏱', label: 'Playing — tap to continue' };
    case 'scored':
      return { icon: '✓', label: `${entry.points !== null && entry.points > 0 ? '+' : ''}${formatPoints(entry.points ?? 0)} pts${again}` };
    case 'submitted':
      return revealed ? { icon: '⏳', label: `Being scored${again}` } : { icon: '✓', label: `Done${again}` };
    case 'missed':
      return { icon: '✕', label: `Time ran out${again}` };
    case 'locked':
      return { icon: '🔒', label: 'Not open yet' };
    case 'closed':
      return { icon: '■', label: entry.result ? 'Closed · tap for results' : 'Closed' };
  }
}

function Tile({
  entry,
  ctx,
  revealed,
  paused,
  starting,
  busy,
  onStart,
}: {
  entry: BoardEntry;
  ctx: PlayCtx;
  revealed: boolean;
  paused: boolean;
  starting: boolean;
  busy: boolean;
  onStart: () => void;
}) {
  const action = tileAction(entry, revealed);
  const state = starting ? { icon: '…', label: 'Starting' } : tileState(entry, revealed);
  const timer = entry.status === 'in_progress' ? lockTimer(entry, ctx.meId) : undefined;
  const playable = action === 'start';
  const disabled = action === null || busy || (playable && paused);
  const onClick = () => {
    if (action === 'start') onStart();
    else if (action === 'open') ctx.openChallenge(entry.instanceId);
  };

  return (
    <li>
      <button
        type="button"
        className={`tile status-${entry.status}${playable ? ' is-playable' : ''}${entry.urgent ? ' is-urgent' : ''}${action === null ? ' is-inert' : ''}`}
        disabled={disabled}
        aria-busy={starting || undefined}
        onClick={onClick}
      >
        <span className="tile-title">{entry.title}</span>
        {entry.title !== entry.moduleName && <span className="tile-sub">{entry.moduleName}</span>}
        <span className="tile-state">
          <span aria-hidden="true">{state.icon}</span> {state.label}
        </span>
        {entry.note && <span className={`tile-note${entry.noteTone ? ` tone-${entry.noteTone}` : ''}`}>{entry.note}</span>}
        {timer && <Countdown endsAt={timer.endsAt} startedAt={timer.startedAt} clockOffset={ctx.sock.clockOffset} paused={paused} size="sm" label="Time left" />}
      </button>
    </li>
  );
}
