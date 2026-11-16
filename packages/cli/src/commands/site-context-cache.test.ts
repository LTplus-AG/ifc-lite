/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10480 review: the site-context disk cache never serves a body that does
 * not belong to its metadata. Two commands can share one cache directory, so
 * an entry can be rewritten while another reader looks it up; a reader must
 * see the old entry or the new one, never a torn mix.
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diskCache, tilesDiskCache } from './site-context-cache.js';

let dir = '';
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'ifc-lite-sc-cache-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

const body = (size: number, fill: number) => new Uint8Array(size).fill(fill).buffer;

describe('site-context disk cache', () => {
  it('a reader during a rewrite of the same key sees the old entry or the new one, never a torn body', async () => {
    const cache = diskCache(join(dir, 'torn'));
    const key = 'https://data.geo.admin.ch/x.tif|bytes=0-';
    const OLD = 1 << 20, NEW = 48 << 20;
    await cache.set(key, { status: 206, headers: { 'content-range': `bytes 0-${OLD - 1}/${OLD}` }, body: body(OLD, 1) });
    const seen = new Set<number>();
    let writing = true;
    const writer = Promise.resolve(cache.set(key, { status: 206, headers: { 'content-range': `bytes 0-${NEW - 1}/${NEW}` }, body: body(NEW, 2) })).finally(() => { writing = false; });
    while (writing) {
      const hit = await cache.get(key);
      if (hit) {
        const range = Number(/\/(\d+)$/.exec(hit.headers['content-range'])![1]);
        // The body must be exactly the one its metadata describes.
        seen.add(hit.body.byteLength === range ? hit.body.byteLength : -hit.body.byteLength);
      }
    }
    await writer;
    expect([...seen].every((n) => n === OLD || n === NEW)).toBe(true);
    expect((await cache.get(key))!.body.byteLength).toBe(NEW);
  });

  it('two writers of one key both finish, and no temporary file is left behind', async () => {
    const d = join(dir, 'twice');
    const cache = diskCache(d);
    const tiles = tilesDiskCache(join(d, 'tiles3d'));
    await Promise.all([
      cache.set('k', { status: 200, headers: {}, body: body(4 << 20, 3) }),
      cache.set('k', { status: 200, headers: {}, body: body(4 << 20, 4) }),
      tiles.set('https://3d.geo.admin.ch/t.b3dm', new Uint8Array(4 << 20).fill(5)),
      tiles.set('https://3d.geo.admin.ch/t.b3dm', new Uint8Array(4 << 20).fill(6)),
    ]);
    const files = [...await readdir(d), ...(await readdir(join(d, 'tiles3d'))).map((f) => `tiles3d/${f}`)];
    expect(files.filter((f) => f.includes('.tmp'))).toEqual([]);
    expect((await cache.get('k'))!.body.byteLength).toBe(4 << 20);
  });
});
