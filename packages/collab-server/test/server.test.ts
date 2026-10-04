/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { WebSocket } from 'ws';
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
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);

    await handle.stop();
  });

  it('answers a request target `new URL` rejects with 400, not 500', async () => {
    const handle = await startCollabServer({ port: 0, persistence: new MemoryPersistence() });
    const { port } = handle.httpServer.address() as { port: number };
    try {
      const status = await new Promise<number>((resolve, reject) => {
        // `//` is the shortest request-target that `new URL('//', base)` rejects.
        const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '//' }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(400);
      // The server keeps serving everyone else.
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    } finally {
      await handle.stop();
    }
  });

  it('closes a websocket whose room path is a malformed percent-escape with 4400', async () => {
    const handle = await startCollabServer({ port: 0, persistence: new MemoryPersistence() });
    const { port } = handle.httpServer.address() as { port: number };
    try {
      const code = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/%E0%A4%A`);
        ws.on('close', (c) => resolve(c));
        ws.on('error', reject);
      });
      expect(code).toBe(4400);
    } finally {
      await handle.stop();
    }
  });
});
