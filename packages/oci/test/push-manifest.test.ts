/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildImageManifest, OciClient, parseReference, type OciDescriptor } from '../src/index.js';
import { closeAll, sha256, startServer, type FakeServer } from './fake-registry.js';
import { ociFailure, pushRegistry } from './push-registry.js';

afterEach(closeAll);

const insecure = ['127.0.0.1'];
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const ARTIFACT = 'application/vnd.example.model';
// A committed IFC sample from a real authoring tool: the round trip must be byte-exact.
const IFC = new Uint8Array(readFileSync(fileURLToPath(new URL('../../../apps/viewer/public/samples/building-architecture.ifc', import.meta.url))));

function ref(server: FakeServer, tag = 'v1') {
  return parseReference(`${server.host}/team/model:${tag}`, { insecureHosts: insecure });
}

function client(): OciClient {
  return new OciClient({ insecureHosts: insecure });
}

function layerOf(bytes: Uint8Array, title: string): OciDescriptor {
  return { mediaType: 'application/x-step', digest: sha256(bytes), size: bytes.length, annotations: { 'org.opencontainers.image.title': title } };
}

/** Pushes the empty config and one layer, and builds a manifest over them. */
async function publishable(server: FakeServer, c: OciClient, layer = IFC) {
  await c.pushEmptyConfig(ref(server));
  await c.pushBlob(ref(server), layer);
  return buildImageManifest({ artifactType: ARTIFACT, layers: [layerOf(layer, 'model.ifc')] });
}

describe('buildImageManifest', () => {
  it('is deterministic: the same input in any key order gives the same bytes and digest', async () => {
    const a = await buildImageManifest({
      artifactType: ARTIFACT,
      layers: [{ mediaType: 'application/x-step', digest: sha256(IFC), size: IFC.length, annotations: { b: '2', a: '1' } }],
      annotations: { 'org.opencontainers.image.created': '2026-01-01T00:00:00Z', 'org.example.rev': 'b' },
    });
    const b = await buildImageManifest({
      annotations: { 'org.example.rev': 'b', 'org.opencontainers.image.created': '2026-01-01T00:00:00Z' },
      layers: [{ annotations: { a: '1', b: '2' }, size: IFC.length, digest: sha256(IFC), mediaType: 'application/x-step' }],
      artifactType: ARTIFACT,
    });
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    expect(a.digest).toBe(b.digest);
    expect(a.digest).toBe(sha256(a.bytes));
    expect(a.mediaType).toBe(OCI_MANIFEST);
    const doc = JSON.parse(new TextDecoder().decode(a.bytes));
    expect(doc.config).toEqual({
      mediaType: 'application/vnd.oci.empty.v1+json',
      digest: sha256('{}'),
      size: 2,
    });
    expect(Object.keys(doc.layers[0].annotations)).toEqual(['a', 'b']);
  });

  it('needs artifactType when the config is the empty descriptor', async () => {
    await expect(buildImageManifest({ layers: [] })).rejects.toThrow(/artifactType/);
  });

  it('rejects a malformed layer descriptor', async () => {
    await expect(buildImageManifest({ artifactType: ARTIFACT, layers: [{ mediaType: 'x', digest: 'nope', size: 1 }] })).rejects.toThrow(TypeError);
  });
});

describe('pushManifest', () => {
  it('round trip: config, layer and manifest pushed, then pulled back byte for byte', async () => {
    const { handler, store } = pushRegistry();
    const reg = await startServer(handler);
    const c = client();
    const built = await publishable(reg, c);

    const pushed = await c.pushManifest(ref(reg), built.bytes, built.mediaType);

    expect(pushed.digest).toBe(built.digest);
    expect(store.tags.get('v1')).toBe(built.digest);
    const put = reg.requests.find((r) => r.method === 'PUT' && r.url === '/v2/team/model/manifests/v1');
    expect(put?.contentType).toBe(OCI_MANIFEST);

    const pulled = await c.manifest(ref(reg));
    expect(pulled.digest).toBe(built.digest);
    expect(Buffer.from(pulled.bytes).equals(Buffer.from(built.bytes))).toBe(true);
    if (pulled.value.kind !== 'manifest') throw new Error('expected an image manifest');
    expect(pulled.value.artifactType).toBe(ARTIFACT);
    const config = await c.blob(ref(reg), pulled.value.config, { maxBytes: 16 });
    expect(new TextDecoder().decode(config)).toBe('{}');
    const layer = await c.blob(ref(reg), pulled.value.layers[0], { maxBytes: IFC.length });
    expect(Buffer.from(layer).equals(Buffer.from(IFC))).toBe(true);
  });

  it('refuses to replace an existing tag (TAG_EXISTS) and sends no PUT', async () => {
    const { handler, store } = pushRegistry();
    const reg = await startServer(handler);
    const c = client();
    const first = await publishable(reg, c);
    await c.pushManifest(ref(reg), first.bytes, first.mediaType);
    const second = await publishable(reg, c, new TextEncoder().encode('revision b'));
    reg.requests.length = 0;

    const err = await ociFailure(c.pushManifest(ref(reg), second.bytes, second.mediaType));

    expect(err.code).toBe('TAG_EXISTS');
    expect(store.tags.get('v1')).toBe(first.digest);
    expect(reg.requests.map((r) => `${r.method} ${r.url}`)).toEqual(['HEAD /v2/team/model/manifests/v1']);
  });

  it('replaces an existing tag with allowOverwrite, without checking it first', async () => {
    const { handler, store } = pushRegistry();
    const reg = await startServer(handler);
    const c = client();
    const first = await publishable(reg, c);
    await c.pushManifest(ref(reg), first.bytes, first.mediaType);
    const second = await publishable(reg, c, new TextEncoder().encode('revision b'));
    reg.requests.length = 0;

    const pushed = await c.pushManifest(ref(reg), second.bytes, second.mediaType, { allowOverwrite: true });

    expect(pushed.digest).toBe(second.digest);
    expect(store.tags.get('v1')).toBe(second.digest);
    expect(reg.requests.map((r) => r.method)).toEqual(['PUT']);
  });

  it('pushes by digest when the reference has no tag, with no tag check', async () => {
    const { handler, store } = pushRegistry();
    const reg = await startServer(handler);
    const c = client();
    const built = await publishable(reg, c);
    reg.requests.length = 0;

    const untagged = parseReference(`${reg.host}/team/model`, { insecureHosts: insecure });
    await c.pushManifest(untagged, built.bytes, built.mediaType);

    expect(reg.requests.map((r) => `${r.method} ${r.url}`)).toEqual([`PUT /v2/team/model/manifests/${built.digest}`]);
    expect(store.manifests.has(built.digest)).toBe(true);
    expect(store.tags.size).toBe(0);
  });

  it('a pinned digest that does not match the bytes is DIGEST_MISMATCH before any request', async () => {
    const { handler } = pushRegistry();
    const reg = await startServer(handler);
    const built = await buildImageManifest({ artifactType: ARTIFACT, layers: [] });
    const pinned = parseReference(`${reg.host}/team/model@${sha256('other')}`, { insecureHosts: insecure });
    expect((await ociFailure(client().pushManifest(pinned, built.bytes, built.mediaType))).code).toBe('DIGEST_MISMATCH');
    expect(reg.requests).toHaveLength(0);
  });

  it('a manifest whose mediaType field differs from the argument is refused before any request', async () => {
    const { handler } = pushRegistry();
    const reg = await startServer(handler);
    const built = await buildImageManifest({ artifactType: ARTIFACT, layers: [] });
    await expect(client().pushManifest(ref(reg), built.bytes, 'application/vnd.oci.image.index.v1+json')).rejects.toThrow(/declares mediaType/);
    await expect(client().pushManifest(ref(reg), new TextEncoder().encode('not json'), OCI_MANIFEST)).rejects.toThrow(TypeError);
    expect(reg.requests).toHaveLength(0);
  });

  it('a manifest naming blobs the registry lacks fails with the registry error code', async () => {
    const { handler } = pushRegistry();
    const reg = await startServer(handler);
    const built = await buildImageManifest({ artifactType: ARTIFACT, layers: [layerOf(IFC, 'model.ifc')] });
    const err = await ociFailure(client().pushManifest(ref(reg), built.bytes, built.mediaType));
    expect(err.code).toBe('PROTOCOL');
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/MANIFEST_BLOB_UNKNOWN/);
  });
});
