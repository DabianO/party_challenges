import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { GameSnapshot } from '@challenge/contract';
import { Banner, ConnectionBanner, PausedBanner } from '../components/Banner';
import { PlayerAvatar } from '../components/PlayerAvatar';
import { AvatarEditor } from './play/AvatarEditor';
import { useToast } from '../components/Toast';
import type { EvidenceUploader } from '../components/UIRenderer';
import { api } from '../lib/api';
import { useBranding } from '../lib/branding';
import { shrinkPhoto } from '../lib/images';
import { resolveMedia } from '../lib/media';
import { useGameSocket, type GameSocket } from '../lib/socket';
import type { PlayerSession } from '../lib/storage';
import { formatPoints } from '../lib/time';
import { BoardScreen } from './play/BoardScreen';
import { ChallengeScreen } from './play/ChallengeScreen';
import { FinalScreen } from './play/FinalScreen';
import { JudgeScreen } from './play/JudgeScreen';
import { LobbyScreen } from './play/LobbyScreen';

export interface PlayProps {
  code: string;
  session: PlayerSession;
  /** Called when the server rejects the session token (4003). */
  onSessionInvalid: () => void;
}

/** Everything the guest screens need. */
export interface PlayCtx {
  snapshot: GameSnapshot;
  meId: string;
  sock: GameSocket;
  uploadEvidence: EvidenceUploader;
  /** Upload a selfie as the player's picture / go back to their icon. */
  uploadAvatar(image: Blob): Promise<void>;
  removeAvatar(): Promise<void>;
  openChallenge(instanceId: string): void;
  closeChallenge(): void;
  openJudging(): void;
  closeJudging(): void;
}

export function Play({ code, session, onSessionInvalid }: PlayProps) {
  const sock = useGameSocket({ role: 'player', code, token: session.sessionToken });
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const { snapshot, fatal, lastEvent } = sock;
  useBranding(snapshot?.game.branding);

  const meId = snapshot?.me?.playerId ?? session.playerId;

  useEffect(() => {
    if (fatal?.kind === 'unauthorized') onSessionInvalid();
  }, [fatal, onSessionInvalid]);

  useEffect(() => {
    if (!lastEvent) return;
    const payload = (lastEvent.payload ?? {}) as { playerId?: unknown; points?: unknown };
    switch (lastEvent.type) {
      case 'GAME_PAUSED':
        toast('The host paused the game', 'info');
        break;
      case 'GAME_RESUMED':
        toast('Game resumed', 'success');
        break;
      case 'EVALUATION_ASSIGNED':
        toast('You have been asked to judge a submission', 'info');
        break;
      case 'CHALLENGE_UNLOCKED':
        toast('A new challenge is available', 'info');
        break;
      case 'GAME_REOPENED':
        toast('The game continues!', 'success');
        break;
      case 'RESULTS_REVEALED':
        toast('Results are in! Tap a challenge to see how you did', 'success');
        break;
      case 'PLAYER_SCORED':
        if (payload.playerId === meId && typeof payload.points === 'number') {
          toast(`${payload.points >= 0 ? '+' : '−'}${formatPoints(Math.abs(payload.points))} pts`, payload.points >= 0 ? 'success' : 'warning');
        }
        break;
      default:
        break;
    }
  }, [lastEvent, toast, meId]);

  useEffect(() => {
    if (sock.error) toast(sock.error, 'danger');
  }, [sock.error, toast]);

  // Turn-based challenges: tell the player when a challenge they were waiting for is theirs to play.
  const waitingRef = useRef(new Set<string>());
  useEffect(() => {
    if (!snapshot) return;
    const waiting = waitingRef.current;
    for (const b of snapshot.board) {
      if (b.status === 'waiting') waiting.add(b.instanceId);
      else if (waiting.delete(b.instanceId) && b.status === 'available') toast(`${b.title}: ${b.statusText ?? "it's your turn!"}`, 'success');
    }
  }, [snapshot, toast]);

  const uploadEvidence = useCallback<EvidenceUploader>(
    async (file) => {
      // Phone photos are shrunk first: uploaded in a moment, before the connection can drop.
      const res = await api.uploadEvidence(code, session.sessionToken, await shrinkPhoto(file));
      return { ref: res.ref, url: res.url };
    },
    [code, session.sessionToken],
  );

  const uploadAvatar = useCallback(
    async (image: Blob) => {
      await api.uploadAvatar(code, session.sessionToken, image);
    },
    [code, session.sessionToken],
  );
  const removeAvatar = useCallback(async () => {
    await api.removeAvatar(code, session.sessionToken);
  }, [code, session.sessionToken]);
  const [editingAvatar, setEditingAvatar] = useState(false);

  const challengeId = params.get('challenge');
  const judging = params.get('judge') === '1';
  // A challenge (or the judging screen) opens at its top, not where the board was scrolled to.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [challengeId, judging]);

  const openChallenge = useCallback(
    (instanceId: string) => {
      setParams((p) => {
        const next = new URLSearchParams(p);
        next.set('challenge', instanceId);
        next.delete('judge');
        return next;
      });
    },
    [setParams],
  );
  const closeChallenge = useCallback(() => {
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.delete('challenge');
      next.delete('judge');
      return next;
    });
  }, [setParams]);
  const openJudging = useCallback(() => {
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.set('judge', '1');
      return next;
    });
  }, [setParams]);
  const closeJudging = useCallback(() => {
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.delete('judge');
      return next;
    });
  }, [setParams]);

  const ctx = useMemo<PlayCtx | null>(
    () => (snapshot ? { snapshot, meId, sock, uploadEvidence, uploadAvatar, removeAvatar, openChallenge, closeChallenge, openJudging, closeJudging } : null),
    [snapshot, meId, sock, uploadEvidence, uploadAvatar, removeAvatar, openChallenge, closeChallenge, openJudging, closeJudging],
  );

  if (fatal?.kind === 'removed') {
    return (
      <main className="page page-narrow center-text stack gap-md">
        <h1>Removed</h1>
        <p role="alert">{fatal.message}</p>
        <Link className="btn btn-primary" to="/">
          Back to start
        </Link>
      </main>
    );
  }

  const displayName = snapshot?.me?.displayName ?? session.displayName;
  const logo = resolveMedia(snapshot?.game.branding.logo);
  const mine = snapshot?.leaderboard.find((e) => e.playerId === meId);
  const judgeCount = snapshot?.judging.length ?? 0;
  const me = snapshot?.players.find((p) => p.id === meId);

  return (
    <div className="play">
      <header className="play-header">
        <div className="row gap-sm align-center grow">
          {logo && <img className="brand-logo" src={logo} alt="" />}
          <span className="play-title">{snapshot?.game.name ?? session.gameName}</span>
        </div>
        <div className="play-me">
          {me ? (
            <button type="button" className="play-me-button" aria-expanded={editingAvatar} onClick={() => setEditingAvatar((v) => !v)} title="Your picture">
              <PlayerAvatar player={me} size={26} />
              <strong>{displayName}</strong>
            </button>
          ) : (
            <span>
              You: <strong>{displayName}</strong>
            </span>
          )}
          {mine && snapshot && snapshot.game.status !== 'LOBBY' && snapshot.game.resultsRevealed && (
            <span className="play-rank" aria-label={`Rank ${mine.rank} of ${snapshot.leaderboard.length}, ${formatPoints(mine.total)} points`}>
              #{mine.rank}
              <span className="muted">/{snapshot.leaderboard.length}</span> · {formatPoints(mine.total)} pts
            </span>
          )}
        </div>
      </header>
      {ctx && editingAvatar && (
        <div className="card avatar-panel">
          <AvatarEditor ctx={ctx} />
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditingAvatar(false)}>
            Done
          </button>
        </div>
      )}
      <ConnectionBanner status={sock.status} />
      {snapshot && <PausedBanner paused={snapshot.game.paused} />}
      {ctx && judgeCount > 0 && !judging && ctx.snapshot.game.status === 'IN_PROGRESS' && (
        <button type="button" className="judge-banner" onClick={openJudging}>
          <Banner tone="warning" icon="⚖">
            You have been asked to judge ({judgeCount}) — tap to open
          </Banner>
        </button>
      )}
      <main className="page play-body">
        {!ctx ? (
          <p className="muted center-text" role="status">
            Loading…
          </p>
        ) : (
          <PlayBody ctx={ctx} challengeId={challengeId} judging={judging} />
        )}
      </main>
    </div>
  );
}

function PlayBody({ ctx, challengeId, judging }: { ctx: PlayCtx; challengeId: string | null; judging: boolean }) {
  const status = ctx.snapshot.game.status;
  switch (status) {
    case 'DRAFT':
    case 'LOBBY':
      return <LobbyScreen ctx={ctx} />;
    case 'IN_PROGRESS':
      if (judging) return <JudgeScreen ctx={ctx} />;
      if (challengeId) return <ChallengeScreen ctx={ctx} instanceId={challengeId} />;
      return <BoardScreen ctx={ctx} />;
    case 'GAME_RESULTS':
    case 'FINISHED':
      return <FinalScreen ctx={ctx} />;
  }
}
