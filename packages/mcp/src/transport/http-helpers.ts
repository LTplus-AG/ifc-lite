/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Request-level helpers for the Streamable HTTP transport (`http.ts`). */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthScope } from '../auth/scope.js';

/**
 * Strict scope identity check used when reusing an HTTP session — both the
 * permission set and any narrowing (model_ids, user, session) must match
 * what the session was created with. We sort the scopes set so callers
 * that pass them in different orders still compare equal.
 */
export function sameScope(a: AuthScope, b: AuthScope): boolean {
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
export function setCors(res: ServerResponse, origin: string | undefined, allowed: Set<string>): void {
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
export function parseHostHeader(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 ? value.slice(1, end) : value;
  }
  return value.split(':')[0];
}

export interface SessionCapacityOptions {
  /**
   * Most concurrent sessions. `initialize` is the only request that creates one
   * and nothing but a `DELETE` removed it, so a client that never ends its
   * sessions (or a loop of `initialize` calls) grew the map, and the per-session
   * `MCPServer` and layer workspace behind it, without limit. At the cap, idle
   * sessions are reclaimed (see `sessionIdleMs`); if none are idle the new
   * `initialize` is refused with 503. Default 1000, the session allowance the
   * cloud and Autodesk services in this repo already use.
   */
  maxSessions?: number;
  /**
   * A session with no request for this long, and no open SSE stream, may be
   * reclaimed to make room for a new one. Reclaiming disposes its unpublished
   * layer drafts, exactly as `DELETE` does, so it happens only under pressure
   * (when `maxSessions` is reached), never on a timer, and takes only as many
   * sessions as the new one needs: oldest first, sessions with no unpublished
   * drafts before sessions that hold some. A session with a request in flight
   * or an open SSE stream is never idle. Default 30 minutes, the idle window
   * those same services use.
   */
  sessionIdleMs?: number;
}

export const DEFAULT_MAX_SESSIONS = 1000;
export const DEFAULT_SESSION_IDLE_MS = 30 * 60_000;

/**
 * The structural slice of `http.ts`'s `Session` the reclaim policy reads.
 */
export interface ReclaimableSession {
  sseClients: { size: number };
  /** Requests currently being handled. */
  inFlight: number;
  lastSeen: number;
}

/**
 * Pick up to `need` sessions to end: idle for `idleMs` (nothing in flight, no
 * open SSE stream), sessions without unpublished drafts first, then oldest
 * `lastSeen` first. Sessions holding drafts are chosen only when too few
 * draft-free idle ones exist, because ending one destroys work that cannot be
 * recovered. Single O(n) scan; allocates only for sessions that qualify.
 */
export function pickReclaimable(
  sessions: ReadonlyMap<string, ReclaimableSession>,
  idleMs: number,
  need: number,
  draftCount: (id: string) => number,
  now: number = Date.now(),
): string[] {
  if (need <= 0) return [];
  const idle: Array<{ id: string; drafts: boolean; lastSeen: number }> = [];
  for (const [id, s] of sessions) {
    if (s.sseClients.size === 0 && s.inFlight === 0 && now - s.lastSeen >= idleMs) {
      idle.push({ id, drafts: draftCount(id) > 0, lastSeen: s.lastSeen });
    }
  }
  idle.sort((a, b) => Number(a.drafts) - Number(b.drafts) || a.lastSeen - b.lastSeen);
  return idle.slice(0, need).map((c) => c.id);
}

/** 404 for a session id we do not hold; tells the client why it may be gone and what to do. */
export function sendUnknownSession(res: ServerResponse): void {
  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    error: 'unknown-session',
    message: 'Unknown session. It was ended with DELETE, or the server ended it after it sat idle while the server was at its session limit (its unpublished layer drafts were disposed). Send initialize without Mcp-Session-Id to start a new session.',
  }));
}

export function writeSse(res: ServerResponse, message: unknown): void {
  res.write(`data: ${JSON.stringify(message)}\n\n`);
}

export async function readBody(req: IncomingMessage, max: number): Promise<string> {
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
