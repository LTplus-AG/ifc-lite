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
  });

  const blobStorage = opts.blobStorage ?? new InMemoryBlobStorage();

  const httpServer =
    opts.server ??
    http.createServer(async (req, res) => {
      try {
        if (req.url === '/healthz') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, rooms: roomManager.list().length }));
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
