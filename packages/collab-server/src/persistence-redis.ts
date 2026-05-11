/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Redis persistence backend (spec §12.2).
 *
 * Same trick as `S3Persistence`: implemented against a tiny
 * `RedisLikeClient` interface so deployers wire up `ioredis`,
 * `node-redis`, or any compatible client without forcing
 * `@ifc-lite/collab-server` to take a hard dep.
 *
 * Layout per room:
 *   - key `<prefix><roomId>:snap`   ← compacted state (Buffer)
 *   - list `<prefix><roomId>:log`   ← rolling log frames (Buffer items)
 *
 * `load(roomId)` returns `concat(snap, ...all log items)`. `compact`
 * sets `:snap` and trims `:log` to empty. `drop` deletes both keys.
 */

import type { Persistence } from './persistence.js';

/**
 * Minimal Redis-like surface. The two big Node clients (ioredis,
 * node-redis 4+) both satisfy this when wrapped trivially. Buffers
 * are returned for binary fidelity.
 */
export interface RedisLikeClient {
  /** Get a binary string value, or `null` if missing. */
  getBuffer(key: string): Promise<Buffer | null>;
  /** Set a binary string value (no expiry by default). */
  set(key: string, value: Buffer): Promise<unknown>;
  /** RPUSH a buffer onto a list. */
  rpush(key: string, value: Buffer): Promise<unknown>;
  /** LRANGE 0 -1 returning all binary items in order. */
  lrangeBuffer(key: string): Promise<Buffer[]>;
  /** DEL one or more keys. */
  del(...keys: string[]): Promise<unknown>;
  /** LTRIM <key> <start> <stop>. */
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
}

export interface RedisPersistenceOptions {
  client: RedisLikeClient;
  /** Optional key prefix, e.g. `'collab:'`. Default `''`. */
  prefix?: string;
}

export class RedisPersistence implements Persistence {
  private readonly client: RedisLikeClient;
  private readonly prefix: string;

  constructor(opts: RedisPersistenceOptions) {
    this.client = opts.client;
    this.prefix = opts.prefix ?? '';
  }

  private snapKey(roomId: string): string {
    return `${this.prefix}${roomId}:snap`;
  }
  private logKey(roomId: string): string {
    return `${this.prefix}${roomId}:log`;
  }

  async load(roomId: string): Promise<Uint8Array | null> {
    const [snap, frames] = await Promise.all([
      this.client.getBuffer(this.snapKey(roomId)),
      this.client.lrangeBuffer(this.logKey(roomId)),
    ]);
    const parts: Buffer[] = [];
    if (snap && snap.byteLength > 0) parts.push(snap);
    for (const f of frames ?? []) parts.push(f);
    if (parts.length === 0) return null;
    const total = parts.reduce((n, p) => n + p.byteLength, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), o);
      o += p.byteLength;
    }
    return out;
  }

  async append(roomId: string, update: Uint8Array): Promise<void> {
    await this.client.rpush(this.logKey(roomId), Buffer.from(update));
  }

  async compact(roomId: string, mergedState: Uint8Array): Promise<void> {
    await this.client.set(this.snapKey(roomId), Buffer.from(mergedState));
    // Truncate the log to empty.
    await this.client.ltrim(this.logKey(roomId), 1, 0);
  }

  async drop(roomId: string): Promise<void> {
    await this.client.del(this.snapKey(roomId), this.logKey(roomId));
  }
}
