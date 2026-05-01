/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { startCollabServer, MemoryPersistence } from '../src/server.js';

describe('collab-server', () => {
  it('starts, exposes /healthz, and stops cleanly', async () => {
    const handle = await startCollabServer({
      port: 0,
      persistence: new MemoryPersistence(),
    });
    const address = handle.httpServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    expect(port).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    await handle.stop();
  });
});
