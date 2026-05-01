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

  constructor(opts: HttpTransportOptions) {
    this.opts = opts;
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
    setCors(res);
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

function setCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
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
