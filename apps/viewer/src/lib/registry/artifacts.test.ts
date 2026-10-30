/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createServer } from 'node:http';
import { Window } from 'happy-dom';
import { installRegistryPopup, registryCallback, registryOAuthConfig, registryTokenReply } from '@/test/registry-oauth-fixture';
import { RegistryArtifacts, OCI_MANIFEST_TYPE, sha256 } from './artifacts';
import { RegistryError } from './protocol';
import { RegistryTransport } from './transport';

// Preserve Node's HTTP fetch while supplying the popup's browser surface.
const browserWindow = new Window({ url: 'http://localhost/' });
Object.defineProperty(globalThis, 'window', { configurable: true, value: browserWindow });
Object.defineProperty(globalThis, 'DOMParser', { configurable: true, value: browserWindow.DOMParser });

async function registryFixture(context: TestContext) {
  const replies = new Map<string, { body: string | Uint8Array<ArrayBuffer>; status?: number; headers?: Record<string, string> }>();
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? '';
    requests.push(path);
    if (path === '/oauth/config') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(registryOAuthConfig(`http://${request.headers.host}`)));
    } else if (path === '/oauth/token') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(registryTokenReply()));
    } else {
      const reply = replies.get(path);
      response.writeHead(reply?.status ?? (reply ? 200 : 404), reply?.headers);
      response.end(reply?.body);
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const popup = installRegistryPopup(registryCallback);
  context.after(popup.restore);
  const address = server.address(); assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const transport = new RegistryTransport(origin, origin);
  context.after(() => transport.logout());
  await transport.login('project/model');
  const source = new TextEncoder().encode('ISO-10303-21; editable IFC source');
  const layer = { mediaType: 'application/x-step', digest: await sha256(source), size: source.length };
  const manifest = { schemaVersion: 2, mediaType: OCI_MANIFEST_TYPE, config: layer, layers: [layer] };
  replies.set(`/v2/project/model/blobs/${layer.digest}`, { body: source });
  return { artifacts: new RegistryArtifacts(transport), replies, requests, source, layer, manifest };
}

test('one unreadable tag cannot hide valid releases or an IFC beside a large derived layer (#8310)', async context => {
  const fixture = await registryFixture(context);
  const { artifacts, replies, manifest, layer } = fixture;
  const bodies: Record<string, string> = {
    v1: JSON.stringify(manifest),
    index: JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [] }),
    docker: JSON.stringify({ ...manifest, mediaType: 'application/vnd.docker.distribution.manifest.v2+json' }),
    malformed: '{',
    invalid: JSON.stringify({ ...manifest, layers: [{ ...layer, size: -1 }] }),
    corrupt: JSON.stringify(manifest),
    gone: '',
    incompatible: '',
    v2: JSON.stringify({ ...manifest, layers: [layer, { ...layer, mediaType: 'model/gltf-binary', size: 512 * 1024 * 1024 + 1 }] }),
  };
  replies.set('/v2/project/model/tags/list', { body: JSON.stringify({ tags: Object.keys(bodies) }) });
  for (const [tag, body] of Object.entries(bodies)) replies.set(`/v2/project/model/manifests/${tag}`, { body });
  replies.set('/v2/project/model/manifests/corrupt', { body: bodies.corrupt, headers: { 'Docker-Content-Digest': `sha256:${'0'.repeat(64)}` } });
  replies.set('/v2/project/model/manifests/gone', { body: '', status: 404 });
  replies.set('/v2/project/model/manifests/incompatible', { body: '', status: 406 });
  assert.deepEqual((await artifacts.releases('project/model')).map(release => release.tag), ['v2', 'v1']);
  assert.deepEqual((await artifacts.pull('project/model', 'v2')).bytes, fixture.source);
  await assert.rejects(artifacts.pull('project/model', 'index'), /supported OCI/);
  await assert.rejects(artifacts.pull('project/model', 'corrupt'), /fingerprint/);
});

test('the IFC size cap applies before fetching the selected source, while metadata remains browsable (#8310)', async context => {
  const { artifacts, replies, requests, manifest, layer } = await registryFixture(context);
  replies.set('/v2/project/model/tags/list', { body: JSON.stringify({ tags: ['oversized'] }) });
  replies.set('/v2/project/model/manifests/oversized', {
    body: JSON.stringify({ ...manifest, layers: [{ ...layer, size: 512 * 1024 * 1024 + 1 }] }),
  });
  assert.deepEqual((await artifacts.releases('project/model')).map(release => release.tag), ['oversized']);
  await assert.rejects(artifacts.pull('project/model', 'oversized'), /512 MiB/);
  assert.equal(requests.some(path => path.includes('/blobs/')), false, 'oversized IFC bytes are never requested');
});

test('release listing preserves authorization, server, and cancellation failures (#8310)', async context => {
  for (const status of [401, 403, 500, 503]) await context.test(`HTTP ${status}`, async scenario => {
    const { artifacts, replies, manifest } = await registryFixture(scenario);
    replies.set('/v2/project/model/tags/list', { body: JSON.stringify({ tags: ['good', 'failed'] }) });
    replies.set('/v2/project/model/manifests/good', { body: JSON.stringify(manifest) });
    replies.set('/v2/project/model/manifests/failed', { body: '', status });
    await assert.rejects(artifacts.releases('project/model'), (error: unknown) => error instanceof RegistryError && error.status === status);
  });
  const { artifacts, replies, manifest } = await registryFixture(context);
  replies.set('/v2/project/model/tags/list', { body: JSON.stringify({ tags: ['good', 'failed'] }) });
  replies.set('/v2/project/model/manifests/good', { body: JSON.stringify(manifest) });
  const controller = new AbortController();
  const originalFetch = globalThis.fetch;
  context.mock.method(globalThis, 'fetch', (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input).endsWith('/manifests/failed')) controller.abort();
    return originalFetch(input, init);
  });
  await assert.rejects(artifacts.releases('project/model', controller.signal), { name: 'AbortError' });
});
