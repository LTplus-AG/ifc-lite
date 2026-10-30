/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'vite';
import { buildagilRelayRoute } from '../../vite-plugins/buildagil-relay.js';

// The dev adapter over HTTP, with no buildagil traffic: it must forward the
// POST bodies of token grants and searches, and respect its path boundary.
test('buildagil relay task: Vite runs the real handler, forwards POST bodies, and respects route boundaries', async (t) => {
  const realFetch = globalThis.fetch;
  const upstream: { url: string; body: string }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    upstream.push({ url: String(input), body: typeof init?.body === 'string' ? init.body : '' });
    return Response.json(String(input).endsWith('/oauth2/token') ? { access_token: 'at' } : { search_result: [], total_count: 0 });
  });
  const previous = { id: process.env.BUILDAGIL_CLIENT_ID, secret: process.env.BUILDAGIL_CLIENT_SECRET };
  process.env.BUILDAGIL_CLIENT_ID = 'client-1';
  process.env.BUILDAGIL_CLIENT_SECRET = 'dev-secret';
  const vite = await createServer({ configFile: false, appType: 'custom', root: process.cwd(),
    plugins: [buildagilRelayRoute()], server: { middlewareMode: true, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const server = createHttpServer(vite.middlewares);
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const origin = 'http://localhost:5000';

    const search = await realFetch(`${base}/api/buildagil/1.0/search`, {
      method: 'POST', body: '{"search_text":"arc"}',
      headers: { authorization: 'Bearer t', origin, 'content-type': 'application/json' },
    });
    assert.equal(search.status, 200);
    assert.deepEqual(upstream[0], { url: 'https://openapi.buildagil.com/1.0/search', body: '{"search_text":"arc"}' });

    const token = await realFetch(`${base}/api/buildagil/oauth2/token`, {
      method: 'POST', body: 'grant_type=refresh_token&refresh_token=rt&client_id=client-1',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(token.status, 200);
    assert.equal(new URLSearchParams(upstream[1].body).get('client_secret'), 'dev-secret');

    assert.equal((await realFetch(`${base}/api/buildagilX/1.0/projects`)).status, 404);
    assert.equal(upstream.length, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await vite.close();
    for (const [key, value] of [['BUILDAGIL_CLIENT_ID', previous.id], ['BUILDAGIL_CLIENT_SECRET', previous.secret]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
