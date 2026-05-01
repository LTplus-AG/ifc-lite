/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Websocket sync server entry point.
 */

import * as http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { RoomManager, type PeerConnection } from './room-manager.js';
import { FilePersistence, MemoryPersistence, type Persistence } from './persistence.js';
import { allowAnonymousEditor, type AuthenticateFn, type Principal } from './auth.js';
import { type AuditSink } from './audit-log.js';
import { type RateLimitOptions } from './rate-limit.js';
import {
  handleBlobRequest,
  InMemoryBlobStorage,
  type ServerBlobStorage,
} from './blob-route.js';
import { defaultMetrics, MetricsRegistry } from './metrics.js';

export interface StartCollabServerOptions {
  port?: number;
  host?: string;
  persistence?: Persistence;
  authenticate?: AuthenticateFn;
  maxRooms?: number;
  compactEvery?: number;
  /** Pre-built http server to attach to instead of creating one. */
  server?: http.Server;
  /** Append-only audit sink. Default: drop all events. */
  auditSink?: AuditSink;
  /** Per-peer rate limit. Function form lets you tune by role/user. */
  rateLimit?: RateLimitOptions | ((principal: Principal) => RateLimitOptions);
  /**
   * Pluggable blob storage for the `/blobs/...` route. Default:
   * in-memory. Pass a custom `ServerBlobStorage` to back with S3 or
   * filesystem in production.
   */
  blobStorage?: ServerBlobStorage;
  /** Reject blob PUTs above this size (default 100 MB). */
  blobMaxBytes?: number;
  /**
   * Unload rooms that have had zero peers for this many ms (default
   * disabled). Persistence keeps the durable copy; rehydrate on next
   * connect.
   */
  idleUnloadMs?: number;
  /** Metrics registry to publish at `/metrics`. Defaults to the package singleton. */
  metrics?: MetricsRegistry;
}

export interface CollabServerHandle {
  readonly url: string;
  readonly httpServer: http.Server;
  readonly wss: WebSocketServer;
  readonly roomManager: RoomManager;
  stop(): Promise<void>;
}

const PING_INTERVAL_MS = 30_000;

export async function startCollabServer(
  opts: StartCollabServerOptions = {},
): Promise<CollabServerHandle> {
  const persistence = opts.persistence ?? new MemoryPersistence();
  const authenticate = opts.authenticate ?? allowAnonymousEditor;
  const roomManager = new RoomManager({
    persistence,
    maxRooms: opts.maxRooms,
    compactEvery: opts.compactEvery,
    auditSink: opts.auditSink,
    rateLimit: opts.rateLimit,
    idleUnloadMs: opts.idleUnloadMs,
  });

  const blobStorage = opts.blobStorage ?? new InMemoryBlobStorage();
  const metrics = opts.metrics ?? defaultMetrics;
  const peersGauge = metrics.gauge(
    'collab_room_peers',
    'Currently connected peers per room',
  );
  const roomsGauge = metrics.gauge('collab_rooms', 'Currently loaded rooms');
  const updatesCounter = metrics.counter(
    'collab_updates_total',
    'Y updates accepted by the server',
  );
  const rejectsCounter = metrics.counter(
    'collab_rejects_total',
    'Update messages rejected (rate-limit / role / replay)',
  );

  const httpServer =
    opts.server ??
    http.createServer(async (req, res) => {
      try {
        if (req.url === '/healthz') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, rooms: roomManager.list().length }));
          return;
        }
        if (req.url === '/metrics') {
          // Refresh derived gauges before rendering so the snapshot
          // reflects live state, not state-at-last-event.
          const stats = await roomManager.stats();
          roomsGauge.set(stats.length);
          for (const s of stats) peersGauge.set(s.peerCount, { room: s.roomId });
          res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
          res.end(metrics.render());
          return;
        }
        // Blob route: PUT / GET / HEAD / DELETE on /blobs/<hash>, GET /blobs.
        if (req.url && req.url.startsWith('/blobs')) {
          const handled = await handleBlobRequest(req, res, {
            storage: blobStorage,
            maxBytes: opts.blobMaxBytes,
          });
          if (handled) return;
        }
        res.writeHead(404);
        res.end();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[collab-server] http handler error:', err);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end();
        }
      }
    });

  // Surface the counters on the manager so the room can bump them in
  // its update / reject paths. Done as opaque setters to keep
  // RoomManager from importing the metrics module directly.
  roomManager.setCounters({
    update: () => updatesCounter.inc(),
    reject: (reason: string) => rejectsCounter.inc(1, { reason }),
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      void handleConnection(ws, req, { roomManager, authenticate });
    });
  });

  if (!opts.server) {
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(opts.port ?? 1234, opts.host ?? '0.0.0.0', () => {
        httpServer.off('error', reject);
        resolve();
      });
    });
  }

  const address = httpServer.address();
  const url =
    typeof address === 'object' && address
      ? `ws://${opts.host ?? '127.0.0.1'}:${address.port}`
      : `ws://${opts.host ?? '127.0.0.1'}:${opts.port ?? 1234}`;

  return {
    url,
    httpServer,
    wss,
    roomManager,
    async stop() {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      if (!opts.server) {
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
      await roomManager.unloadAll();
    },
  };
}

interface ConnectionContext {
  roomManager: RoomManager;
  authenticate: AuthenticateFn;
}

async function handleConnection(ws: WebSocket, req: http.IncomingMessage, ctx: ConnectionContext) {
  ws.binaryType = 'arraybuffer';
  const url = new URL(req.url ?? '/', 'http://localhost');
  // y-websocket convention: room id is the path (e.g. ws://host/project/model)
  const roomId = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
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
  const conn: PeerConnection = {
    ws,
    principal,
    awarenessClients: new Set<number>(),
  };
  room.addConnection(conn);

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

  ws.on('message', (data: ArrayBuffer | Buffer) => {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
    room.handleMessage(conn, bytes);
  });

  const cleanup = () => {
    clearInterval(ping);
    room.removeConnection(conn);
  };
  ws.on('close', cleanup);
  ws.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[collab-server] ws error:', err);
    cleanup();
  });
}

export { FilePersistence, MemoryPersistence } from './persistence.js';
