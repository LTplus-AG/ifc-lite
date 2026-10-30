/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { loadEnv, type Plugin } from 'vite';
import { createBuildagilRelayHandler, loadBuildagilRelayConfig } from '../../../server/sources/buildagil-relay';

/**
 * Dev serves `/api/buildagil/*` with the production handler
 * (`api/buildagil.ts`). The client secret comes from the shell env or the
 * untracked `apps/viewer/.env.local` (`BUILDAGIL_CLIENT_SECRET=...`); only the
 * `BUILDAGIL_` prefix is loaded, in this Node process, so it never reaches the
 * browser. buildagil registered `http://localhost:5000/oauth/bcf/callback`, so
 * sign in with the dev server on port 5000.
 */
export function buildagilRelayRoute(): Plugin {
  return {
    name: 'ifc-lite-buildagil-relay',
    configureServer(server) {
      const env = { ...loadEnv(server.config.mode, server.config.envDir, 'BUILDAGIL_'), ...process.env };
      const handler = createBuildagilRelayHandler(loadBuildagilRelayConfig(env), {
        fetchImpl: (...args) => fetch(...args),
      });

      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        // Path boundary, not prefix: `/api/buildagilX` is another route.
        const path = url.split('?')[0];
        if (path !== '/api/buildagil' && !path.startsWith('/api/buildagil/')) return next();

        void (async () => {
          try {
            const headers = new Headers();
            for (const [k, v] of Object.entries(req.headers)) {
              if (typeof v === 'string') headers.set(k, v);
              else if (Array.isArray(v)) headers.set(k, v.join(', '));
            }
            // Token grants and search are POSTs; the handler caps their bodies.
            const method = req.method ?? 'GET';
            const hasBody = method === 'POST';
            const response = await handler(new Request(`http://localhost${url}`, {
              method,
              headers,
              body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
              duplex: 'half',
            } as RequestInit & { duplex: 'half' }));
            res.statusCode = response.status;
            response.headers.forEach((value, key) => res.setHeader(key, value));
            // Preserve backpressure for large model downloads.
            if (response.body) {
              const body = Readable.fromWeb(response.body as WebReadableStream);
              body.on('error', (error: Error) => res.destroy(error));
              res.on('close', () => body.destroy());
              body.pipe(res);
            } else res.end();
          } catch (err) {
            console.warn('[buildagil-relay] dev middleware failed', err instanceof Error ? err.name : err);
            res.statusCode = 502;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ error: 'relay_failed' }));
          }
        })();
      });
    },
  };
}
