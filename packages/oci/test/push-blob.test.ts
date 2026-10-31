/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'vitest';
import { OciClient, parseReference } from '../src/index.js';
import { basic, closeAll, send, sha256, startServer, type FakeServer } from './fake-registry.js';
import { ociFailure, pushRegistry } from './push-registry.js';

afterEach(closeAll);

const insecure = ['127.0.0.1'];
const PAYLOAD = new TextEncoder().encode('ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n');
const DIGEST = sha256(PAYLOAD);

function ref(server: FakeServer) {
  return parseReference(`${server.host}/team/model:v1`, { insecureHosts: insecure });
}

function client(options: ConstructorParameters<typeof OciClient>[0] = {}): OciClient {
  return new OciClient({ insecureHosts: insecure, ...options });
}

describe('pushBlob', () => {
  it('uploads with POST then PUT to a relative Location, keeping its query and appending the digest', async () => {
    const { handler, store } = pushRegistry();
    const reg = await startServer(handler);

    const result = await client().pushBlob(ref(reg), PAYLOAD);

    expect(result).toEqual({ digest: DIGEST, size: PAYLOAD.length });
    expect(Buffer.from(store.blobs.get(DIGEST) ?? []).equals(Buffer.from(PAYLOAD))).toBe(true);
    expect(reg.requests.map((r) => r.method)).toEqual(['HEAD', 'POST', 'PUT']);
    expect(reg.requests[0].url).toBe(`/v2/team/model/blobs/${DIGEST}`);
    expect(reg.requests[1].url).toBe('/v2/team/model/blobs/uploads/');
    const put = reg.requests[2];
    expect(put.url).toBe(`/v2/team/model/blobs/uploads/s1?_state=abc%3D%3D&x=1&digest=${encodeURIComponent(DIGEST)}`);
    expect(put.contentType).toBe('application/octet-stream');
  });

  it('follows an absolute same-origin Location without a query', async () => {
    const { handler, store } = pushRegistry({ location: (session, req) => `http://${req.headers.host}/upload-area/${session}` });
    // The fake only stores uploads under /v2/<repo>/blobs/uploads/, so route
    // the absolute path back there to prove the client used the URL verbatim.
    const reg = await startServer((req, res) => {
      if ((req.url ?? '').startsWith('/upload-area/')) req.url = (req.url ?? '').replace('/upload-area/', '/v2/team/model/blobs/uploads/');
      return handler(req, res);
    });

    await client().pushBlob(ref(reg), PAYLOAD);

    expect(reg.requests[2].url).toBe(`/upload-area/s1?digest=${encodeURIComponent(DIGEST)}`);
    expect(store.blobs.has(DIGEST)).toBe(true);
  });

  it('skips the upload when the registry already holds the blob', async () => {
    const { handler } = pushRegistry();
    const reg = await startServer(handler);
    await client().pushBlob(ref(reg), PAYLOAD);
    reg.requests.length = 0;

    const again = await client().pushBlob(ref(reg), PAYLOAD);

    expect(again).toEqual({ digest: DIGEST, size: PAYLOAD.length });
    expect(reg.requests.map((r) => r.method)).toEqual(['HEAD']);
  });

  it('uploads when HEAD finds a blob of a different size', async () => {
    const { handler } = pushRegistry();
    const reg = await startServer((req, res) => {
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'content-length': '3' });
        return void res.end();
      }
      return handler(req, res);
    });
    await client().pushBlob(ref(reg), PAYLOAD);
    expect(reg.requests.map((r) => r.method)).toEqual(['HEAD', 'POST', 'PUT']);
  });

  it('uploads when HEAD is redirected to a CDN that refuses HEAD', async () => {
    const cdn = await startServer((_req, res) => send(res, { status: 403 }));
    const { handler, store } = pushRegistry();
    const reg = await startServer((req, res) => {
      if (req.method === 'HEAD') return send(res, { status: 307, headers: { location: `${cdn.origin}/signed?sig=get-only` } });
      return handler(req, res);
    });
    await client().pushBlob(ref(reg), PAYLOAD);
    expect(cdn.requests.map((r) => r.method)).toEqual(['HEAD']);
    expect(store.blobs.has(DIGEST)).toBe(true);
  });

  it('refuses an off-origin Location: no request reaches it, and no credentials leave the registry', async () => {
    const elsewhere = await startServer((_req, res) => send(res, { status: 201 }));
    const { handler, store } = pushRegistry({
      challenge: 'Basic realm="push"',
      accept: (a) => a === basic('alice', 's3cret'),
      location: (session) => `${elsewhere.origin}/v2/team/model/blobs/uploads/${session}?_state=x`,
    });
    const reg = await startServer(handler);

    const err = await ociFailure(client({ credentials: { username: 'alice', password: 's3cret' } }).pushBlob(ref(reg), PAYLOAD));

    expect(err.code).toBe('PROTOCOL');
    expect(err.message).toMatch(/another origin/);
    expect(err.message).not.toMatch(/s3cret/);
    expect(elsewhere.requests).toHaveLength(0);
    expect(store.blobs.size).toBe(0);
    expect(reg.requests.map((r) => r.method)).toEqual(['HEAD', 'HEAD', 'POST']);
  });

  it('a Docker-Content-Digest that differs from the bytes sent is DIGEST_MISMATCH', async () => {
    const { handler } = pushRegistry({ blobDigestHeader: () => sha256('something else') });
    const reg = await startServer(handler);
    const err = await ociFailure(client().pushBlob(ref(reg), PAYLOAD));
    expect(err.code).toBe('DIGEST_MISMATCH');
    expect(err.message).toContain(DIGEST);
  });

  it('accepts a 201 without Docker-Content-Digest', async () => {
    const { handler, store } = pushRegistry({ blobDigestHeader: () => undefined });
    const reg = await startServer(handler);
    expect(await client().pushBlob(ref(reg), PAYLOAD)).toEqual({ digest: DIGEST, size: PAYLOAD.length });
    expect(store.blobs.has(DIGEST)).toBe(true);
  });

  it('a registry that rejects the digest (400 DIGEST_INVALID) is DIGEST_MISMATCH', async () => {
    const { handler } = pushRegistry();
    // A proxy that corrupts the body in transit: the registry hashes what it got.
    const reg = await startServer((req, res) => {
      if (req.method === 'PUT') {
        req.resume();
        return send(res, { status: 400, body: JSON.stringify({ errors: [{ code: 'DIGEST_INVALID' }] }) });
      }
      return handler(req, res);
    });
    const err = await ociFailure(client().pushBlob(ref(reg), PAYLOAD));
    expect(err.code).toBe('DIGEST_MISMATCH');
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/DIGEST_INVALID/);
  });

  it('a 202 without Location is PROTOCOL', async () => {
    const { handler } = pushRegistry();
    const reg = await startServer((req, res) => (req.method === 'POST' ? send(res, { status: 202 }) : handler(req, res)));
    const err = await ociFailure(client().pushBlob(ref(reg), PAYLOAD));
    expect(err.code).toBe('PROTOCOL');
    expect(reg.requests.map((r) => r.method)).toEqual(['HEAD', 'POST']);
  });

  it('refuses anything but a Uint8Array before any request', async () => {
    const { handler } = pushRegistry();
    const reg = await startServer(handler);
    const notBytes: unknown = 'a string';
    await expect(client().pushBlob(ref(reg), notBytes as Uint8Array)).rejects.toThrow(TypeError);
    expect(reg.requests).toHaveLength(0);
  });

  it('hashes through createHasher when one is configured', async () => {
    const { handler, store } = pushRegistry();
    const reg = await startServer(handler);
    const { createHash } = await import('node:crypto');
    let chunks = 0;
    const c = client({
      createHasher: () => {
        const h = createHash('sha256');
        return {
          update: (chunk) => {
            chunks++;
            h.update(chunk);
          },
          digest: () => h.digest('hex'),
        };
      },
    });
    expect((await c.pushBlob(ref(reg), PAYLOAD)).digest).toBe(DIGEST);
    expect(chunks).toBe(1);
    expect(store.blobs.has(DIGEST)).toBe(true);
  });
});
