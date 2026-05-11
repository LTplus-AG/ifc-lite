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
  // Build the underlying https.Server with hardened defaults. The
  // collab server attaches its request listener inside startCollabServer.
  const httpsServer = createSecureHttpServer({ ...opts.tls });

  const handle = await startCollabServer({
    ...opts,
    server: httpsServer,
  });

  // After startCollabServer has attached its listeners, wrap each one
  // with the OWASP security-header wrapper so every response gets
  // hardened headers without each route opting in. This is more robust
  // than patching `emit` (which has a window where listeners can fire
  // before the wrapper is in place) and works even if multiple
  // listeners were attached.
  const requestListeners = httpsServer.listeners('request') as Array<
    import('node:http').RequestListener
  >;
  if (requestListeners.length > 0) {
    httpsServer.removeAllListeners('request');
    for (const listener of requestListeners) {
      httpsServer.on('request', secureHttpHandler(listener));
    }
  }

  // startCollabServer skips listening whenever a server is supplied,
  // so this helper always has to bind. The previous gate
  // `if (!opts.port && !opts.host)` skipped listen() any time the
  // caller passed only one of the two (e.g. just `port: 4000`),
  // returning a handle for an unbound server.
  await new Promise<void>((resolve, reject) => {
    httpsServer.once('error', reject);
    httpsServer.listen(opts.port ?? 1234, opts.host ?? '0.0.0.0', () => {
      httpsServer.off('error', reject);
      resolve();
    });
  });

  return handle;
}
