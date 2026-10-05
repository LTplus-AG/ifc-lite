/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Streamable HTTP transport (MCP 2025-11).
 *
 * Single endpoint behaviour:
 *   - POST  /          → submit a JSON-RPC request, return a JSON response
 *                        OR upgrade to SSE for long-running ops with progress.
 *   - GET   /          → open an SSE channel for server-initiated events.
 *   - DELETE /         → end the session.
 *
 * Stateless workers identify the session with the `Mcp-Session-Id` header,
 * assigned on first `initialize`. We keep a per-session `MCPServer` instance
 * here in v0.1 (process-local), with hooks to swap in a Redis-backed cache
 * for horizontally scaled deployments.
 *
 * Auth is intentionally pluggable via the `authenticator` option — the spec
 * says callers must support both bearer tokens and OAuth 2.1; this layer
 * just hands the request to whatever the deployer registers.
 */

import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { JsonRpcMessage } from '../protocol/index.js';
import { errorResponse, parseMessage } from '../protocol/jsonrpc.js';
import { JsonRpcErrorCode } from '../protocol/index.js';
import { MCPServer, OutgoingMessageSink } from '../server.js';
import { AuthScope } from '../auth/scope.js';
import { draftCount } from '../tools/layer-store.js';
import { parseHostHeader, pickReclaimable, readBody, sameScope, sendUnknownSession, writeSse, setCors, DEFAULT_MAX_SESSIONS, DEFAULT_SESSION_IDLE_MS, type SessionCapacityOptions } from './http-helpers.js';

export interface HttpAuthenticator {
  /**
   * Called for every inbound request. Returns the auth scope for the caller,
   * or null/undefined if the request must be rejected with 401.
   */
  authenticate(req: IncomingMessage): Promise<AuthScope | null> | AuthScope | null;
}

export interface SessionFactory {
  /**
   * Build a fresh MCPServer for this session. Called on `initialize`.
   *
   * The server MUST be constructed with `sessionId` (i.e.
   * `createMCPServer({ ..., sessionId })`): it keys per-session state —
   * the layer workspace in particular (#1030) — and its disposal on
   * session end. The transport rejects servers built without it rather
   * than letting every HTTP session silently share the local workspace.
   */
  build(scope: AuthScope, sessionId: string): Promise<MCPServer> | MCPServer;
}

export interface HttpTransportOptions extends SessionCapacityOptions {
  port: number;
  host?: string;
  authenticator: HttpAuthenticator;
  sessionFactory: SessionFactory;
  /** Maximum request body bytes. */
  maxBodyBytes?: number;
  /**
   * Browser Origins allowed to read JSON-RPC responses cross-origin. Empty /
   * undefined (the default) means NO browser cross-origin access — a page the
   * user visits cannot read responses or invoke tools. Operators who genuinely
   * need browser access opt in explicitly (CLI `--allow-origin`).
   */
  allowedOrigins?: string[];
}

interface Session {
  id: string;
  server: MCPServer;
  scope: AuthScope;
  sseClients: Set<ServerResponse>;
  createdAt: number;
  /** Wall-clock ms of the last authorised request, SSE open or close, or request completion. */
  lastSeen: number;
  /** Requests being handled right now: a session mid-call is never idle. */
  inFlight: number;
}

export class HttpTransport {
  private server: Server;
  private sessions = new Map<string, Session>();
  /** Sessions whose factory call is in flight: not yet in `sessions`, but already spoken for. */
  private building = 0;
  private opts: HttpTransportOptions;
  /** Browser Origins permitted to read responses (empty = none). */
  private allowedOrigins: Set<string>;
  /** Host header values accepted, to defeat DNS rebinding. */
  private allowedHosts: Set<string>;
  /**
   * Whether to enforce the Host allowlist. DNS-rebinding is a loopback-bind
   * concern; a deliberate public bind (`--host 0.0.0.0`/`::`, gated by
   * `--token`/`--insecure`) is reached via arbitrary hostnames/IPs we cannot
   * enumerate, so enforcing the allowlist there would 421 every real client.
   */
  private enforceHostCheck: boolean;

  constructor(opts: HttpTransportOptions) {
    this.opts = opts;
    this.allowedOrigins = new Set(opts.allowedOrigins ?? []);
    // A wildcard bind has no single hostname to allowlist — real clients send
    // the machine IP / DNS name, never `0.0.0.0`/`::`.
    const isWildcardBind = opts.host === '0.0.0.0' || opts.host === '::' || opts.host === '';
    this.enforceHostCheck = !isWildcardBind;
    // Accept the configured bind host plus the loopback aliases that resolve
    // to it. A DNS-rebinding attacker controls a name pointing at 127.0.0.1,
    // so requests arrive with an unexpected Host header and are rejected.
    this.allowedHosts = new Set(
      ['127.0.0.1', 'localhost', '::1', isWildcardBind ? undefined : opts.host].filter(
        (h): h is string => Boolean(h),
      ),
    );
    this.server = createServer((req, res) => {
      // Surface unhandled rejections via console.error rather than crashing
      // the process — one bad request must not take down the worker.
      this.handle(req, res).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[ifc-lite-mcp http] unhandled', err);
        if (!res.writableEnded) {
          res.statusCode = 500;
          res.end('Internal Server Error');
        }
      });
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.opts.port, this.opts.host ?? '0.0.0.0', () => resolve());
    });
  }

  /** Actual bound port — differs from `opts.port` when listening on 0. */
  port(): number | undefined {
    const addr = this.server.address();
    return typeof addr === 'object' && addr !== null ? addr.port : undefined;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      for (const session of this.sessions.values()) {
        for (const sseClient of session.sseClients) sseClient.end();
        session.server.detach();
      }
      this.sessions.clear();
      this.server.close(() => resolve());
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // DNS-rebinding defense: a malicious page can point a hostname it controls
    // at our loopback IP, but the browser still sends that hostname in Host.
    // Reject any Host that isn't the expected bind host / loopback alias.
    const host = parseHostHeader(req.headers.host);
    if (this.enforceHostCheck && host && !this.allowedHosts.has(host)) {
      res.statusCode = 421; // Misdirected Request
      res.end('Misdirected Request');
      return;
    }

    // Reflect CORS only for an explicitly allowlisted Origin — never `*` — so a
    // visited web page cannot read JSON-RPC responses or invoke tools by default.
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    setCors(res, origin, this.allowedOrigins);
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

    const scope = await this.opts.authenticator.authenticate(req);
    if (!scope) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    const sessionId = (req.headers['mcp-session-id'] as string | undefined)?.trim();

    if (req.method === 'GET') {
      // Open an SSE channel for an existing session. Same identity rule as
      // POST: a leaked Mcp-Session-Id must not let a differently-scoped
      // token attach to the victim's event stream.
      if (!sessionId || !this.sessions.has(sessionId)) {
        sendUnknownSession(res);
        return;
      }
      const session = this.sessions.get(sessionId) as Session;
      if (!sameScope(session.scope, scope)) {
        res.statusCode = 403;
        res.end('session scope mismatch');
        return;
      }
      session.lastSeen = Date.now();
      this.openSse(session, res);
      return;
    }

    if (req.method === 'DELETE') {
      // Ending a session disposes its layer drafts — destructive, so the
      // caller must present the same scope identity the session was bound
      // to; a leaked session id alone must not destroy another principal's
      // unpublished work.
      if (sessionId) {
        const session = this.sessions.get(sessionId);
        if (session && !sameScope(session.scope, scope)) {
          res.statusCode = 403;
          res.end('session scope mismatch');
          return;
        }
        this.endSession(sessionId);
      }
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end('Method Not Allowed');
      return;
    }

    const body = await readBody(req, this.opts.maxBodyBytes ?? 32 * 1024 * 1024);
    const message = parseMessage(body);
    if (!message) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(errorResponse(null, JsonRpcErrorCode.ParseError, 'Failed to parse JSON-RPC')));
      return;
    }

    let session: Session;
    if (sessionId && this.sessions.has(sessionId)) {
      session = this.sessions.get(sessionId) as Session;
      // The session was bound to a specific scope/principal at initialize.
      // A leaked Mcp-Session-Id must NOT be reusable by a caller whose
      // current token has different (narrower OR wider) access — accepting
      // a wider token would silently downgrade and accepting a narrower
      // one would leak the original privileges. Require an exact scope
      // identity match and reject otherwise.
      if (!sameScope(session.scope, scope)) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'session scope mismatch' }));
        return;
      }
      // After the identity check: a refused caller must not keep another
      // principal's session from ever looking idle.
      session.lastSeen = Date.now();
    } else {
      // Per spec, `initialize` is the only request allowed without a session;
      // the response carries the new Mcp-Session-Id.
      const isInitialize = (message as { method?: string }).method === 'initialize';
      if (!isInitialize) {
        // A session id we do not hold (DELETEd, reclaimed at the cap, never
        // issued) is the spec's 404, the cue to initialize again; none is a 400.
        if (sessionId) return sendUnknownSession(res);
        res.statusCode = 400;
        res.end('Mcp-Session-Id required');
        return;
      }
      if (!this.makeRoomForSession()) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'session-capacity' }));
        return;
      }
      const newId = randomUUID();
      // The factory may await, so concurrent initializes would each pass the
      // capacity check above; count the ones still building.
      this.building++;
      let server: MCPServer;
      try {
        server = await this.opts.sessionFactory.build(scope, newId);
      } finally {
        this.building--;
      }
      // A factory that drops the session id would put every HTTP session
      // on the shared local layer workspace (cross-session reads/writes,
      // no disposal) — refuse the deployment bug instead of running unsafe.
      if (server.sessionId !== newId) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          error: 'sessionFactory must construct the MCPServer with the provided sessionId (createMCPServer({ sessionId }))',
        }));
        return;
      }
      session = { id: newId, server, scope, sseClients: new Set(), createdAt: Date.now(), lastSeen: Date.now(), inFlight: 0 };
      session.server.attach(this.makeSinkFor(session));
      this.sessions.set(newId, session);
      res.setHeader('Mcp-Session-Id', newId);
    }

    const accept = (req.headers.accept ?? '').toLowerCase();
    if (accept.includes('text/event-stream')) {
      // SSE upgrade — used for long-running ops that need progress streaming.
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      session.sseClients.add(res);
      const response = await this.dispatch(session, message);
      if (response) writeSse(res, response);
      // Keep the connection open until client closes; progress notifications
      // arrive via the session's sink.
      req.on('close', () => session.sseClients.delete(res));
      return;
    }

    // Plain JSON response (the common case).
    const response = await this.dispatch(session, message);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(response ? JSON.stringify(response) : '{}');
  }

  /** Run one message; the session counts as busy until it settles, and active when it does. */
  private async dispatch(session: Session, message: JsonRpcMessage): Promise<Awaited<ReturnType<MCPServer['handleMessage']>>> {
    session.inFlight++;
    try {
      return await session.server.handleMessage(message);
    } finally {
      session.inFlight--;
      session.lastSeen = Date.now();
    }
  }

  private openSse(session: Session, res: ServerResponse): void {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.write(': connected\n\n');
    session.sseClients.add(res);
    const ka = setInterval(() => res.write(': keepalive\n\n'), 15_000);
    res.on('close', () => {
      session.sseClients.delete(res);
      // A stream that ran for hours was activity; idle time starts when it ends.
      session.lastSeen = Date.now();
      clearInterval(ka);
    });
  }

  /** Whether a new session fits; at the cap, idle sessions are ended first. */
  private makeRoomForSession(): boolean {
    const max = this.opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
    const need = this.sessions.size + this.building - max + 1;
    if (need <= 0) return true;
    const idleMs = this.opts.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
    for (const id of pickReclaimable(this.sessions, idleMs, need, draftCount)) {
      const drafts = draftCount(id);
      this.endSession(id);
      // eslint-disable-next-line no-console
      console.warn(`[ifc-lite-mcp http] ended session ${id}: idle >= ${idleMs} ms at the ${max}-session limit, ${drafts} unpublished layer draft(s) disposed`);
    }
    return this.sessions.size + this.building < max;
  }

  private endSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const sse of session.sseClients) sse.end();
    session.server.detach();
    this.sessions.delete(sessionId);
  }

  private makeSinkFor(session: Session): OutgoingMessageSink {
    return {
      send: (message: JsonRpcMessage) => {
        // Fan out notifications + responses to every active SSE client.
        for (const sse of session.sseClients) {
          try { writeSse(sse, message); } catch { /* SSE client gone — cleaned up on close */ }
        }
      },
    };
  }
}

// ── Built-in authenticators ──────────────────────────────────────────────

export class BearerTokenAuth implements HttpAuthenticator {
  constructor(private tokens: Map<string, AuthScope>) {}

  authenticate(req: IncomingMessage): AuthScope | null {
    const header = req.headers.authorization ?? '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return null;
    return this.tokens.get(match[1]) ?? null;
  }
}

/** Permissive authenticator for local dev — ALL requests get full scope. */
export class AllowAllAuth implements HttpAuthenticator {
  constructor(private scope: AuthScope) {}
  authenticate(): AuthScope { return this.scope; }
}
