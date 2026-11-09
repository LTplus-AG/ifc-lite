/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ordered, bounded, idempotent shutdown for `startCollabServer`.
 *
 * The WebSocketServer runs with `noServer: true`. In ws@8 `close(cb)` on such
 * a server does not touch existing clients: it only stops new upgrades (they
 * get a 503) and calls back once `clients.size` reaches 0. Our peers never
 * leave on their own (the app keepalive exists precisely to keep y-websocket
 * connected), and the only thing that closes them is unloading their rooms.
 * Awaiting the wss callback before unloading therefore hung `stop()` forever
 * with anyone connected: no final compaction, and bin.ts never reached its
 * access-control `flush()`.
 *
 * So: refuse new work first without waiting, unload rooms (final compaction +
 * peer close), then wait for sockets to drain for at most `graceMs` before
 * terminating whatever is left.
 */

import type * as http from 'node:http';
import type { WebSocketServer } from 'ws';
import type { RoomManager } from './room-manager.js';

/** How long closing sockets get to finish their close handshake. */
export const SHUTDOWN_GRACE_MS = 2_000;

export interface ShutdownDeps {
  wss: WebSocketServer;
  httpServer: http.Server;
  /** False when the caller passed its own http server: leave it listening. */
  ownsHttpServer: boolean;
  roomManager: RoomManager;
  /** Stop timers that would otherwise touch rooms during teardown. */
  stopTimers: () => void;
  graceMs?: number;
}

/** Returns a `stop()` that runs the sequence once; later calls share it. */
export function createStop(deps: ShutdownDeps): () => Promise<void> {
  let stopping: Promise<void> | null = null;
  return () => {
    stopping ??= runShutdown(deps);
    return stopping;
  };
}

async function runShutdown(deps: ShutdownDeps): Promise<void> {
  const { wss, httpServer, ownsHttpServer, roomManager } = deps;
  const graceMs = deps.graceMs ?? SHUTDOWN_GRACE_MS;
  deps.stopTimers();

  // 1. Refuse new work, but do not wait yet: both callbacks wait for sockets
  //    that only step 2 closes. wss.close() moves ws to CLOSING, so a racing
  //    upgrade is answered 503 instead of being registered into a room.
  const wssClosed = new Promise<void>((resolve) => wss.close(() => resolve()));
  const httpClosed = ownsHttpServer
    ? new Promise<void>((resolve) => httpServer.close(() => resolve()))
    : Promise.resolve();

  // 2. Final compaction for every room; this also closes each room's peers.
  //    A peer still in connection setup cannot land in a new room: the
  //    manager refuses getOrCreate once shutdown() has begun. (unloadAll()
  //    alone only evicts; the manager stays usable for embedders.)
  //    Every room settles before it rejects; a failure must not skip the
  //    socket drain below, so it is reported last.
  let unloadError: unknown = null;
  try {
    await roomManager.shutdown();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[collab-server] room unload failed during shutdown:', err);
    unloadError = err ?? new Error('room unload failed');
  }

  // 3. Sockets that never reached a room (mid-auth, mid-load) still count as
  //    wss clients. Ask them to go, then give every close handshake a bounded
  //    window before cutting the rest off.
  // Snapshots: a close/terminate can fire the 'close' handler that removes
  // the client from the live Set mid-loop.
  for (const ws of Array.from(wss.clients)) {
    try {
      ws.close(1001, 'server shutting down');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[collab-server] close during shutdown failed:', err);
    }
  }
  if (!(await settlesWithin(wssClosed, graceMs))) {
    for (const ws of Array.from(wss.clients)) ws.terminate();
    if (!(await settlesWithin(wssClosed, graceMs))) {
      // eslint-disable-next-line no-console
      console.error('[collab-server] websocket server still open after terminate; continuing shutdown');
    }
  }
  if (ownsHttpServer && !(await settlesWithin(httpClosed, graceMs))) {
    httpServer.closeAllConnections();
    if (!(await settlesWithin(httpClosed, graceMs))) {
      // eslint-disable-next-line no-console
      console.error('[collab-server] http server still open after closeAllConnections; continuing shutdown');
    }
  }
  if (unloadError !== null) throw unloadError;
}

async function settlesWithin(p: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([p.then(() => true as const), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
