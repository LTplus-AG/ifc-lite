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

export interface HttpAuthenticator {
  /**
   * Called for every inbound request. Returns the auth scope for the caller,
   * or null/undefined if the request must be rejected with 401.
   */
  authenticate(req: IncomingMessage): Promise<AuthScope | null> | AuthScope | null;
}

export interface SessionFactory {
  /** Build a fresh MCPServer for this session. Called on `initialize`. */
  build(scope: AuthScope, sessionId: string): Promise<MCPServer> | MCPServer;
}

export interface HttpTransportOptions {
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
}

export class HttpTransport {
  private server: Server;
  private sessions = new Map<string, Session>();
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
      // Open an SSE channel for an existing session.
      if (!sessionId || !this.sessions.has(sessionId)) {
        res.statusCode = 404;
        res.end('Unknown session');
        return;
      }
      this.openSse(this.sessions.get(sessionId) as Session, res);
      return;
    }

    if (req.method === 'DELETE') {
      if (sessionId) this.endSession(sessionId);
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
    } else {
      // Per spec, `initialize` is the only request allowed without a session;
      // the response carries the new Mcp-Session-Id.
      const isInitialize = (message as { method?: string }).method === 'initialize';
      if (!isInitialize) {
        res.statusCode = 400;
        res.end('Mcp-Session-Id required');
        return;
      }
      const newId = randomUUID();
      const server = await this.opts.sessionFactory.build(scope, newId);
      session = { id: newId, server, scope, sseClients: new Set(), createdAt: Date.now() };
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
      const response = await session.server.handleMessage(message);
      if (response) writeSse(res, response);
      // Keep the connection open until client closes; progress notifications
      // arrive via the session's sink.
      req.on('close', () => session.sseClients.delete(res));
      return;
    }

    // Plain JSON response (the common case).
    const response = await session.server.handleMessage(message);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(response ? JSON.stringify(response) : '{}');
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
      clearInterval(ka);
    });
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

/**
 * Strict scope identity check used when reusing an HTTP session — both the
 * permission set and any narrowing (model_ids, user, session) must match
 * what the session was created with. We sort the scopes set so callers
 * that pass them in different orders still compare equal.
 */
function sameScope(a: AuthScope, b: AuthScope): boolean {
  if (a === b) return true;
  if (a.user !== b.user || a.session !== b.session) return false;
  const as = [...a.scopes].sort();
  const bs = [...b.scopes].sort();
  if (as.length !== bs.length || as.some((s, i) => s !== bs[i])) return false;
  const am = a.modelIds ? [...a.modelIds].sort() : undefined;
  const bm = b.modelIds ? [...b.modelIds].sort() : undefined;
  if ((am?.length ?? 0) !== (bm?.length ?? 0)) return false;
  if (am && bm && am.some((m, i) => m !== bm[i])) return false;
  return true;
}

/**
 * Reflect CORS headers ONLY when the request carries an Origin we explicitly
 * allow. We never emit a wildcard `Access-Control-Allow-Origin` — that would
 * let any web page read JSON-RPC responses cross-origin. When `origin` is not
 * allowlisted we emit no CORS headers, so the browser blocks the response.
 */
function setCors(res: ServerResponse, origin: string | undefined, allowed: Set<string>): void {
  if (!origin || !allowed.has(origin)) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
}

/**
 * Extract the host name from a `Host` header, stripping the port. Handles the
 * bracketed IPv6 literal form (`[::1]:8765` -> `::1`).
 */
function parseHostHeader(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 ? value.slice(1, end) : value;
  }
  return value.split(':')[0];
}

function writeSse(res: ServerResponse, message: unknown): void {
  res.write(`data: ${JSON.stringify(message)}\n\n`);
}

async function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > max) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
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
