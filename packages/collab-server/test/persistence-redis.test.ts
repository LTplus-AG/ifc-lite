/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  RedisPersistence,
  type RedisLikeClient,
} from '../src/persistence-redis.js';

/** Tiny in-memory fake matching the RedisLikeClient surface. */
function fakeRedis(): { client: RedisLikeClient; store: Map<string, Buffer | Buffer[]> } {
  const store = new Map<string, Buffer | Buffer[]>();
  const client: RedisLikeClient = {
    async getBuffer(key) {
      const v = store.get(key);
      return v instanceof Buffer ? v : null;
    },
    async set(key, value) {
      store.set(key, Buffer.from(value));
      return 'OK';
    },
    async rpush(key, value) {
      const arr = (store.get(key) as Buffer[] | undefined) ?? [];
      if (!Array.isArray(arr)) throw new Error('wrong type');
      arr.push(Buffer.from(value));
      store.set(key, arr);
      return arr.length;
    },
    async lrangeBuffer(key) {
      const arr = store.get(key);
      return Array.isArray(arr) ? arr : [];
    },
    async del(...keys) {
      for (const k of keys) store.delete(k);
      return keys.length;
    },
    async ltrim(key, start, stop) {
      // ltrim 1 0 = make empty (start>stop).
      if (start > stop) {
        store.set(key, []);
      }
      return 'OK';
    },
  };
  return { client, store };
}

describe('RedisPersistence', () => {
  it('append + load round-trip', async () => {
    const { client } = fakeRedis();
    const p = new RedisPersistence({ client });
    expect(await p.load('room')).toBeNull();
    await p.append('room', new Uint8Array([1, 2]));
    await p.append('room', new Uint8Array([3, 4]));
    const all = await p.load('room');
    expect(all).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('compact replaces snap and clears the log', async () => {
    const { client, store } = fakeRedis();
    const p = new RedisPersistence({ client, prefix: 'collab:' });
    await p.append('room', new Uint8Array([1]));
    await p.compact('room', new Uint8Array([9, 9]));

    expect(await p.load('room')).toEqual(new Uint8Array([9, 9]));
    const log = store.get('collab:room:log');
    expect(Array.isArray(log) ? log.length : -1).toBe(0);
  });

  it('drop removes both keys', async () => {
    const { client, store } = fakeRedis();
    const p = new RedisPersistence({ client });
    await p.compact('room', new Uint8Array([1]));
    await p.append('room', new Uint8Array([2]));
    await p.drop('room');
    expect(store.size).toBe(0);
  });
});
