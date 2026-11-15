/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A response cache on disk for the geodata client, keyed the way its cache
 * hook expects (URL plus `Range`). One `<sha256>.bin` body and one
 * `<sha256>.json` header file per response; the JSON is written last, so a
 * half-written entry reads as a miss.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CachedResponse, FetchLike, ResponseCache } from '@ifc-lite/geodata-ch';
import type { FetchLike as TilesFetchLike, TilesCache } from '@ifc-lite/tiles3d';

export function defaultCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(base, 'ifc-lite', 'geodata');
}

interface Meta {
  key: string;
  status: number;
  headers: Record<string, string>;
}

export function diskCache(dir: string): ResponseCache & { hits: number; writes: number } {
  const path = (key: string) => join(dir, createHash('sha256').update(key).digest('hex'));
  const cache = {
    hits: 0,
    writes: 0,
    async get(key: string): Promise<CachedResponse | undefined> {
      const p = path(key);
      let meta: Meta;
      try {
        meta = JSON.parse(await readFile(`${p}.json`, 'utf-8')) as Meta;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw err;
      }
      if (meta.key !== key) return undefined;
      const body = await readFile(`${p}.bin`);
      cache.hits++;
      return { status: meta.status, headers: meta.headers, body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer };
    },
    async set(key: string, value: CachedResponse): Promise<void> {
      await mkdir(dir, { recursive: true });
      const p = path(key);
      await writeFile(`${p}.bin`, new Uint8Array(value.body));
      const meta: Meta = { key, status: value.status, headers: value.headers };
      await writeFile(`${p}.json.tmp`, JSON.stringify(meta));
      await rename(`${p}.json.tmp`, `${p}.json`);
      cache.writes++;
    },
  };
  return cache;
}

/** `--offline`: any request the cache cannot answer fails, naming the URL. */
export const offlineFetch: FetchLike = async (input) => {
  throw new Error(`offline: ${input} is not in the cache directory`);
};

/**
 * The 3D Tiles byte cache on disk: one `<sha256(url)>.bin` per tileset JSON or
 * tile, written to a temporary name and renamed, so a half-written file is
 * never read. The swisstopo index JSON files are 5–12 MB each; caching them
 * makes a repeated site a handful of tile requests.
 */
export function tilesDiskCache(dir: string): TilesCache & { hits: number; writes: number } {
  const path = (url: string) => join(dir, `${createHash('sha256').update(url).digest('hex')}.bin`);
  const cache = {
    hits: 0,
    writes: 0,
    async get(url: string): Promise<Uint8Array | undefined> {
      try {
        const body = await readFile(path(url));
        cache.hits++;
        return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw err;
      }
    },
    async set(url: string, bytes: Uint8Array): Promise<void> {
      await mkdir(dir, { recursive: true });
      const p = path(url);
      await writeFile(`${p}.tmp`, bytes);
      await rename(`${p}.tmp`, p);
      cache.writes++;
    },
  };
  return cache;
}

/** `--offline` for the tile reader. */
export const offlineTilesFetch: TilesFetchLike = async (url) => {
  throw new Error(`offline: ${url} is not in the cache directory`);
};
