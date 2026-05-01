/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  fnv128,
  HttpBlobStore,
  LayeredBlobStore,
  MemoryBlobStore,
} from '../src/geometry/blob-store.js';

describe('blob store', () => {
  it('fnv128 returns 32 lowercase hex chars and is deterministic', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const a = fnv128(bytes);
    const b = fnv128(bytes);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(fnv128(new Uint8Array([1, 2, 3]))).not.toBe(a);
  });

  it('MemoryBlobStore round-trips bytes content-addressed', async () => {
    const store = new MemoryBlobStore();
    const data = new TextEncoder().encode('hello, world');
    const meta = await store.put(data, 'text/plain');
    expect(meta.byteLength).toBe(data.byteLength);
    expect(meta.contentType).toBe('text/plain');

    expect(await store.has(meta.hash)).toBe(true);
    const got = await store.get(meta.hash);
    expect(got).not.toBeNull();
    expect(new TextDecoder().decode(got!)).toBe('hello, world');

    expect(await store.list()).toEqual([meta.hash]);
    expect(await store.delete(meta.hash)).toBe(true);
    expect(await store.has(meta.hash)).toBe(false);
  });

  it('MemoryBlobStore deduplicates identical bytes', async () => {
    const store = new MemoryBlobStore();
    const a = await store.put(new Uint8Array([1, 2, 3]));
    const b = await store.put(new Uint8Array([1, 2, 3]));
    expect(a.hash).toBe(b.hash);
    expect((await store.list()).length).toBe(1);
  });

  it('LayeredBlobStore reads from local first, falls through to remote, caches on hit', async () => {
    const local = new MemoryBlobStore();
    const remote = new MemoryBlobStore();
    const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const meta = await remote.put(data); // pre-seed remote only
    const layered = new LayeredBlobStore(local, remote);

    expect(await local.has(meta.hash)).toBe(false);
    const got = await layered.get(meta.hash);
    expect(got).toEqual(data);
    // give the cache write a tick.
    await new Promise((r) => setTimeout(r, 0));
    expect(await local.has(meta.hash)).toBe(true);
  });

  it('LayeredBlobStore writes go to both backends', async () => {
    const local = new MemoryBlobStore();
    const remote = new MemoryBlobStore();
    const layered = new LayeredBlobStore(local, remote);
    const meta = await layered.put(new Uint8Array([0x01, 0x02]));
    expect(await local.has(meta.hash)).toBe(true);
    expect(await remote.has(meta.hash)).toBe(true);
  });

  it('HttpBlobStore PUT/GET/HEAD/DELETE/list against an in-memory fetch', async () => {
    const inner = new MemoryBlobStore();
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : (input as Request).url ?? input.toString());
      const path = url.pathname;
      if (path === '/blobs') {
        if ((init?.method ?? 'GET') === 'GET') {
          const hashes = await inner.list();
          return new Response(JSON.stringify({ hashes }), { status: 200 });
        }
      }
      const m = path.match(/^\/blobs\/(.+)$/);
      if (!m) return new Response(null, { status: 404 });
      const hash = m[1];
      switch (init?.method ?? 'GET') {
        case 'PUT': {
          const body = init!.body as Uint8Array;
          const meta = await inner.put(body, init!.headers && (init!.headers as Record<string, string>)['content-type']);
          return new Response(JSON.stringify(meta), { status: 201 });
        }
        case 'GET': {
          const v = await inner.get(hash);
          if (!v) return new Response(null, { status: 404 });
          return new Response(v, { status: 200 });
        }
        case 'HEAD': {
          const exists = await inner.has(hash);
          return new Response(null, { status: exists ? 200 : 404 });
        }
        case 'DELETE': {
          const ok = await inner.delete(hash);
          return new Response(null, { status: ok ? 204 : 404 });
        }
      }
      return new Response(null, { status: 405 });
    };

    const http = new HttpBlobStore({
      baseUrl: 'http://blob.test',
      fetch: fetchImpl as typeof fetch,
    });
    const meta = await http.put(new Uint8Array([9, 9, 9]));
    expect(meta.hash).toMatch(/^[a-f0-9]{32}$/);
    expect(await http.has(meta.hash)).toBe(true);
    const got = await http.get(meta.hash);
    expect(got).toEqual(new Uint8Array([9, 9, 9]));
    expect(await http.list()).toContain(meta.hash);
    expect(await http.delete(meta.hash)).toBe(true);
    expect(await http.get(meta.hash)).toBeNull();
  });
});
