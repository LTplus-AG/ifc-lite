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
import {
  handleTokenMintRequest,
  handleRevokeRequest,
  handleKickRequest,
  type TokenEndpointOptions,
  type RevokeEndpointOptions,
  type KickEndpointOptions,
} from './room-token.js';
import { MemoryLayerRegistry, type LayerRegistryStore } from './layer-registry.js';
import type { RegistryWebhook } from './registry-webhooks.js';
import {
  handleLayerRegistryRequest,
  type RegistryAuthorizeFn,
} from './layer-registry-route.js';
import { defaultMetrics, MetricsRegistry } from './metrics.js';

/**
 * Cross-origin policy for the HTTP routes (`/blobs`, `/collab/*`, `/healthz`,
 * `/metrics`). The viewer is typically served from a different origin than the
 * collab-server, so a browser `fetch()`/`PUT` to the blob route needs
 * `Access-Control-Allow-*` headers and an `OPTIONS` preflight response —
 * without them the WebSocket doc syncs but geometry blobs are blocked, so
 * recipients see an empty model.
 */
export interface CorsOptions {
  /**
   * Allowed origin(s). `'*'` or omitted reflects whatever `Origin` the
   * request carries (permissive — fine for dev and same-trust deployments).
   * An explicit string or array restricts to those origins; a non-matching
   * origin gets no CORS headers (and the browser blocks the request).
   */
  origin?: '*' | string | string[];
}

/** Headers a browser blob client (`HttpBlobStore`) sends; allowed on preflight. */
const CORS_ALLOW_HEADERS = 'Content-Type, Authorization, Accept, X-Blob-Hash';
const CORS_ALLOW_METHODS = 'GET, HEAD, PUT, POST, DELETE, OPTIONS';
const CORS_EXPOSE_HEADERS = 'X-Blob-Hash, Content-Length';

/**
 * Resolve the `Access-Control-Allow-Origin` value for a request, or `null`
 * when the origin isn't allowed (no CORS headers are then written).
 */
function resolveAllowedOrigin(
  cors: CorsOptions | false | undefined,
  requestOrigin: string | undefined,
): string | null {
  if (cors === false) return null;
  const origin = cors?.origin;
  // Permissive default: reflect the caller's Origin so credentialed and
  // credentialless (COEP) browser requests both work. Falls back to '*' for
  // non-browser callers that send no Origin header.
  if (origin === undefined || origin === '*') return requestOrigin ?? '*';
  const allow = Array.isArray(origin) ? origin : [origin];
  if (requestOrigin && allow.includes(requestOrigin)) return requestOrigin;
  return null;
}

/** Write CORS headers onto a response. Returns true if cross-origin is allowed. */
function applyCors(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cors: CorsOptions | false | undefined,
): boolean {
  const allowed = resolveAllowedOrigin(cors, req.headers.origin);
  if (allowed === null) return false;
  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', CORS_ALLOW_METHODS);
  res.setHeader('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS);
  res.setHeader('Access-Control-Expose-Headers', CORS_EXPOSE_HEADERS);
  res.setHeader('Access-Control-Max-Age', '86400');
  // Lets the blob bytes be read by a COEP `credentialless`/`require-corp` page.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  return true;
}

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
   * Registry authorizer override. The default adapts `authenticate` with a
   * pseudo-room, which room-BOUND token schemes can never satisfy — those
   * deployments supply their own (see `createRoomTokenRegistryAuthorizer`).
   * `null` disables auth (anonymous registry).
   */
  authorizeRegistry?: RegistryAuthorizeFn | null;
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
  /**
   * Enable the `POST /collab/token` mint route for link-based sharing.
   * Omit to leave the route disabled (404). Pair with
   * `authenticate: createRoomTokenAuthenticator({ secret })` so connections
   * are verified against the same secret.
   */
  tokenEndpoint?: TokenEndpointOptions;
  /**
   * Enable the `POST /collab/revoke` route so an admin can invalidate a share
   * link (its `jti` is added to a deny-list the authenticator's `isRevoked`
   * consults). Omit to leave the route disabled (404).
   */
  revokeEndpoint?: RevokeEndpointOptions;
  /**
   * Enable the `POST /collab/kick` route so an admin can force-disconnect a
   * peer by awareness clientId. The server binds the kick to its room manager;
   * only the verifying `secret` is supplied here. Omit to disable (404).
   */
  kickEndpoint?: Pick<KickEndpointOptions, 'secret' | 'isRevoked'>;
  /**
   * Cross-origin access for the HTTP routes. Default: enabled with origin
   * reflection (permissive). Pass an allow-list to restrict, or `false` to
   * disable entirely (e.g. when a reverse proxy owns CORS). Only applies to
   * the server this function creates — ignored when you pass your own
   * `server`.
   */
  cors?: CorsOptions | false;
  /**
   * Mount the layer-registry routes (`/api/v1/layers|refs|reviews`,
   * 10-registry.md): push/pull content-addressed layers, refs with
   * server-side merge-policy enforcement, and review objects. Off by
   * default. Pass `true` for an in-memory registry, or supply a store.
   * Authorization derives from `authenticate` exactly like the blob
   * route: any authenticated principal may read, writes require write
   * capability, and the principal's userId becomes the acting resolver
   * for merges and waivers.
   */
  layerRegistry?: boolean | { store?: LayerRegistryStore; maxBytes?: number; webhooks?: RegistryWebhook[] };
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
  // Registry: opt-in; authorization derives from `authenticate` like the
  // blob route (anonymous default stays anonymous, real auth gates writes).
  const layerRegistry: LayerRegistryStore | undefined = opts.layerRegistry
    ? typeof opts.layerRegistry === 'object' && opts.layerRegistry.store
      ? opts.layerRegistry.store
      : new MemoryLayerRegistry()
    : undefined;
  const authorizeRegistry: RegistryAuthorizeFn | undefined = !layerRegistry
    ? undefined
    : opts.authorizeRegistry === null
      ? undefined
      : opts.authorizeRegistry ?? makeRegistryAuthorizer(authenticate);
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
        applyCors(req, res, opts.cors);
        // Preflight: answer OPTIONS before any route so cross-origin PUT/HEAD/
        // DELETE (and GET-with-Authorization) to /blobs aren't rejected.
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }
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
        // Token mint route: POST /collab/token (link-based sharing).
        if (opts.tokenEndpoint && pathname === '/collab/token') {
          const handled = await handleTokenMintRequest(req, res, opts.tokenEndpoint);
          if (handled) return;
        }
        // Revoke route: POST /collab/revoke (admin invalidates a share link).
        if (opts.revokeEndpoint && pathname === '/collab/revoke') {
          const handled = await handleRevokeRequest(req, res, opts.revokeEndpoint);
          if (handled) return;
        }
        // Kick route: POST /collab/kick (admin force-disconnects a peer).
        if (opts.kickEndpoint && pathname === '/collab/kick') {
          const handled = await handleKickRequest(req, res, {
            secret: opts.kickEndpoint.secret,
            isRevoked: opts.kickEndpoint.isRevoked,
            kick: async (room, clientId) => {
              const pending = roomManager.peek(room);
              if (!pending) return false;
              const { kicked, jti } = (await pending).kickClient(clientId);
              // Also revoke the peer's token so their y-websocket can't just
              // reconnect with it. Requires the revoke endpoint's deny-list.
              if (kicked && jti && opts.revokeEndpoint) {
                await opts.revokeEndpoint.recordRevocation(jti, room);
              }
              return kicked;
            },
          });
          if (handled) return;
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
        // Layer registry (10-registry.md): /api/v1/layers|refs|reviews.
        if (layerRegistry && pathname.startsWith('/api/v1/')) {
          const handled = await handleLayerRegistryRequest(req, res, {
            registry: layerRegistry,
            authorize: authorizeRegistry,
            ...(typeof opts.layerRegistry === 'object' && opts.layerRegistry.maxBytes !== undefined
              ? { maxBytes: opts.layerRegistry.maxBytes }
              : {}),
            ...(typeof opts.layerRegistry === 'object' && opts.layerRegistry.webhooks !== undefined
              ? { webhooks: opts.layerRegistry.webhooks }
              : {}),
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
/** Room key the registry authorizer authenticates against. */
const REGISTRY_AUTH_ROOM = '__layer_registry__';

/**
 * Derive a registry authorizer from the websocket `authenticate` hook —
 * same scheme as blobs: reads accept any authenticated principal, writes
 * (POST/PUT) require write capability. The principal flows through so the
 * merge endpoint records it as the acting resolver.
 */
function makeRegistryAuthorizer(authenticate: AuthenticateFn): RegistryAuthorizeFn {
  return async (token, method) => {
    let principal: Principal | null;
    try {
      principal = await authenticate(token, REGISTRY_AUTH_ROOM);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[collab-server] registry auth threw:', err);
      return null;
    }
    if (!principal) return null;
    if ((method === 'POST' || method === 'PUT' || method === 'DELETE') && !canWrite(principal)) {
      return null;
    }
    return principal;
  };
}

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
