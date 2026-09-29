/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Blob storage contract behind the `/blobs` route (`blob-route.ts`), plus the
 * in-memory backend used by default in tests and dev.
 */

export interface ServerBlobMeta {
  hash: string;
  byteLength: number;
  contentType?: string;
  uploadedAt: string;
}

export interface ServerBlobStorage {
  put(hash: string, bytes: Uint8Array, contentType?: string): Promise<ServerBlobMeta>;
  get(hash: string): Promise<{ bytes: Uint8Array; meta: ServerBlobMeta } | null>;
  has(hash: string): Promise<boolean>;
  delete(hash: string): Promise<boolean>;
  list(): Promise<string[]>;
}

/** In-memory storage. Default for tests + dev. */
export class InMemoryBlobStorage implements ServerBlobStorage {
  private readonly blobs = new Map<string, { bytes: Uint8Array; meta: ServerBlobMeta }>();

  async put(hash: string, bytes: Uint8Array, contentType?: string): Promise<ServerBlobMeta> {
    const meta: ServerBlobMeta = {
      hash,
      byteLength: bytes.byteLength,
      contentType,
      uploadedAt: new Date().toISOString(),
    };
    this.blobs.set(hash, { bytes: new Uint8Array(bytes), meta });
    return meta;
  }
  async get(hash: string) {
    const v = this.blobs.get(hash);
    return v ? { bytes: new Uint8Array(v.bytes), meta: v.meta } : null;
  }
  async has(hash: string) {
    return this.blobs.has(hash);
  }
  async delete(hash: string) {
    return this.blobs.delete(hash);
  }
  async list() {
    return Array.from(this.blobs.keys());
  }
}
