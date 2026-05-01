/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One-call helper that bundles `createSecureHttpServer` + the
 * security-header wrapper + `startCollabServer`. Useful when the
 * deployer wants TLS in-process without writing the wiring.
 *
 * Production deployments terminating TLS at a reverse proxy keep
 * using `startCollabServer` directly.
 */

import {
  createSecureHttpServer,
  secureHttpHandler,
  type SecureHttpServerOptions,
} from './secure-server.js';
import {
  startCollabServer,
  type CollabServerHandle,
  type StartCollabServerOptions,
} from './server.js';

export interface StartSecureCollabServerOptions
  extends Omit<StartCollabServerOptions, 'server'> {
  tls: SecureHttpServerOptions;
}

export async function startSecureCollabServer(
  opts: StartSecureCollabServerOptions,
): Promise<CollabServerHandle> {
  // Build the underlying https.Server with hardened defaults plus an
  // OWASP-baseline header wrapper. The collab server's request
  // listener gets attached after construction by `startCollabServer`,
  // so we leave it undefined here.
  const httpsServer = createSecureHttpServer({ ...opts.tls });
  // Wrap the server's request listener at attach time so every
  // response gets security headers without each route opting in.
  const originalEmit = httpsServer.emit.bind(httpsServer);
  httpsServer.emit = function patchedEmit(event: string, ...args: unknown[]) {
    if (event === 'request') {
      const [req, res] = args as [
        import('node:http').IncomingMessage,
        import('node:http').ServerResponse,
      ];
      // Re-route through the security wrapper. The wrapper applies
      // headers and rejects TRACE/TRACK; the original handler from
      // `startCollabServer` is fetched via the server's listeners
      // below.
      const handler: import('node:http').RequestListener | undefined =
        httpsServer.listeners('request')[0] as
          | import('node:http').RequestListener
          | undefined;
      if (handler) {
        secureHttpHandler(handler)(req, res);
        return true;
      }
    }
    return originalEmit(event, ...(args as Parameters<typeof originalEmit>));
  } as typeof httpsServer.emit;

  const handle = await startCollabServer({
    ...opts,
    server: httpsServer,
  });

  if (!opts.port && !opts.host) {
    // startCollabServer skips listening when a server is supplied —
    // listen here so consumers don't have to do it themselves.
    await new Promise<void>((resolve, reject) => {
      httpsServer.once('error', reject);
      httpsServer.listen(opts.port ?? 1234, opts.host ?? '0.0.0.0', () => {
        httpsServer.off('error', reject);
        resolve();
      });
    });
  }

  return handle;
}
