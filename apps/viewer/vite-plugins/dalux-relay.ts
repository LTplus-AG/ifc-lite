/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Plugin } from 'vite';
import { createDaluxRelayHandler, loadDaluxRelayConfig } from '../../../server/sources/dalux-relay';

/**
 * Serve `/api/dalux` in dev with the SAME handler production uses.
 *
 * This replaces a `server.proxy` entry, and the reason is worth keeping. The
 * proxy entry was given a `router` callback to pick the upstream per request
 * once Dalux nodes became configurable (#2792). **Vite has no `router` option**
 * — it uses `http-proxy-3`, while `router` belongs to `http-proxy-middleware`,
 * a different package. The string does not occur anywhere in Vite's shipped
 * dist, so the callback was silently ignored and a developer on node2 running
 * `pnpm dev` still reached the default upstream.
 *
 * The deeper problem was having a second implementation at all: dev routed
 * through a hand-written proxy config while production routed through the
 * handler, so the two could disagree, and the test exercised the shared helper
 * directly without ever going through Vite — which is exactly why the dead
 * option was invisible.
 *
 * Running the real handler here removes that whole divergence class. The path
 * allowlist, the node allowlist, the header filtering and the off-host redirect
 * refusal are now the same code in both environments rather than two things
 * that have to be kept in step.
 */
export function daluxRelayRoute(): Plugin {
  return {
    name: 'ifc-lite-dalux-relay',
    configureServer(server) {
      const handler = createDaluxRelayHandler(loadDaluxRelayConfig(process.env), {
        fetchImpl: (...args) => fetch(...args),
      });

      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        // Match the path BOUNDARY, not the prefix: a bare `startsWith` also
        // claims `/api/dalux5.1/projects`, and the handler would then strip
        // `/api/dalux` and relay `5.1/projects` from an unrelated route
        // instead of passing it on.
        const path = url.split('?')[0];
        if (path !== '/api/dalux' && !path.startsWith('/api/dalux/')) return next();

        void (async () => {
          try {
            const headers = new Headers();
            for (const [k, v] of Object.entries(req.headers)) {
              if (typeof v === 'string') headers.set(k, v);
              else if (Array.isArray(v)) headers.set(k, v.join(', '));
            }
            // GET/HEAD/OPTIONS only reach the relay, so there is no body to
            // forward; the handler rejects every other method itself.
            const response = await handler(
              new Request(`http://localhost${url}`, { method: req.method ?? 'GET', headers }),
            );
            res.statusCode = response.status;
            response.headers.forEach((value, key) => res.setHeader(key, value));
            // STREAM rather than buffer. The proxy this replaces streamed, and
            // the relay's biggest response by far is a revision's file content:
            // buffering would materialise a whole IFC in the Vite process
            // before sending a byte, while the browser-side client then
            // materialises its own copy. Replacing a streaming path with a
            // buffering one is a regression even in dev, where the models are
            // the same size they are anywhere else.
            if (response.body) Readable.fromWeb(response.body as WebReadableStream).pipe(res);
            else res.end();
          } catch (err) {
            res.statusCode = 502;
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        })();
      });
    },
  };
}
