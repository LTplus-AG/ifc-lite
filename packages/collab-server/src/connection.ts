/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-socket setup for a collab websocket: authenticate, load the room,
 * register the peer, and relay its frames.
 *
 * The client speaks first. y-websocket sends its sync step 1 the moment the
 * socket opens, while this side is still awaiting `authenticate` and, on a cold
 * room, the room's log read. `ws` emits `message` events whether or not anyone
 * is listening, so a listener attached only after those awaits misses the
 * frame, the server never answers it, and y-websocket (which does not resend a
 * sync request on its own and is kept from reconnecting by our keepalive) never
 * reaches `synced`. The listener is therefore attached first and the frames it
 * sees are held until the room can take them.
 */

import type * as http from 'node:http';
import type { WebSocket } from 'ws';
import type { RoomManager, PeerConnection } from './room-manager.js';
import type { AuthenticateFn, Principal } from './auth.js';
import { parseRoomRequest } from './request-target.js';

const PING_INTERVAL_MS = 30_000;

/**
 * Most frames a peer may send before its room is ready. A well-behaved client
 * sends a handful on open (sync step 1, an awareness update), so this is
 * generous; the point is that a socket we have not yet authenticated cannot
 * make the server queue without limit.
 */
export const MAX_PENDING_FRAMES = 64;

/** Most bytes held across those frames. Same purpose as the frame cap. */
export const MAX_PENDING_BYTES = 1024 * 1024;

/** Metric reason recorded when a peer overruns the pre-ready buffer. */
export const PENDING_OVERFLOW_REASON = 'hydration-buffer';

export interface FrameInbox {
  /**
   * Deliver everything held so far, in arrival order, and every later frame
   * directly. Call it in the same tick the peer is registered so no frame can
   * slip between the replay and the switch to direct delivery.
   */
  attach(handler: (bytes: Uint8Array) => void): void;
}

/**
 * Listen on `ws` right now and hold what arrives until `attach` is called.
 *
 * A peer that exceeds {@link MAX_PENDING_FRAMES} or {@link MAX_PENDING_BYTES}
 * before then is closed with 1009 (message too big) and its held frames are
 * dropped; `onOverflow` lets the caller count it. The caller sees the closed
 * socket at its next await and stops setting the connection up.
 */
export function holdFramesUntilAttached(ws: WebSocket, onOverflow: () => void): FrameInbox {
  let held: Uint8Array[] | null = [];
  let heldBytes = 0;
  let deliver: ((bytes: Uint8Array) => void) | null = null;

  ws.on('message', (data: ArrayBuffer | Buffer) => {
    const bytes = new Uint8Array(data);
    if (deliver) {
      deliver(bytes);
      return;
    }
    if (!held) return; // already overflowed; the socket is closing
    if (held.length >= MAX_PENDING_FRAMES || heldBytes + bytes.byteLength > MAX_PENDING_BYTES) {
      held = null;
      onOverflow();
      try { ws.close(1009, 'hydration-buffer-overflow'); } catch { /* socket already gone */ }
      return;
    }
    held.push(bytes);
    heldBytes += bytes.byteLength;
  });

  return {
    attach(handler) {
      const replay = held ?? [];
      held = null;
      deliver = handler;
      for (const bytes of replay) handler(bytes);
    },
  };
}

export interface ConnectionContext {
  roomManager: RoomManager;
  authenticate: AuthenticateFn;
  /** Already validated by the caller; see `StartCollabServerOptions.keepaliveIntervalMs`. */
  keepaliveIntervalMs: number;
  /** Count a rejected peer under `reason` (the server's `rejects` metric). */
  reject: (reason: string) => void;
}

export async function handleConnection(ws: WebSocket, req: http.IncomingMessage, ctx: ConnectionContext) {
  ws.binaryType = 'arraybuffer';
  // Listen before the first await: frames and socket errors arrive from the
  // moment the upgrade completes, and an `error` event with no listener is
  // thrown by EventEmitter rather than ignored.
  const inbox = holdFramesUntilAttached(ws, () => ctx.reject(PENDING_OVERFLOW_REASON));
  ws.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[collab-server] ws error:', err);
  });
  const parsed = parseRoomRequest(req.url);
  if (!parsed) { ws.close(4400, 'malformed-room'); return; } // bad target or percent-escape
  const { url, roomId } = parsed;
  const token = url.searchParams.get('token') ?? undefined;
  if (!roomId) {
    ws.close(4400, 'missing-room');
    return;
  }

  let principal: Principal | null;
  try {
    principal = await ctx.authenticate(token, roomId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[collab-server] auth threw:', err);
    ws.close(4500, 'auth-error');
    return;
  }

  if (!principal) {
    ws.close(4401, 'unauthorized');
    return;
  }

  const room = await ctx.roomManager.getOrCreate(roomId);
  // The peer may have left (or overrun the pre-ready buffer and been closed)
  // while the room loaded. Registering it now would leave a ghost peer: its
  // `close` event already fired, so nothing would ever remove it.
  if (ws.readyState !== ws.OPEN) return;
  const conn: PeerConnection = {
    ws,
    principal,
    awarenessClients: new Set<number>(),
  };
  room.addConnection(conn);

  // Application-level keepalive. Distinct from the protocol ping below: only
  // a real message refreshes y-websocket's reconnect watchdog.
  const keepalive = setInterval(() => {
    room.sendKeepalive(conn);
  }, ctx.keepaliveIntervalMs);

  let alive = true;
  const ping = setInterval(() => {
    if (!alive) {
      try { ws.terminate(); } catch { /* socket already gone */ }
      clearInterval(ping);
      return;
    }
    alive = false;
    try { ws.ping(); } catch { /* socket already gone */ }
  }, PING_INTERVAL_MS);
  ws.on('pong', () => { alive = true; });

  const cleanup = () => {
    clearInterval(ping);
    clearInterval(keepalive);
    room.removeConnection(conn);
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);

  // Last, and after the teardown above: the replay runs the room's handlers
  // synchronously, and if one throws the peer must already be removable.
  inbox.attach((bytes) => room.handleMessage(conn, bytes));
}
