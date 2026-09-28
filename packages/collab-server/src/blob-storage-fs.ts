/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HASH_REGEX, type ServerBlobMeta, type ServerBlobStorage } from './blob-route.js';

/**
 * Disk-backed storage — one file per blob under `<dataDir>/blobs/<hash>`.
 *
 * Mesh blobs are the bulk of a room's data; keeping them in RAM
 * (`InMemoryBlobStorage`) made memory the dominant hosting cost AND lost every
 * blob on restart (orphaning the doc's geometry refs). Disk is far cheaper per
 * GB than memory on a mounted volume, and durable. Content-addressed, so writes
 * are idempotent. `hash` is validated as 32 hex chars by the route before it
 * reaches here, so it's safe as a filename (no traversal).
 */
export class FsBlobStorage implements ServerBlobStorage {
  private readonly dir: string;
  private readonly ready: Promise<void>;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'blobs');
    this.ready = fs.promises.mkdir(this.dir, { recursive: true }).then(() => undefined);
    // Observe a failed mkdir right away (#6286). Every method awaits `ready`, so
    // the error still reaches whichever call needs the directory; this handler
    // only stops a storage that no method has touched yet from raising an
    // unhandled rejection, which Node and Vitest treat as a process failure.
    this.ready.catch(() => undefined);
  }

  /**
   * Resolves once the blobs directory exists; rejects with the mkdir error if
   * it could not be created. Await it to fail fast at startup, or before
   * removing `dataDir`, instead of learning about it on the first request.
   */
  whenReady(): Promise<void> {
    return this.ready;
  }

  private file(hash: string): string {
    return path.join(this.dir, hash);
  }

  /**
   * Serialize operations on one hash. Without this, a GC sweep can stat a blob
   * as old, and unlink it after a concurrent `put` has already renamed fresh
   * bytes into place - deleting a blob a client believes it just uploaded.
   * Keyed per hash, so unrelated blobs never contend.
   */
  private withLock<T>(hash: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(hash) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    // Keep the chain alive but never let a rejection poison the next waiter.
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(hash, settled);
    void settled.then(() => {
      if (this.locks.get(hash) === settled) this.locks.delete(hash);
    });
    return run;
  }

  async put(hash: string, bytes: Uint8Array, contentType?: string): Promise<ServerBlobMeta> {
    await this.ready;
    return this.withLock(hash, async () => {
      const file = this.file(hash);
      // Atomic write (temp + rename) so a concurrent/interrupted PUT of the same
      // content-addressed blob can't leave a torn file.
      const tmp = `${file}.tmp-${crypto.randomUUID()}`;
      await fs.promises.writeFile(tmp, bytes);
      await fs.promises.rename(tmp, file);
      return {
        hash,
        byteLength: bytes.byteLength,
        contentType,
        uploadedAt: new Date().toISOString(),
      };
    });
  }

  /**
   * Delete a blob only if it is still older than `cutoffEpochMs`.
   *
   * The mtime is re-checked HERE, under the same lock `put` takes, so a blob
   * re-uploaded between a GC plan and its application survives: `put` refreshes
   * mtime via a fresh temp file and rename. Returns whether it deleted.
   */
  async deleteIfOlderThan(hash: string, cutoffEpochMs: number): Promise<boolean> {
    await this.ready;
    return this.withLock(hash, async () => {
      const file = this.file(hash);
      try {
        const stat = await fs.promises.stat(file);
        if (stat.mtimeMs >= cutoffEpochMs) return false;
        await fs.promises.unlink(file);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw err;
      }
    });
  }

  async get(hash: string): Promise<{ bytes: Uint8Array; meta: ServerBlobMeta } | null> {
    await this.ready;
    try {
      const file = this.file(hash);
      const [bytes, stat] = await Promise.all([fs.promises.readFile(file), fs.promises.stat(file)]);
      return {
        bytes: new Uint8Array(bytes),
        meta: { hash, byteLength: stat.size, uploadedAt: stat.mtime.toISOString() },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async has(hash: string): Promise<boolean> {
    await this.ready;
    try {
      await fs.promises.access(this.file(hash));
      return true;
    } catch {
      return false;
    }
  }

  async delete(hash: string): Promise<boolean> {
    await this.ready;
    try {
      await fs.promises.unlink(this.file(hash));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  async list(): Promise<string[]> {
    await this.ready;
    const names = await fs.promises.readdir(this.dir);
    // Exclude in-flight temp files; only return real content-addressed blobs.
    return names.filter((n) => HASH_REGEX.test(n));
  }
}
