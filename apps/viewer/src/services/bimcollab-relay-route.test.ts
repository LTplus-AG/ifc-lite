/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'vite';
import { bimcollabRelayRoute } from '../../vite-plugins/bimcollab-relay.js';

// Exercise the dev adapter through HTTP, with no BIMcollab network traffic.
test('BIMcollab relay task: Vite uses the real handler and respects route boundaries', async (t) => {
  const realFetch = globalThis.fetch;
  const upstream: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    upstream.push(String(input));
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fake-token');
    assert.equal(new Headers(init?.headers).get('cookie'), null);
    return new Response('model', { headers: { 'content-disposition': 'attachment; filename="a.ifc"', 'set-cookie': 'drop=1' } });
  });
  const vite = await createServer({ configFile: false, appType: 'custom', root: process.cwd(),
    plugins: [bimcollabRelayRoute()], server: { middlewareMode: true, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const server = createHttpServer(vite.middlewares);
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const response = await realFetch(`${base}/api/bimcollab/space/test/download/42`, {
      headers: { authorization: 'Bearer fake-token', cookie: 'browser=1' },
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'model');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('content-disposition'), 'attachment; filename="a.ifc"');
    assert.deepEqual(upstream, ['https://test.bimcollab.com/documents/da/location/0/project/0/documentinstance/download/42']);
    assert.equal((await realFetch(`${base}/api/bimcollab/space/test/download/42`)).status, 401);
    assert.equal((await realFetch(`${base}/api/bimcollabX/space/test/download/42`)).status, 404);
    assert.equal(upstream.length, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await vite.close();
  }
});
