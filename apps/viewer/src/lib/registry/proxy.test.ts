/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createViteServer } from 'vite';
import { registryProxy } from '../../../registry-proxy';

test('registry proxy isolates cookies and never serves the credential page on the viewer origin (#8310)', async () => {
  const calls: { path: string; cookie?: string; host?: string; body: string }[] = [];
  const upstream = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    calls.push({ path: request.url ?? '', cookie: request.headers.cookie, host: request.headers.host, body });
    response.setHeader('Set-Cookie', ['registry-only=must-not-reach-viewer; HttpOnly',
      'ifcx_oci_refresh=rotated; Path=/oauth/; HttpOnly; SameSite=Strict',
      'ifcx_oci_refresh=foreign; Path=/oauth/; HttpOnly; SameSite=Strict; Domain=example.com']);
    response.setHeader('Content-Type', 'application/json');
    if (request.url?.startsWith('/v2/')) response.setHeader('Location', `http://${request.headers.host}/v2/project/model/blobs/uploads/test`);
    response.end(JSON.stringify({ host: request.headers.host }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const bound = upstream.address(); assert(bound && typeof bound !== 'string');
  const target = `http://127.0.0.1:${bound.port}`;
  const root = await mkdtemp(join(tmpdir(), 'ifclite-oauth-proxy-'));
  const vite = await createViteServer({ configFile: false, root, publicDir: false, logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, proxy: registryProxy(target) } });
  try {
    await vite.listen();
    const address = vite.httpServer?.address(); assert(address && typeof address !== 'string');
    const viewer = `http://127.0.0.1:${address.port}`;
    const config = await fetch(`${viewer}/oauth/config?discovery=1`, { headers: { Cookie: 'viewer-only=private; ifcx_oci_refresh=private' } });
    assert.equal(config.status, 200); assert.equal(config.headers.has('set-cookie'), false);
    assert.deepEqual(await config.json(), { host: new URL(target).host });
    const grant = new URLSearchParams({ grant_type: 'authorization_code', code: 'test-code', code_verifier: 'test-verifier' });
    const token = await fetch(`${viewer}/oauth/token`, { method: 'POST', body: grant, headers: { Cookie: 'viewer-only=private; ifcx_oci_refresh=remembered' } });
    assert.equal(token.status, 200); assert.equal(calls[1].body, grant.toString());
    assert.equal(calls[0].cookie, undefined); assert.equal(calls[1].cookie, 'ifcx_oci_refresh=remembered');
    assert.equal(token.headers.get('set-cookie'), 'ifcx_oci_refresh=rotated; Path=/oauth/; HttpOnly; SameSite=Strict');
    const upload = await fetch(`${viewer}/v2/project/model/blobs/uploads/`, { method: 'POST' });
    assert.equal(upload.headers.get('location'), '/v2/project/model/blobs/uploads/test');
    assert.equal(upload.headers.has('set-cookie'), false); assert.equal(calls[2].cookie, undefined);
    await fetch(`${viewer}/oauth/revoke`, { method: 'POST', body: new URLSearchParams({ client_id: 'ifc-lite' }), headers: { Cookie: 'other=private; ifcx_oci_refresh=rotated' } });
    assert.equal(calls[3].cookie, 'ifcx_oci_refresh=rotated');
    await fetch(`${viewer}/oauth/token`, { method: 'POST', body: grant, headers: { Cookie: 'ifcx_oci_refresh=a; ifcx_oci_refresh=b' } });
    assert.equal(calls[4].cookie, undefined, 'duplicate cookie names are ambiguous and are not forwarded');
    assert.equal(calls.length, 5);
    for (const path of ['/oauth/authorize', '/oauth/configuration', '/oauth/token/other', '/oauth/revoke/other', '/oauth/registry/callback', '/token']) {
      await fetch(`${viewer}${path}`);
    }
    assert.equal(calls.length, 5, 'credential pages, callbacks and legacy Basic token requests never reach the proxy target');
  } finally {
    await vite.close();
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
