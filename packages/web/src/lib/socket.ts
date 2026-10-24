import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClientMessage, GameEvent, GameSnapshot, ServerMessage } from '@challenge/contract';

export type SocketParams =
  | { role: 'host'; gameId: string; token: string }
  | { role: 'main'; code: string }
  | { role: 'player'; code: string; token: string };

export type SocketStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface FatalInfo {
  /** 4003 = authentication failed / game gone; 4001 = player removed by the host. */
  kind: 'unauthorized' | 'removed';
  message: string;
}

/** Result of an acknowledged client message (START / SUBMIT / FINISH / JUDGE). */
export interface AckResult {
  ok: boolean;
  reason?: string;
}

export interface GameSocket {
  snapshot: GameSnapshot | null;
  status: SocketStatus;
  /** Latest non-fatal server error message. */
  error: string | null;
  fatal: FatalInfo | null;
  /** Latest non-snapshot event (for toasts and animations). */
  lastEvent: GameEvent | null;
  /** serverNow ≈ Date.now() + clockOffset */
  clockOffset: number;
  /** Player: start an attempt on a board challenge. */
  start(instanceId: string): Promise<AckResult>;
  /** Player: submit (or replace) an answer; `final` locks it in right away. */
  submit(instanceId: string, payload: unknown, final?: boolean): Promise<AckResult>;
  /** Player: a live action (e.g. a batch of taps) for the module; not a submission. */
  action(instanceId: string, payload: unknown): Promise<AckResult>;
  /** Player: lock the attempt early when the module allows resubmission. */
  finish(instanceId: string): Promise<AckResult>;
  /** Player: decide a judging task. */
  judge(assignmentId: string, decision: 'approve' | 'reject', note?: string): Promise<AckResult>;
  resync(): void;
}

const ACK_TIMEOUT_MS = 5000;
const PING_INTERVAL_MS = 10000;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 10000;

function buildUrl(p: SocketParams): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const q = new URLSearchParams({ role: p.role });
  if (p.role === 'host') {
    q.set('gameId', p.gameId);
    q.set('token', p.token);
  } else if (p.role === 'main') {
    q.set('code', p.code);
  } else {
    q.set('code', p.code);
    q.set('token', p.token);
  }
  return `${proto}://${window.location.host}/ws?${q.toString()}`;
}

function newClientId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

interface Pending {
  resolve: (r: AckResult) => void;
  timer: number;
}

/** Messages that carry a clientId and are answered with an ACK. */
type AckedMessage = Exclude<ClientMessage, { type: 'RESYNC' } | { type: 'PING' }>;

export function useGameSocket(params: SocketParams | null): GameSocket {
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [status, setStatus] = useState<SocketStatus>(params ? 'connecting' : 'closed');
  const [error, setError] = useState<string | null>(null);
  const [fatal, setFatal] = useState<FatalInfo | null>(null);
  const [lastEvent, setLastEvent] = useState<GameEvent | null>(null);
  const [clockOffset, setClockOffset] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef(new Map<string, Pending>());

  // Reconnect only when the connection parameters actually change.
  const key = params ? JSON.stringify(params) : null;

  useEffect(() => {
    if (!key) {
      setStatus('closed');
      return;
    }
    const p = JSON.parse(key) as SocketParams;
    let disposed = false;
    let attempt = 0;
    let ws: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let pingTimer: number | undefined;
    let bestRtt = Number.POSITIVE_INFINITY;
    let lastFatalMessage: string | null = null;
    const pending = pendingRef.current;

    setSnapshot(null);
    setFatal(null);
    setError(null);
    setStatus('connecting');

    const send = (msg: ClientMessage) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    const failPending = (reason: string) => {
      for (const [, entry] of pending) {
        window.clearTimeout(entry.timer);
        entry.resolve({ ok: false, reason });
      }
      pending.clear();
    };

    const sendPing = () => send({ type: 'PING', t: Date.now() });

    const handleMessage = (msg: ServerMessage) => {
      switch (msg.type) {
        case 'HELLO':
          setClockOffset(msg.serverTime - Date.now());
          break;
        case 'EVENT':
          if (msg.event.type === 'GAME_STATE_SNAPSHOT') {
            // The snapshot is authoritative and replaces local state wholesale (FR-36).
            setSnapshot(msg.event.payload as GameSnapshot);
          } else {
            setLastEvent(msg.event);
          }
          break;
        case 'ACK': {
          const entry = pending.get(msg.clientId);
          if (entry) {
            window.clearTimeout(entry.timer);
            pending.delete(msg.clientId);
            entry.resolve({ ok: msg.ok, reason: msg.reason });
          }
          break;
        }
        case 'PONG': {
          const now = Date.now();
          const rtt = now - msg.t;
          if (rtt <= bestRtt) {
            bestRtt = rtt;
            setClockOffset(msg.serverTime + rtt / 2 - now);
          }
          break;
        }
        case 'ERROR':
          if (msg.fatal) lastFatalMessage = msg.message;
          else setError(msg.message);
          break;
      }
    };

    const connect = () => {
      if (disposed) return;
      ws = new WebSocket(buildUrl(p));
      wsRef.current = ws;
      ws.onopen = () => {
        attempt = 0;
        bestRtt = Number.POSITIVE_INFINITY;
        setStatus('open');
        setError(null);
        sendPing();
        pingTimer = window.setInterval(sendPing, PING_INTERVAL_MS);
      };
      ws.onmessage = (ev: MessageEvent<string>) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(ev.data) as ServerMessage;
        } catch {
          return;
        }
        handleMessage(msg);
      };
      ws.onclose = (ev: CloseEvent) => {
        window.clearInterval(pingTimer);
        if (wsRef.current === ws) wsRef.current = null;
        failPending('Connection lost');
        if (disposed) return;
        if (ev.code === 4003) {
          setFatal({ kind: 'unauthorized', message: lastFatalMessage ?? ev.reason ?? 'Not authorized' });
          setStatus('closed');
          return;
        }
        if (ev.code === 4001) {
          setFatal({ kind: 'removed', message: lastFatalMessage ?? 'You were removed from the game' });
          setStatus('closed');
          return;
        }
        setStatus('reconnecting');
        const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt);
        attempt += 1;
        reconnectTimer = window.setTimeout(connect, delay);
      };
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible') send({ type: 'RESYNC' });
    };
    document.addEventListener('visibilitychange', onVisible);

    // Deferred by a tick so React StrictMode's mount/unmount/mount in development
    // never opens (and immediately aborts) a socket.
    const startTimer = window.setTimeout(connect, 0);

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.clearTimeout(startTimer);
      window.clearTimeout(reconnectTimer);
      window.clearInterval(pingTimer);
      failPending('Connection closed');
      if (ws) {
        ws.onclose = null;
        ws.onmessage = null;
        ws.close();
      }
      wsRef.current = null;
    };
  }, [key]);

  /** Sends a clientId-tagged message and resolves with the server's ACK (or a timeout). */
  const sendAcked = useCallback((build: (clientId: string) => AckedMessage): Promise<AckResult> => {
    return new Promise((resolve) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        resolve({ ok: false, reason: 'Not connected — try again in a moment' });
        return;
      }
      const clientId = newClientId();
      const timer = window.setTimeout(() => {
        pendingRef.current.delete(clientId);
        resolve({ ok: false, reason: 'No response from the server — please try again' });
      }, ACK_TIMEOUT_MS);
      pendingRef.current.set(clientId, { resolve, timer });
      ws.send(JSON.stringify(build(clientId)));
    });
  }, []);

  const start = useCallback((instanceId: string) => sendAcked((clientId) => ({ type: 'START', instanceId, clientId })), [sendAcked]);
  const submit = useCallback(
    (instanceId: string, payload: unknown, final = false) =>
      sendAcked((clientId) => (final ? { type: 'SUBMIT', instanceId, payload, clientId, final: true } : { type: 'SUBMIT', instanceId, payload, clientId })),
    [sendAcked],
  );
  const finish = useCallback((instanceId: string) => sendAcked((clientId) => ({ type: 'FINISH', instanceId, clientId })), [sendAcked]);
  const action = useCallback(
    (instanceId: string, payload: unknown) => sendAcked((clientId) => ({ type: 'ACTION', instanceId, payload, clientId })),
    [sendAcked],
  );
  const judge = useCallback(
    (assignmentId: string, decision: 'approve' | 'reject', note?: string) =>
      sendAcked((clientId) => {
        const trimmed = note?.trim();
        return trimmed ? { type: 'JUDGE', assignmentId, decision, note: trimmed, clientId } : { type: 'JUDGE', assignmentId, decision, clientId };
      }),
    [sendAcked],
  );

  const resync = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'RESYNC' } satisfies ClientMessage));
  }, []);

  return useMemo(
    () => ({ snapshot, status, error, fatal, lastEvent, clockOffset, start, submit, action, finish, judge, resync }),
    [snapshot, status, error, fatal, lastEvent, clockOffset, start, submit, action, finish, judge, resync],
  );
}
