/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Who the loopback-only viewer server answers.
 *
 * A page on another site can still send requests to it even though CORS
 * stops that page reading the answers, and a DNS-rebound name could read
 * them too. So the server refuses any request whose Host is not its own
 * loopback name and port, and any POST sent from a page that is not local.
 */

import type { IncomingMessage } from 'node:http';

/** A page served from this machine: `http(s)://localhost` or `127.0.0.1`, any port. */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/** The Host values a server listening on 127.0.0.1:`port` answers to. Clients leave the default port out. */
export function ownHosts(port: number): ReadonlySet<string> {
  return new Set(['localhost', '127.0.0.1'].flatMap((h) => (port === 80 ? [h, `${h}:80`] : [`${h}:${port}`])));
}

/** The request's Origin when it is a local page (CORS may echo it), else null. */
export function localOrigin(req: IncomingMessage): string | null {
  const origin = req.headers.origin;
  return origin !== undefined && LOCAL_ORIGIN.test(origin) ? origin : null;
}

/** True when the server must refuse `req` outright. */
export function refuseRequest(req: IncomingMessage, hosts: ReadonlySet<string>): boolean {
  if (!hosts.has(req.headers.host?.toLowerCase() ?? '')) return true;
  // Clients that send no Origin (the CLI, the MCP server) are not pages.
  return req.method === 'POST' && req.headers.origin !== undefined && localOrigin(req) === null;
}
