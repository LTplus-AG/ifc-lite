/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Request-level helpers for the Streamable HTTP transport (`http.ts`). */

import type { ServerResponse } from 'node:http';
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
   * (when `maxSessions` is reached), never on a timer. Default 30 minutes, the
   * idle window those same services use.
   */
  sessionIdleMs?: number;
}


export const DEFAULT_MAX_SESSIONS = 1000;
export const DEFAULT_SESSION_IDLE_MS = 30 * 60_000;

/**
 * End every session with no request for `idleMs` and no open SSE stream.
 * `Session` here is structural: `http.ts` owns the full type.
 */
export function reclaimIdleSessions(
  sessions: ReadonlyMap<string, { sseClients: { size: number }; lastSeen: number }>,
  idleMs: number,
  end: (id: string) => void,
): void {
  const now = Date.now();
  for (const [id, session] of [...sessions]) {
    if (session.sseClients.size === 0 && now - session.lastSeen >= idleMs) end(id);
  }
}
