/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'vitest';
import { OciClient, OciError, parseReference } from '../src/index.js';
import { closeAll, registry, send, sha256, startServer, type FakeServer, type Reply } from './fake-registry.js';

afterEach(closeAll);

const insecure = ['127.0.0.1'];
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';

const CONFIG = '{}';
const LAYER = 'layer bytes';
const MANIFEST_DOC = JSON.stringify({
  schemaVersion: 2,
  mediaType: OCI_MANIFEST,
  artifactType: 'application/vnd.example.model',
  config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: sha256(CONFIG), size: CONFIG.length },
  layers: [
    {
      mediaType: 'application/octet-stream',
      digest: sha256(LAYER),
      size: LAYER.length,
      annotations: { 'org.opencontainers.image.title': 'model.bin' },
    },
  ],
  annotations: { 'org.opencontainers.image.created': '2026-01-01T00:00:00Z' },
});

function client(options: ConstructorParameters<typeof OciClient>[0] = {}): OciClient {
  return new OciClient({ insecureHosts: insecure, ...options });
}

async function serve(routes: Record<string, Reply>): Promise<FakeServer> {
  return startServer(registry({ routes }));
}

async function failure(promise: Promise<unknown>): Promise<OciError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(OciError);
    return err as OciError;
  }
  throw new Error('expected the call to reject');
}

describe('manifest', () => {
  it('accepts a manifest without Docker-Content-Digest and digests the received bytes', async () => {
    const reg = await serve({ '/v2/team/model/manifests/v1': { headers: { 'content-type': OCI_MANIFEST }, body: MANIFEST_DOC } });
    const result = await client().manifest(parseReference(`${reg.host}/team/model:v1`, { insecureHosts: insecure }));
    expect(result.digest).toBe(sha256(MANIFEST_DOC));
    expect(new TextDecoder().decode(result.bytes)).toBe(MANIFEST_DOC);
    expect(result.mediaType).toBe(OCI_MANIFEST);
    expect(result.value).toEqual({
      kind: 'manifest',
      mediaType: OCI_MANIFEST,
      artifactType: 'application/vnd.example.model',
      config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: sha256(CONFIG), size: 2 },
      layers: [
        {
          mediaType: 'application/octet-stream',
          digest: sha256(LAYER),
          size: LAYER.length,
          annotations: { 'org.opencontainers.image.title': 'model.bin' },
        },
      ],
      annotations: { 'org.opencontainers.image.created': '2026-01-01T00:00:00Z' },
    });
    const accept = reg.requests[0].accept ?? '';
    for (const type of [
      OCI_MANIFEST,
      'application/vnd.oci.image.index.v1+json',
      'application/vnd.docker.distribution.manifest.v2+json',
      'application/vnd.docker.distribution.manifest.list.v2+json',
    ]) {
      expect(accept).toContain(type);
    }
  });

  it('accepts a matching Docker-Content-Digest header', async () => {
    const reg = await serve({
      '/v2/team/model/manifests/v1': { headers: { 'docker-content-digest': sha256(MANIFEST_DOC) }, body: MANIFEST_DOC },
    });
    const result = await client().manifest(parseReference(`${reg.host}/team/model:v1`, { insecureHosts: insecure }));
    expect(result.digest).toBe(sha256(MANIFEST_DOC));
  });

  it('rejects a Docker-Content-Digest header that does not match the bytes', async () => {
    const reg = await serve({
      '/v2/team/model/manifests/v1': { headers: { 'docker-content-digest': sha256('something else') }, body: MANIFEST_DOC },
    });
    const err = await failure(client().manifest(parseReference(`${reg.host}/team/model:v1`, { insecureHosts: insecure })));
    expect(err.code).toBe('DIGEST_MISMATCH');
  });

  it('requests by digest and rejects bytes that do not match the pinned digest', async () => {
    const pinned = sha256('the manifest the user pinned');
    const reg = await serve({ [`/v2/team/model/manifests/${pinned}`]: { body: MANIFEST_DOC } });
    const ref = parseReference(`${reg.host}/team/model:v1@${pinned}`, { insecureHosts: insecure });
    const err = await failure(client().manifest(ref));
    expect(err.code).toBe('DIGEST_MISMATCH');
    expect(reg.requests.map((r) => r.url)).toEqual([`/v2/team/model/manifests/${pinned}`]);
  });

  it('accepts bytes matching the pinned digest', async () => {
    const pinned = sha256(MANIFEST_DOC);
    const reg = await serve({ [`/v2/team/model/manifests/${pinned}`]: { body: MANIFEST_DOC } });
    const result = await client().manifest(parseReference(`${reg.host}/team/model@${pinned}`, { insecureHosts: insecure }));
    expect(result.digest).toBe(pinned);
    expect(result.value.kind).toBe('manifest');
  });

  it.each([
    ['application/vnd.oci.image.index.v1+json'],
    ['application/vnd.docker.distribution.manifest.list.v2+json'],
  ])('returns kind "index" for %s', async (mediaType) => {
    const doc = JSON.stringify({
      schemaVersion: 2,
      mediaType,
      manifests: [{ mediaType: OCI_MANIFEST, digest: sha256(MANIFEST_DOC), size: MANIFEST_DOC.length, platform: { os: 'linux' } }],
    });
    const reg = await serve({ '/v2/team/model/manifests/multi': { body: doc } });
    const result = await client().manifest(parseReference(`${reg.host}/team/model:multi`, { insecureHosts: insecure }));
    expect(result.value).toEqual({
      kind: 'index',
      mediaType,
      manifests: [{ mediaType: OCI_MANIFEST, digest: sha256(MANIFEST_DOC), size: MANIFEST_DOC.length, platform: { os: 'linux' } }],
    });
  });

  it('takes the media type from Content-Type when the document omits it (Docker v2)', async () => {
    const doc = JSON.stringify({
      schemaVersion: 2,
      config: { mediaType: 'application/vnd.docker.container.image.v1+json', digest: sha256(CONFIG), size: 2 },
      layers: [],
    });
    const type = 'application/vnd.docker.distribution.manifest.v2+json';
    const reg = await serve({ '/v2/team/model/manifests/v1': { headers: { 'content-type': `${type}; charset=utf-8` }, body: doc } });
    const result = await client().manifest(parseReference(`${reg.host}/team/model:v1`, { insecureHosts: insecure }));
    expect(result.mediaType).toBe(type);
    expect(result.value.kind).toBe('manifest');
  });

  it('stops reading a manifest past maxManifestBytes (chunked, no Content-Length)', async () => {
    const reg = await startServer(
      registry({
        routes: {
          '/v2/team/model/manifests/big': (_req, res) => {
            res.writeHead(200, { 'content-type': OCI_MANIFEST });
            res.write('x'.repeat(600));
            res.end('x'.repeat(600));
          },
        },
      }),
    );
    const err = await failure(
      client({ maxManifestBytes: 1000 }).manifest(parseReference(`${reg.host}/team/model:big`, { insecureHosts: insecure })),
    );
    expect(err.code).toBe('SIZE_EXCEEDED');
  });

  it('rejects an oversized declared Content-Length before reading', async () => {
    const reg = await serve({ '/v2/team/model/manifests/big': { body: 'y'.repeat(2048) } });
    const err = await failure(
      client({ maxManifestBytes: 1000 }).manifest(parseReference(`${reg.host}/team/model:big`, { insecureHosts: insecure })),
    );
    expect(err.code).toBe('SIZE_EXCEEDED');
  });

  it('rejects an unknown media type as UNSUPPORTED_MANIFEST', async () => {
    const doc = JSON.stringify({ schemaVersion: 1, mediaType: 'application/vnd.docker.distribution.manifest.v1+prettyjws' });
    const reg = await serve({ '/v2/team/model/manifests/old': { body: doc } });
    const err = await failure(client().manifest(parseReference(`${reg.host}/team/model:old`, { insecureHosts: insecure })));
    expect(err.code).toBe('UNSUPPORTED_MANIFEST');
  });

  it('rejects a malformed descriptor as PROTOCOL', async () => {
    const doc = JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      config: { mediaType: 'x', digest: sha256(CONFIG), size: 2 },
      layers: [{ mediaType: 'x', size: 3 }],
    });
    const reg = await serve({ '/v2/team/model/manifests/v1': { body: doc } });
    const err = await failure(client().manifest(parseReference(`${reg.host}/team/model:v1`, { insecureHosts: insecure })));
    expect(err.code).toBe('PROTOCOL');
    expect(err.message).toMatch(/layers\[0\]\.digest/);
  });

  it('requires a tag or digest', async () => {
    const reg = await serve({});
    const err = await failure(client().manifest(parseReference(`${reg.host}/team/model`, { insecureHosts: insecure })));
    expect(err.code).toBe('INVALID_REFERENCE');
    expect(reg.requests).toHaveLength(0);
  });

  it('feeds the injected hasher and trusts its digest', async () => {
    const chunks: number[] = [];
    const reg = await startServer((_req, res) => send(res, { body: MANIFEST_DOC }));
    const result = await client({
      createHasher: () => ({
        update: (chunk) => chunks.push(chunk.byteLength),
        digest: () => 'f'.repeat(64),
      }),
    }).manifest(parseReference(`${reg.host}/team/model:v1`, { insecureHosts: insecure }));
    expect(result.digest).toBe(`sha256:${'f'.repeat(64)}`);
    expect(chunks.reduce((a, b) => a + b, 0)).toBe(MANIFEST_DOC.length);
  });
});
