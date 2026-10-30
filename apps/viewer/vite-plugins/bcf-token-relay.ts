/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Readable } from 'node:stream';
import { loadEnv, type Plugin } from 'vite';
import {
  createBcfTokenRelayHandler,
  loadBcfTokenRelayConfig,
} from '../../../server/bcf/oauth-token-relay';

/** Route the viewer's `VITE_BCF_APP_BIMCOLLAB_TOKEN_RELAY` points at. */
const RELAY_PATH = '/api/bcf/oauth/token';

/**
 * Serve the BCF token relay (#4919) in dev with the SAME handler production
 * runs (`api/bcf/oauth/token.ts`), the way `dalux-relay.ts` does for Dalux,
 * so the host, grant, redirect and origin allowlists cannot differ between
 * the two.
 *
 * The client secret is read from the shell env or from the untracked
 * `apps/viewer/.env.local` (`BCF_BIMCOLLAB_CLIENT_SECRET=...`). `loadEnv`
 * is asked for the `BCF_` prefix only, and the relay reads it here in the
 * Node process: Vite exposes only `VITE_*` to client code, so the secret is
 * never served to the browser. BIMcollab registered
 * `http://localhost:5000/oauth/bcf/callback`, so run the dev server with
 * `--port 5000` to sign in against the production client.
 */
export function bcfTokenRelayRoute(): Plugin {
  return {
    name: 'ifc-lite-bcf-token-relay',
    configureServer(server) {
      const env = { ...loadEnv(server.config.mode, server.config.envDir, 'BCF_'), ...process.env };
      const handler = createBcfTokenRelayHandler(loadBcfTokenRelayConfig(env), {
        fetchImpl: (...args) => fetch(...args),
      });

      server.middlewares.use((req, res, next) => {
        if ((req.url ?? '').split('?')[0] !== RELAY_PATH) return next();

        void (async () => {
          try {
            const headers = new Headers();
            for (const [k, v] of Object.entries(req.headers)) {
              if (typeof v === 'string') headers.set(k, v);
              else if (Array.isArray(v)) headers.set(k, v.join(', '));
            }
            // The handler caps the body itself, so it reads the request as a
            // stream rather than this buffering it first.
            const method = req.method ?? 'GET';
            const hasBody = method !== 'GET' && method !== 'HEAD';
            const response = await handler(
              new Request(`http://localhost${RELAY_PATH}`, {
                method,
                headers,
                body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
                duplex: 'half',
              } as RequestInit & { duplex: 'half' }),
            );
            res.statusCode = response.status;
            response.headers.forEach((value, key) => res.setHeader(key, value));
            res.end(Buffer.from(await response.arrayBuffer()));
          } catch (err) {
            console.warn('[bcf-token-relay] dev middleware failed', err instanceof Error ? err.name : err);
            res.statusCode = 502;
            res.setHeader('content-type', 'application/json');
            res.setHeader('cache-control', 'no-store');
            res.end(JSON.stringify({ error: 'relay_failed', error_description: 'The dev token relay failed' }));
          }
        })();
      });
    },
  };
}
