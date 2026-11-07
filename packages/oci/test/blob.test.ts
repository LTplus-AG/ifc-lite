/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { OciClient, OciError, parseReference, type OciDescriptor } from '../src/index.js';
import { closeAll, registry, send, sha256, startServer, tokenRealm, type FakeServer } from './fake-registry.js';

afterEach(closeAll);

const insecure = ['127.0.0.1'];
const PAYLOAD = new TextEncoder().encode('ISO-10303-21; model payload bytes');
const DESCRIPTOR: OciDescriptor = { mediaType: 'application/octet-stream', digest: sha256(PAYLOAD), size: PAYLOAD.length };
const BLOB_PATH = `/v2/team/model/blobs/${DESCRIPTOR.digest}`;

function ref(server: FakeServer) {
  return parseReference(`${server.host}/team/model:v1`, { insecureHosts: insecure });
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

describe('blob', () => {
  it('follows a 307 to a CDN origin without sending Authorization there', async () => {
    const cdn = await startServer((_req, res) => send(res, { body: PAYLOAD }));
    const realm = await startServer(tokenRealm({ token: 'reg-token' }));
    const reg = await startServer(
      registry({
        challenge: `Bearer realm="${realm.origin}/token",service="fake"`,
        accept: (a) => a === 'Bearer reg-token',
        routes: { [BLOB_PATH]: { status: 307, headers: { location: `${cdn.origin}/blobs/abc?sig=1` } } },
      }),
    );
    const bytes = await new OciClient({ insecureHosts: insecure }).blob(ref(reg), DESCRIPTOR, { maxBytes: 1024 });
    expect(Buffer.from(bytes).equals(Buffer.from(PAYLOAD))).toBe(true);
    expect(reg.requests.map((r) => r.authorization)).toEqual([undefined, 'Bearer reg-token']);
    expect(cdn.requests).toHaveLength(1);
    expect(cdn.requests[0].url).toBe('/blobs/abc?sig=1');
    expect(cdn.requests[0].authorization).toBeUndefined();
  });

  it('keeps Authorization on a same-origin redirect', async () => {
    const reg = await startServer(
      registry({
        challenge: 'Basic realm="x"',
        accept: (a) => a !== undefined,
        routes: { [BLOB_PATH]: { status: 302, headers: { location: '/storage/blob' } }, '/storage/blob': { body: PAYLOAD } },
      }),
    );
    const client = new OciClient({ insecureHosts: insecure, credentials: { username: 'u', password: 'p' } });
    await client.blob(ref(reg), DESCRIPTOR, { maxBytes: 1024 });
    expect(reg.requests.at(-1)?.url).toBe('/storage/blob');
    expect(reg.requests.at(-1)?.authorization).toMatch(/^Basic /);
  });

  it('rejects wrong bytes of the right size as DIGEST_MISMATCH', async () => {
    const wrong = new Uint8Array(PAYLOAD.length).fill(0x41);
    const reg = await startServer(registry({ routes: { [BLOB_PATH]: { body: wrong } } }));
    const err = await failure(new OciClient({ insecureHosts: insecure }).blob(ref(reg), DESCRIPTOR, { maxBytes: 1024 }));
    expect(err.code).toBe('DIGEST_MISMATCH');
  });

  it('aborts an oversized streamed blob mid-transfer with SIZE_EXCEEDED', async () => {
    const chunk = Buffer.alloc(64 * 1024, 0x42);
    const total = 64 * 1024 * 1024;
    let written = 0;
    let closed!: () => void;
    const serverSawClose = new Promise<void>((r) => (closed = r));
    const reg = await startServer(
      registry({
        routes: {
          // Chunked, no Content-Length: only the streaming cap can stop this.
          [BLOB_PATH]: async (_req, res) => {
            let wake: (() => void) | undefined;
            res.on('close', () => {
              closed();
              wake?.();
            });
            res.writeHead(200, { 'content-type': 'application/octet-stream' });
            while (written < total && !res.destroyed) {
              written += chunk.length;
              if (!res.write(chunk)) {
                await new Promise<void>((r) => {
                  wake = r;
                  res.once('drain', r);
                });
              }
            }
            res.end();
          },
        },
      }),
    );
    const descriptor = { ...DESCRIPTOR, size: 100 * 1024 };
    const err = await failure(new OciClient({ insecureHosts: insecure }).blob(ref(reg), descriptor, { maxBytes: 1024 * 1024 }));
    expect(err.code).toBe('SIZE_EXCEEDED');
    await serverSawClose;
    expect(written).toBeLessThan(total / 4);
  });

  it('refuses a descriptor larger than maxBytes without requesting it', async () => {
    const reg = await startServer(registry({ routes: { [BLOB_PATH]: { body: PAYLOAD } } }));
    const err = await failure(new OciClient({ insecureHosts: insecure }).blob(ref(reg), DESCRIPTOR, { maxBytes: 4 }));
    expect(err.code).toBe('SIZE_EXCEEDED');
    expect(reg.requests).toHaveLength(0);
  });

  it('rejects a short body as PROTOCOL', async () => {
    const reg = await startServer(registry({ routes: { [BLOB_PATH]: { body: PAYLOAD.slice(0, 5) } } }));
    const err = await failure(new OciClient({ insecureHosts: insecure }).blob(ref(reg), DESCRIPTOR, { maxBytes: 1024 }));
    expect(err.code).toBe('PROTOCOL');
    expect(err.message).toMatch(/expected exactly/);
  });

  it('streams through an injected hasher and compares its output', async () => {
    const reg = await startServer(registry({ routes: { [BLOB_PATH]: { body: PAYLOAD } } }));
    let updates = 0;
    const real = new OciClient({
      insecureHosts: insecure,
      createHasher: () => {
        const h = createHash('sha256');
        return { update: (c) => (updates++, h.update(c)), digest: () => h.digest('hex') };
      },
    });
    const bytes = await real.blob(ref(reg), DESCRIPTOR, { maxBytes: 1024 });
    expect(bytes.byteLength).toBe(PAYLOAD.length);
    expect(updates).toBeGreaterThan(0);

    const lying = new OciClient({ insecureHosts: insecure, createHasher: () => ({ update: () => undefined, digest: () => '0'.repeat(64) }) });
    expect((await failure(lying.blob(ref(reg), DESCRIPTOR, { maxBytes: 1024 }))).code).toBe('DIGEST_MISMATCH');
  });

  it('refuses a redirect to plain http on a host that is not insecure', async () => {
    const cdn = await startServer((_req, res) => send(res, { body: PAYLOAD }));
    const reg = await startServer(registry({ routes: { [BLOB_PATH]: { status: 307, headers: { location: `${cdn.origin}/b` } } } }));
    const client = new OciClient({ insecureHosts: [reg.host] });
    const err = await failure(client.blob(parseReference(`${reg.host}/team/model`, { insecureHosts: [reg.host] }), DESCRIPTOR, { maxBytes: 1024 }));
    expect(err.code).toBe('PROTOCOL');
    expect(cdn.requests).toHaveLength(0);
  });

  it('gives up after five redirects', async () => {
    const reg = await startServer((req, res) => send(res, { status: 302, headers: { location: `${req.url}x` } }));
    const err = await failure(new OciClient({ insecureHosts: insecure }).blob(ref(reg), DESCRIPTOR, { maxBytes: 1024 }));
    expect(err.code).toBe('PROTOCOL');
    expect(err.message).toMatch(/more than 5 redirects/);
    expect(reg.requests).toHaveLength(6);
  });

  it('reports a browser opaqueredirect as PROTOCOL instead of crashing', async () => {
    // Browsers answer `redirect: 'manual'` with a status-0 response whose
    // Location is hidden. Node never produces one, so this stands in for it.
    const browserFetch: typeof fetch = async () => {
      const response = new Response(null, { status: 200 });
      Object.defineProperty(response, 'type', { value: 'opaqueredirect' });
      return response;
    };
    const target = parseReference('registry.example.com/team/model:v1');
    const err = await failure(new OciClient({ fetch: browserFetch }).blob(target, DESCRIPTOR, { maxBytes: 1024 }));
    expect(err.code).toBe('PROTOCOL');
    expect(err.message).toMatch(/manual redirect/);
  });
});
