/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where the viewer server listens, and who it answers.
 *
 * A page on another site can still send requests to it even though CORS
 * stops that page reading the answers, and a DNS-rebound name could read
 * them too. So the server refuses any request whose Host is not a loopback
 * name, and any POST sent from a page that is not local. The Host port is not
 * checked: a tunnel (`ssh -L 9000:127.0.0.1:3456`) forwards from another
 * port, and a rebound name is caught by its name alone.
 */

import type { IncomingMessage } from 'node:http';

/**
 * The address the viewer server binds. Clients dial it rather than
 * `localhost`, which may resolve to ::1, where another process can hold the
 * same port.
 */
export const VIEWER_HOST = '127.0.0.1';

/** `http://127.0.0.1:<port><path>`: the viewer server's own URL. */
export function viewerUrl(port: number, path = ''): string {
  return `http://${VIEWER_HOST}:${port}${path}`;
}

/** `localhost` or `127.0.0.1`, with or without a port. */
const LOOPBACK = String.raw`(localhost|127\.0\.0\.1)(:\d+)?`;
const LOOPBACK_HOST = new RegExp(`^${LOOPBACK}$`, 'i');
/** A page served from this machine. */
const LOCAL_ORIGIN = new RegExp(`^https?://${LOOPBACK}$`);

export type RequestVerdict = { refuse: true } | { refuse: false; corsOrigin: string | null };

/** Refuse `req`, or serve it, echoing its Origin for CORS when that is a local page. */
export function checkRequest(req: IncomingMessage): RequestVerdict {
  if (!LOOPBACK_HOST.test(req.headers.host ?? '')) return { refuse: true };
  const origin = req.headers.origin;
  if (origin === undefined) return { refuse: false, corsOrigin: null }; // the CLI, the MCP server: not a page
  const local = LOCAL_ORIGIN.test(origin);
  if (!local && req.method === 'POST') return { refuse: true };
  return { refuse: false, corsOrigin: local ? origin : null };
}
