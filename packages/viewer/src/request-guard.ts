/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Who the viewer server answers.
 *
 * A page on another site can still send requests to it even though CORS
 * stops that page reading the answers, and a DNS-rebound name could read
 * them too. So the server refuses any request whose Host is not a loopback
 * name, and any request sent from a page that is not local. The Host port is not
 * checked: a tunnel (`ssh -L 9000:127.0.0.1:3456`) forwards from another
 * port, and a rebound name is caught by its name alone.
 */

import type { IncomingMessage } from 'node:http';

/** `localhost`, `127.0.0.1` or `[::1]` (a tunnel's local end), with or without a port. */
const LOOPBACK = String.raw`(localhost|127\.0\.0\.1|\[::1\])(:\d+)?`;
const LOOPBACK_HOST = new RegExp(`^${LOOPBACK}$`, 'i');
/** A page served from this machine. */
const LOCAL_ORIGIN = new RegExp(`^https?://${LOOPBACK}$`, 'i');

export type RequestVerdict = { refuse: string } | { refuse: false; corsOrigin: string | null };

/** Refuse `req` (with the reason), or serve it, echoing its Origin for CORS when that is a local page. */
export function checkRequest(req: IncomingMessage): RequestVerdict {
  if (!LOOPBACK_HOST.test(req.headers.host ?? '')) return { refuse: 'Host must be localhost, 127.0.0.1 or [::1]' };
  const origin = req.headers.origin;
  if (origin !== undefined) {
    return LOCAL_ORIGIN.test(origin) ? { refuse: false, corsOrigin: origin } : { refuse: 'Origin is not a local page' };
  }
  // No Origin: the CLI or the MCP server, or a browser following a link or
  // loading an <iframe>. A browser says where it came from in Sec-Fetch-Site;
  // from another site, only opening the viewer page itself is allowed, as a
  // tab or embedded (an IDE's preview pane loads it in an iframe).
  // Browsers without Fetch Metadata (Safari < 16.4) are not covered here.
  const dest = req.headers['sec-fetch-dest'];
  const openingPage = req.method === 'GET' && req.url?.split('?')[0] === '/' && (dest === 'document' || dest === 'iframe');
  if (req.headers['sec-fetch-site'] === 'cross-site' && !openingPage) return { refuse: 'cross-site request' };
  return { refuse: false, corsOrigin: null };
}
