/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Server } from 'node:http';

/** Abort native process trees and streams before the container/service exits. */
export function installShutdown(server: Server, close: () => void): void {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    close();
    const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 5000);
    deadline.unref();
    server.close(() => { clearTimeout(deadline); process.exit(0); });
    server.closeIdleConnections();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
