/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Content-addressed blob store (spec §11.1).
 *
 * Mesh / opaque blobs live OUTSIDE the Y.Doc — the Y.Doc only carries
 * `blobHash` references (see `doc/geometry.ts`). The blob store is
 * pluggable so apps can mix:
 *   - `MemoryBlobStore`   — tests, ephemeral rooms
 *   - `IndexedDbBlobStore` — browsers, local-first
 *   - `HttpBlobStore`     — `@ifc-lite/collab-server` blob route
 *   - composition: `LayeredBlobStore(local, remote)`
 *
 * Hashing is FNV-1a × 4 rounds → 32 hex chars. Cheap, dependency-free,
 * collision properties good enough to identify ~10^9 blobs without
 * coincidence in practice. For high-assurance deployments, swap to
 * SHA-256 by registering a different `BlobHasher`.
 */

export type BlobHash = string;

export interface BlobMeta {
  hash: BlobHash;
  byteLength: number;
  contentType?: string;
  uploadedAt?: string;
}

export interface BlobStore {
  put(bytes: Uint8Array, contentType?: string): Promise<BlobMeta>;
  get(hash: BlobHash): Promise<Uint8Array | null>;
  has(hash: BlobHash): Promise<boolean>;
  delete(hash: BlobHash): Promise<boolean>;
  /** List currently-known blob hashes; ordering is implementation-defined. */
  list(): Promise<BlobHash[]>;
  /**
   * Return the blob's metadata (size, contentType, uploadedAt) without
   * downloading the bytes. Backends that can't cheaply compute this
   * may return `null` and force callers to fall back to `get`.
   */
  stat?(hash: BlobHash): Promise<BlobMeta | null>;
}

/* ------------------------------------------------------------------ */
/* Hashing                                                             */
/* ------------------------------------------------------------------ */

export type BlobHasher = (bytes: Uint8Array) => BlobHash;

/**
 * 128-bit hash (4 rounds of 32-bit FNV-1a with different seeds), encoded
 * as 32 lowercase hex chars. Deterministic, dependency-free.
 */
export const fnv128: BlobHasher = (bytes) => {
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
};

/* ------------------------------------------------------------------ */
/* Memory backend                                                       */
/* ------------------------------------------------------------------ */

export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<BlobHash, { bytes: Uint8Array; meta: BlobMeta }>();
  constructor(private readonly hasher: BlobHasher = fnv128) {}

  async put(bytes: Uint8Array, contentType?: string): Promise<BlobMeta> {
    const hash = this.hasher(bytes);
    const meta: BlobMeta = {
      hash,
      byteLength: bytes.byteLength,
      contentType,
      uploadedAt: new Date().toISOString(),
    };
    if (!this.blobs.has(hash)) {
      // Defensive copy so callers can mutate `bytes` after put().
      this.blobs.set(hash, { bytes: new Uint8Array(bytes), meta });
    }
    return meta;
  }
  async get(hash: BlobHash): Promise<Uint8Array | null> {
    const entry = this.blobs.get(hash);
    return entry ? new Uint8Array(entry.bytes) : null;
  }
  async has(hash: BlobHash): Promise<boolean> {
    return this.blobs.has(hash);
  }
  async delete(hash: BlobHash): Promise<boolean> {
    return this.blobs.delete(hash);
  }
  async list(): Promise<BlobHash[]> {
    return Array.from(this.blobs.keys());
  }
  async stat(hash: BlobHash): Promise<BlobMeta | null> {
    const entry = this.blobs.get(hash);
    return entry ? { ...entry.meta } : null;
  }
}

/* ------------------------------------------------------------------ */
/* IndexedDB backend                                                    */
/* ------------------------------------------------------------------ */

export interface IndexedDbBlobStoreOptions {
  dbName?: string;
  storeName?: string;
}

/**
 * Browser-only IndexedDB-backed store. Loaded lazily so Node bundle
 * paths don't trip on the missing global.
 */
export async function createIndexedDbBlobStore(
  opts: IndexedDbBlobStoreOptions = {},
  hasher: BlobHasher = fnv128,
): Promise<BlobStore> {
  if (typeof indexedDB === 'undefined') {
    throw new Error(
      '@ifc-lite/collab: indexedDB is unavailable; createIndexedDbBlobStore requires a browser environment',
    );
  }
  const dbName = opts.dbName ?? 'ifc-lite/collab/blobs';
  const storeName = opts.storeName ?? 'blobs';

  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(dbName, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore(storeName, { keyPath: 'hash' });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });

  const tx = (mode: IDBTransactionMode) => db.transaction(storeName, mode).objectStore(storeName);

  const promisify = <T>(req: IDBRequest<T>): Promise<T> =>
    new Promise<T>((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });

  return {
    async put(bytes: Uint8Array, contentType?: string) {
      const hash = hasher(bytes);
      const meta: BlobMeta = {
        hash,
        byteLength: bytes.byteLength,
        contentType,
        uploadedAt: new Date().toISOString(),
      };
      await promisify(tx('readwrite').put({ hash, bytes, meta }));
      return meta;
    },
    async get(hash) {
      const entry = await promisify(tx('readonly').get(hash));
      if (!entry) return null;
      const bytes = (entry as { bytes: ArrayBuffer | Uint8Array }).bytes;
      return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    },
    async has(hash) {
      const count = await promisify(tx('readonly').count(hash));
      return count > 0;
    },
    async delete(hash) {
      const had = await this.has(hash);
      if (!had) return false;
      await promisify(tx('readwrite').delete(hash));
      return true;
    },
    async list() {
      const keys = await promisify(tx('readonly').getAllKeys());
      return keys as BlobHash[];
    },
    async stat(hash: BlobHash) {
      const entry = await promisify(tx('readonly').get(hash));
      if (!entry) return null;
      return ((entry as { meta: BlobMeta }).meta) ?? null;
    },
  } satisfies BlobStore;
}

/* ------------------------------------------------------------------ */
/* HTTP backend                                                         */
/* ------------------------------------------------------------------ */

export interface HttpBlobStoreOptions {
  /** Base URL like `https://collab.ifclite.com`; we append `/blobs/<hash>`. */
  baseUrl: string;
  /** Bearer token forwarded as `Authorization: Bearer …`. */
  token?: string;
  /** Hasher used when deduping client-side before PUT. */
  hasher?: BlobHasher;
  /** Override fetch (mainly for tests). */
  fetch?: typeof fetch;
}

export class HttpBlobStore implements BlobStore {
  private readonly hasher: BlobHasher;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: HttpBlobStoreOptions) {
    this.hasher = opts.hasher ?? fnv128;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private url(hash: BlobHash): string {
    return `${this.opts.baseUrl.replace(/\/$/, '')}/blobs/${hash}`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...(extra ?? {}) };
    if (this.opts.token) h['authorization'] = `Bearer ${this.opts.token}`;
    return h;
  }

  async put(bytes: Uint8Array, contentType?: string): Promise<BlobMeta> {
    const hash = this.hasher(bytes);
    const res = await this.fetchImpl(this.url(hash), {
      method: 'PUT',
      headers: this.headers({ 'content-type': contentType ?? 'application/octet-stream' }),
      // TS 5.7's tightened `Uint8Array<ArrayBufferLike>` typing doesn't
      // satisfy `BodyInit` directly; the runtime accepts Uint8Array fine.
      body: bytes as unknown as BodyInit,
    });
    if (!res.ok) {
      throw new Error(`@ifc-lite/collab: blob PUT failed: ${res.status} ${res.statusText}`);
    }
    return {
      hash,
      byteLength: bytes.byteLength,
      contentType,
      uploadedAt: new Date().toISOString(),
    };
  }
  async get(hash: BlobHash): Promise<Uint8Array | null> {
    const res = await this.fetchImpl(this.url(hash), { headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`@ifc-lite/collab: blob GET failed: ${res.status}`);
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }
  async has(hash: BlobHash): Promise<boolean> {
    const res = await this.fetchImpl(this.url(hash), { method: 'HEAD', headers: this.headers() });
    return res.ok;
  }
  async delete(hash: BlobHash): Promise<boolean> {
    const res = await this.fetchImpl(this.url(hash), { method: 'DELETE', headers: this.headers() });
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`@ifc-lite/collab: blob DELETE failed: ${res.status}`);
    return true;
  }
  async list(): Promise<BlobHash[]> {
    const res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, '')}/blobs`, {
      headers: this.headers({ accept: 'application/json' }),
    });
    if (!res.ok) throw new Error(`@ifc-lite/collab: blob list failed: ${res.status}`);
    const json = (await res.json()) as { hashes?: BlobHash[] } | BlobHash[];
    if (Array.isArray(json)) return json;
    return json.hashes ?? [];
  }
  async stat(hash: BlobHash): Promise<BlobMeta | null> {
    const res = await this.fetchImpl(this.url(hash), { method: 'HEAD', headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`@ifc-lite/collab: blob HEAD failed: ${res.status}`);
    const len = res.headers.get('content-length');
    return {
      hash,
      byteLength: len ? Number(len) : 0,
      contentType: res.headers.get('content-type') ?? undefined,
      uploadedAt: res.headers.get('last-modified') ?? undefined,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Layered (local-first) backend                                        */
/* ------------------------------------------------------------------ */

/**
 * Read-through / write-through layering: writes go to `local` and `remote`
 * in parallel; reads check `local` first and fall back to `remote`,
 * caching the result locally on hit.
 *
 * This is what we recommend for browser apps: instant local reads, durable
 * remote storage, and offline-first semantics for already-fetched blobs.
 */
export class LayeredBlobStore implements BlobStore {
  constructor(private readonly local: BlobStore, private readonly remote: BlobStore) {}

  async put(bytes: Uint8Array, contentType?: string): Promise<BlobMeta> {
    const [meta] = await Promise.all([
      this.local.put(bytes, contentType),
      this.remote.put(bytes, contentType).catch(() => null),
    ]);
    return meta;
  }
  async get(hash: BlobHash): Promise<Uint8Array | null> {
    const local = await this.local.get(hash);
    if (local) return local;
    const remote = await this.remote.get(hash);
    if (remote) {
      // Cache locally for next time. Best-effort.
      this.local.put(remote).catch(() => {
        /* writes to a full IDB store can fail; non-fatal */
      });
    }
    return remote;
  }
  async has(hash: BlobHash): Promise<boolean> {
    if (await this.local.has(hash)) return true;
    return this.remote.has(hash);
  }
  async delete(hash: BlobHash): Promise<boolean> {
    const [a, b] = await Promise.all([
      this.local.delete(hash),
      this.remote.delete(hash).catch(() => false),
    ]);
    return a || b;
  }
  async list(): Promise<BlobHash[]> {
    const [a, b] = await Promise.all([this.local.list(), this.remote.list().catch(() => [])]);
    return Array.from(new Set([...a, ...b]));
  }
}
