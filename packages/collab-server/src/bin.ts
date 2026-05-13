#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** CLI entry point: `ifc-lite-collab-server`. */

import { FilePersistence, startCollabServer } from './server.js';

const port = Number(process.env.COLLAB_PORT ?? 1234);
const host = process.env.COLLAB_HOST ?? '0.0.0.0';
const dataDir = process.env.COLLAB_DATA_DIR ?? './.collab-data';
const maxRooms = Number(process.env.COLLAB_MAX_ROOMS ?? 1024);

async function main() {
  const handle = await startCollabServer({
    port,
    host,
    persistence: new FilePersistence({ dataDir }),
    maxRooms,
  });
  // eslint-disable-next-line no-console
  console.log(`[collab-server] listening at ${handle.url} (data: ${dataDir})`);

  const shutdown = async () => {
    // eslint-disable-next-line no-console
    console.log('[collab-server] shutting down…');
    await handle.stop();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[collab-server] fatal:', err);
  process.exit(1);
});
