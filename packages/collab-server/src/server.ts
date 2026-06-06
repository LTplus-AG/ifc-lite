/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Websocket sync server entry point.
 */

import * as http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { RoomManager, type PeerConnection } from './room-manager.js';
import { FilePersistence, MemoryPersistence, type Persistence } from './persistence.js';
import { allowAnonymousEditor, canWrite, type AuthenticateFn, type Principal } from './auth.js';
import { type AuditSink } from './audit-log.js';
import { type RateLimitOptions } from './rate-limit.js';
import { type VerifyMessageFn } from './room-manager.js';
import {
  handleBlobRequest,
  InMemoryBlobStorage,
  type BlobAuthorizeFn,
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
   * Authorizer for the `/blobs` route. When omitted it defaults to one
   * derived from `authenticate` so the blob route shares the websocket
   * sync token (a missing/invalid token is rejected, and PUT/DELETE
   * additionally require write capability). With the anonymous default
   * `authenticate`, blob access stays anonymous — matching the WS path.
   * Pass `null` to explicitly disable blob authorization.
   */
  authorizeBlob?: BlobAuthorizeFn | null;
  /**
   * Require a bearer token (compared against this shared secret) for the
   * `/metrics` diagnostics endpoint, which labels gauges with raw room
   * IDs. `/healthz` stays open for liveness probes but omits room detail
   * unless this token is presented. Defaults to `COLLAB_METRICS_TOKEN`.
   */
  metricsToken?: string;
  /**
   * Unload rooms that have had zero peers for this many ms (default
   * disabled). Persistence keeps the durable copy; rehydrate on next
   * connect.
   */
  idleUnloadMs?: number;
  /** Metrics registry to publish at `/metrics`. Defaults to the package singleton. */
  metrics?: MetricsRegistry;
  /**
   * Optional per-message verifier (anti-replay HMAC etc.). Runs before
   * rate limit / role check. Returning `{ ok: false }` audits as
   * `reject` with the reason and drops the message.
   */
  verifyMessage?: VerifyMessageFn;
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
    verifyMessage: opts.verifyMessage,
  });

  const blobStorage = opts.blobStorage ?? new InMemoryBlobStorage();
  // Default the blob authorizer to one that reuses the WS `authenticate`
  // hook so blobs share the same token scheme. `null` disables it.
  const authorizeBlob: BlobAuthorizeFn | undefined =
    opts.authorizeBlob === null
      ? undefined
      : opts.authorizeBlob ?? makeBlobAuthorizer(authenticate);
  const metricsToken = opts.metricsToken ?? process.env.COLLAB_METRICS_TOKEN;
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
        const reqUrl = new URL(req.url ?? '/', 'http://localhost');
        const pathname = reqUrl.pathname;
        // Room IDs encode tenant project/model paths, so room-identifying
        // diagnostics detail is only surfaced to a caller presenting the
        // metrics token. When no token is configured, behaviour is unchanged
        // (open) — deployers opt in to gating by setting the token.
        const diagAuthorized = !metricsToken || isMetricsAuthorized(req, metricsToken);
        if (pathname === '/healthz') {
          // Liveness probes must reach /healthz unauthenticated, but the
          // live room count leaks cross-tenant scale — only include it when
          // the caller is authorized (or when no token gates diagnostics).
          const body: Record<string, unknown> = { ok: true };
          if (diagAuthorized) body.rooms = roomManager.list().length;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
          return;
        }
        if (pathname === '/metrics') {
          if (!diagAuthorized) {
            // /metrics labels gauges with raw roomIds (tenant project/model
            // paths). Reject rather than leak them; never populate the
            // registry with room labels on the unauthorized path.
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'unauthorized' }));
            return;
          }
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
        if (pathname.startsWith('/blobs')) {
          const handled = await handleBlobRequest(req, res, {
            storage: blobStorage,
            maxBytes: opts.blobMaxBytes,
            authorize: authorizeBlob,
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

  // Defense-in-depth: cap the raw frame size at the ws layer so an
  // oversized write/awareness frame is dropped before it reaches the
  // room-manager decode + per-message size guards. Sized above the 8 MB
  // sync write-frame ceiling enforced in room-manager.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

  httpServer.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      // handleConnection runs async setup (room load, auth callback,
      // persistence open). If it rejects — e.g. RoomManager.getOrCreate
      // throws on room-cap or persistence failure — we previously
      // discarded the promise with `void`, leaving the socket open and
      // surfacing as a process-level unhandledRejection. Catch the error,
      // log it, and close the socket with a non-1000 code so the client
      // sees a deterministic shutdown.
      handleConnection(ws, req, { roomManager, authenticate }).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[collab-server] connection setup failed:', err);
        try {
          if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
            // 1011 = server error per RFC 6455
            ws.close(1011, 'connection setup failed');
          }
        } catch {
          // ignore close errors
        }
      });
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

/**
 * Pseudo-room scope handed to `authenticate` for blob requests. Blobs are
 * content-addressed and not room-scoped, but reusing the WS `authenticate`
 * hook keeps the credential scheme identical. Custom authenticators that
 * key off roomId see this sentinel and can grant/deny blob access
 * explicitly.
 */
const BLOB_AUTH_ROOM = '__blobs__';

/**
 * Derive a blob authorizer from the websocket `authenticate` hook so the
 * blob route shares the same token scheme. A null principal (bad/missing
 * token) is rejected; PUT/DELETE additionally require write capability,
 * GET/HEAD/list accept any authenticated principal.
 */
function makeBlobAuthorizer(authenticate: AuthenticateFn): BlobAuthorizeFn {
  return async (token, method, _hash) => {
    let principal: Principal | null;
    try {
      principal = await authenticate(token, BLOB_AUTH_ROOM);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[collab-server] blob auth threw:', err);
      return false;
    }
    if (!principal) return false;
    if (method === 'PUT' || method === 'DELETE') return canWrite(principal);
    return true;
  };
}

/**
 * Lift the bearer credential from a diagnostics request — `Authorization`
 * header only. Plain-HTTP diagnostics endpoints (`/metrics`) deliberately do
 * NOT accept `?token=`: a query-string secret leaks via access logs, reverse
 * proxies, traces, and copied URLs. (The WebSocket path keeps its `?token=`
 * fallback because browsers can't set custom handshake headers.)
 */
function extractDiagToken(req: http.IncomingMessage): string | undefined {
  const header = req.headers['authorization'];
  if (typeof header === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (m) return m[1];
  }
  return undefined;
}

/**
 * Constant-time check that the request carries the configured metrics
 * token. Callers gate this on `metricsToken` being set.
 */
function isMetricsAuthorized(
  req: http.IncomingMessage,
  metricsToken: string,
): boolean {
  const presented = extractDiagToken(req);
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(metricsToken);
  // timingSafeEqual throws on length mismatch; guard first.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export { FilePersistence, MemoryPersistence } from './persistence.js';
