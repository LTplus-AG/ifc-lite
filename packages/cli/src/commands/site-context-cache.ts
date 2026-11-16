/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A response cache on disk for the geodata client, keyed the way its cache
 * hook expects (URL plus `Range`). One `<sha256>.entry` file per response
 * holds its metadata and body together: written to a temporary name unique
 * to the writer, then renamed into place. A rename replaces the file
 * atomically, so a reader sees the previous entry or the new one, never a
 * body that does not belong to its metadata, even when two commands share
 * the cache directory (#10480 review). Entries written by an earlier layout
 * (`.json` + `.bin`) are not read; those responses are fetched again.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
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

/** Write `bytes` to `target` through a temporary file of this writer's own, removed if publishing fails. */
async function publish(target: string, bytes: Uint8Array): Promise<void> {
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, bytes);
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch((cleanup: unknown) => {
      if ((cleanup as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[site-context] could not remove ${tmp}:`, cleanup);
    });
    throw err;
  }
}

/** Entry layout: u32 (LE) metadata length, metadata JSON, body. */
function packEntry(meta: Meta, body: ArrayBuffer): Uint8Array {
  const head = new TextEncoder().encode(JSON.stringify(meta));
  const out = new Uint8Array(4 + head.length + body.byteLength);
  new DataView(out.buffer).setUint32(0, head.length, true);
  out.set(head, 4);
  out.set(new Uint8Array(body), 4 + head.length);
  return out;
}

function unpackEntry(bytes: Uint8Array): { meta: Meta; body: ArrayBuffer } | null {
  if (bytes.byteLength < 4) return null;
  const headLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  if (4 + headLength > bytes.byteLength) return null;
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headLength))) as Meta;
  // A copy: `readFile` returns a Buffer, whose `slice` is a view onto the whole entry.
  const body = new Uint8Array(bytes.byteLength - 4 - headLength);
  body.set(bytes.subarray(4 + headLength));
  return { meta, body: body.buffer };
}

export function diskCache(dir: string): ResponseCache & { hits: number; writes: number } {
  const path = (key: string) => join(dir, `${createHash('sha256').update(key).digest('hex')}.entry`);
  const cache = {
    hits: 0,
    writes: 0,
    async get(key: string): Promise<CachedResponse | undefined> {
      let bytes: Uint8Array;
      try {
        bytes = await readFile(path(key));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw err;
      }
      const entry = unpackEntry(bytes);
      if (!entry || entry.meta.key !== key) return undefined;
      cache.hits++;
      return { status: entry.meta.status, headers: entry.meta.headers, body: entry.body };
    },
    async set(key: string, value: CachedResponse): Promise<void> {
      await mkdir(dir, { recursive: true });
      await publish(path(key), packEntry({ key, status: value.status, headers: value.headers }, value.body));
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
 * tile, written to a temporary name unique to the writer and renamed, so a
 * half-written file is never read and two writers of one tile both finish. The swisstopo index JSON files are 5–12 MB each; caching them
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
      await publish(path(url), bytes);
      cache.writes++;
    },
  };
  return cache;
}

/** `--offline` for the tile reader. */
export const offlineTilesFetch: TilesFetchLike = async (url) => {
  throw new Error(`offline: ${url} is not in the cache directory`);
};
