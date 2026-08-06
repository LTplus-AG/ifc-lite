/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { startCollabServer } from '../src/server.js';

/** Mirror of `@ifc-lite/collab/fnv128` so this test doesn't pull in the
 * client package as a devDependency. The actual server route accepts
 * any 32-hex-char input — clients pick the algorithm. */
function fnv128(bytes: Uint8Array): string {
  const seeds = [0x811c9dc5, 0x84222325, 0xcbf29ce4, 0x100000001];
  const out: number[] = [];
  for (let s = 0; s < 4; s++) {
    let h = seeds[s] >>> 0;
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i] ^ ((s + 1) << ((i & 3) * 8));
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    out.push(h >>> 0);
  }
  return out.map((n) => n.toString(16).padStart(8, '0')).join('');
}

describe('blob route', () => {
  it('PUT, GET, HEAD, list, DELETE round-trip', async () => {
    const handle = await startCollabServer({ port: 0 });
    const port = (handle.httpServer.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    const data = new TextEncoder().encode('hello blob');
    const hash = fnv128(data);

    // PUT
    let res = await fetch(`${base}/blobs/${hash}`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: data,
    });
    expect(res.status).toBe(201);
    const meta = (await res.json()) as { hash: string; byteLength: number };
    expect(meta.hash).toBe(hash);
    expect(meta.byteLength).toBe(data.byteLength);

    // GET
    res = await fetch(`${base}/blobs/${hash}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-blob-hash')).toBe(hash);
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe('hello blob');

    // HEAD
    res = await fetch(`${base}/blobs/${hash}`, { method: 'HEAD' });
    expect(res.status).toBe(200);

    // list
    res = await fetch(`${base}/blobs`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { hashes: string[] };
    expect(json.hashes).toContain(hash);

    // DELETE
    res = await fetch(`${base}/blobs/${hash}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    res = await fetch(`${base}/blobs/${hash}`);
    expect(res.status).toBe(404);

    await handle.stop();
  }, 10_000);

  it('rejects malformed hashes with 400', async () => {
    const handle = await startCollabServer({ port: 0 });
    const port = (handle.httpServer.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/blobs/not-a-hash`);
    expect(res.status).toBe(400);
    await handle.stop();
  });

  it('413 when payload exceeds blobMaxBytes', async () => {
    const handle = await startCollabServer({ port: 0, blobMaxBytes: 64 });
    const port = (handle.httpServer.address() as { port: number }).port;
    const data = new Uint8Array(128);
    const hash = fnv128(data);
    const res = await fetch(`http://127.0.0.1:${port}/blobs/${hash}`, {
      method: 'PUT',
      body: data,
    });
    expect(res.status).toBe(413);
    await handle.stop();
  });

  // Mutation-testing gap: no existing test ever supplies a real
  // `authenticate` hook and hits `/blobs`, so `makeBlobAuthorizer`'s
  // `canWrite` gate (viewer/commenter must not PUT or DELETE — only
  // editor/admin) had zero coverage. Replacing `canWrite(principal)` with
  // `true` in that branch left the full suite green. Every other check in
  // this route (401 unauthenticated, 400 malformed hash, 413 oversize) was
  // already asserted; only this role gate's deny path was not.
  it('gates PUT/DELETE on editor/admin; viewer reads but cannot write', async () => {
    const roleForToken = new Map<string, 'viewer' | 'editor'>([
      ['viewer-token', 'viewer'],
      ['editor-token', 'editor'],
    ]);
    const handle = await startCollabServer({
      port: 0,
      authenticate: (token) => {
        const role = token ? roleForToken.get(token) : undefined;
        return role ? { userId: token!, role } : null;
      },
    });
    const port = (handle.httpServer.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const data = new TextEncoder().encode('viewer cannot write this');
    const hash = fnv128(data);
    const asViewer: RequestInit = { headers: { authorization: 'Bearer viewer-token' } };
    const asEditor: RequestInit = { headers: { authorization: 'Bearer editor-token' } };

    try {
      // Viewer: PUT is refused before it ever reaches storage.
      let res = await fetch(`${base}/blobs/${hash}`, { ...asViewer, method: 'PUT', body: data });
      expect(res.status).toBe(401);
      // Viewer: reads still work (list gate is read-only, not write-gated).
      res = await fetch(`${base}/blobs`, asViewer);
      expect(res.status).toBe(200);

      // Editor: PUT succeeds, then a viewer's DELETE is refused.
      res = await fetch(`${base}/blobs/${hash}`, { ...asEditor, method: 'PUT', body: data });
      expect(res.status).toBe(201);
      res = await fetch(`${base}/blobs/${hash}`, { ...asViewer, method: 'DELETE' });
      expect(res.status).toBe(401);
      // The blob is still there — the refused DELETE had no effect.
      res = await fetch(`${base}/blobs/${hash}`, asViewer);
      expect(res.status).toBe(200);

      // Editor's DELETE is honored.
      res = await fetch(`${base}/blobs/${hash}`, { ...asEditor, method: 'DELETE' });
      expect(res.status).toBe(204);
    } finally {
      await handle.stop();
    }
  });
});
