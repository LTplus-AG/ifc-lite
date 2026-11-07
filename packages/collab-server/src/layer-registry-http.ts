/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type * as http from 'node:http';

/**
 * Registry credentials are `Authorization: Bearer` ONLY — no `?token=`
 * fallback. A query-string secret leaks via access logs, reverse proxies,
 * traces, and copied URLs (same reasoning as the /metrics endpoint; the
 * websocket path keeps `?token=` only because browsers cannot set
 * handshake headers, which does not apply to registry API clients).
 */
export function extractToken(req: http.IncomingMessage): string | undefined {
  const header = req.headers['authorization'];
  if (typeof header === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (m) return m[1];
  }
  return undefined;
}

export function json(res: http.ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

export async function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.byteLength;
    if (total > maxBytes) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/** Parse JSON, surfacing the failure reason instead of swallowing it. */
export function parseJson(text: string): { value?: unknown; error?: string } {
  try {
    return { value: JSON.parse(text) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
