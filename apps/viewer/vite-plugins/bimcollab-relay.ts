/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Plugin } from 'vite';
import { createBimcollabRelayHandler, loadBimcollabRelayConfig } from '../../../server/sources/bimcollab-relay';

/** Dev uses the production handler and streams large model downloads. */
export function bimcollabRelayRoute(): Plugin {
  return {
    name: 'ifc-lite-bimcollab-relay',
    configureServer(server) {
      const handler = createBimcollabRelayHandler(loadBimcollabRelayConfig(process.env), {
        fetchImpl: (...args) => fetch(...args),
      });

      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        // Match the path BOUNDARY, not the prefix: a bare `startsWith` also
        // claims `/api/bimcollab5.1/projects`, and the handler would then strip
        // `/api/bimcollab` and relay `5.1/projects` from an unrelated route
        // instead of passing it on.
        const path = url.split('?')[0];
        if (path !== '/api/bimcollab' && !path.startsWith('/api/bimcollab/')) return next();

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
            // Preserve backpressure for 10–500 MB model downloads.
            if (response.body) {
              const body = Readable.fromWeb(response.body as WebReadableStream);
              body.on('error', (error: Error) => res.destroy(error));
              res.on('close', () => body.destroy());
              body.pipe(res);
            }
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
