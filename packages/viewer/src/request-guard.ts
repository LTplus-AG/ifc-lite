/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where the viewer server listens, and who it answers.
 *
 * A page on another site can still send requests to it even though CORS
 * stops that page reading the answers, and a DNS-rebound name could read
 * them too. So the server refuses any request whose Host is not its own
 * loopback name and port, and any POST sent from a page that is not local.
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

/** A page served from this machine: `http(s)://localhost` or `127.0.0.1`, any port. */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export type RequestVerdict = { refuse: true } | { refuse: false; corsOrigin: string | null };

/** Refuse `req`, or serve it, echoing its Origin for CORS when that is a local page. */
export function checkRequest(req: IncomingMessage, port: number): RequestVerdict {
  const host = req.headers.host?.toLowerCase();
  // Clients leave the default port out of Host.
  const ownHost = ['localhost', VIEWER_HOST].some((h) => host === `${h}:${port}` || (port === 80 && host === h));
  if (!ownHost) return { refuse: true };
  const origin = req.headers.origin;
  if (origin === undefined) return { refuse: false, corsOrigin: null }; // the CLI, the MCP server: not a page
  const local = LOCAL_ORIGIN.test(origin);
  if (!local && req.method === 'POST') return { refuse: true };
  return { refuse: false, corsOrigin: local ? origin : null };
}
