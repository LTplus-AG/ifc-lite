/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  S3Persistence,
  type S3Commands,
  type S3LikeClient,
} from '../src/persistence-s3.js';

/**
 * Tiny in-memory shim that satisfies the S3LikeClient + S3Commands
 * contract. The real AWS SDK fits the same shape; this test shows
 * exactly which surface the persistence layer touches.
 */
function makeFakeS3() {
  const store = new Map<string, Buffer>();

  class PutObjectCommand {
    constructor(public input: { Bucket: string; Key: string; Body: Buffer | Uint8Array }) {}
  }
  class GetObjectCommand {
    constructor(public input: { Bucket: string; Key: string }) {}
  }
  class DeleteObjectCommand {
    constructor(public input: { Bucket: string; Key: string }) {}
  }
  class ListObjectsV2Command {
    constructor(
      public input: { Bucket: string; Prefix?: string; ContinuationToken?: string },
    ) {}
  }

  // Page size for the paginated list mock. Real S3 caps at 1000; keep it
  // small so the pagination test doesn't need thousands of keys.
  const PAGE_SIZE = 3;

  const client: S3LikeClient = {
    async send(command) {
      if (command instanceof PutObjectCommand) {
        const { Key, Body } = command.input;
        store.set(Key, Body instanceof Buffer ? Body : Buffer.from(Body));
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const buf = store.get(command.input.Key);
        if (!buf) throw { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } };
        return {
          Body: { transformToByteArray: async () => new Uint8Array(buf) },
        };
      }
      if (command instanceof DeleteObjectCommand) {
        store.delete(command.input.Key);
        return {};
      }
      if (command instanceof ListObjectsV2Command) {
        const prefix = command.input.Prefix ?? '';
        // Deterministic order so the continuation token (an offset) pages
        // through the full key set exactly once, mirroring S3 semantics.
        const matching = Array.from(store.keys())
          .filter((k) => k.startsWith(prefix))
          .sort();
        const offset = command.input.ContinuationToken
          ? Number(command.input.ContinuationToken)
          : 0;
        const page = matching.slice(offset, offset + PAGE_SIZE);
        const nextOffset = offset + page.length;
        const IsTruncated = nextOffset < matching.length;
        return {
          Contents: page.map((Key) => ({ Key })),
          IsTruncated,
          NextContinuationToken: IsTruncated ? String(nextOffset) : undefined,
        };
      }
      throw new Error('unknown command');
    },
  };

  const commands: S3Commands = {
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
    ListObjectsV2Command,
  };

  return { client, commands, store };
}

describe('S3Persistence', () => {
  it('append + load round-trip', async () => {
    const { client, commands } = makeFakeS3();
    const p = new S3Persistence({ client, commands, bucket: 'b' });
    expect(await p.load('room')).toBeNull();
    await p.append('room', new Uint8Array([1, 2, 3]));
    await p.append('room', new Uint8Array([4, 5, 6]));
    const all = await p.load('room');
    expect(all).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
  });

  it('compact replaces snap and clears the log', async () => {
    const { client, commands, store } = makeFakeS3();
    const p = new S3Persistence({ client, commands, bucket: 'b' });
    await p.append('room', new Uint8Array([1, 2]));
    await p.append('room', new Uint8Array([3, 4]));
    await p.compact('room', new Uint8Array([9, 9, 9, 9]));
    // Expect: snap exists, log dir is empty.
    expect(store.has('room.snap')).toBe(true);
    const logKeys = Array.from(store.keys()).filter((k) => k.startsWith('room.log/'));
    expect(logKeys).toEqual([]);
    const merged = await p.load('room');
    expect(merged).toEqual(new Uint8Array([9, 9, 9, 9]));
  });

  it('load pages through a truncated ListObjectsV2 result (no dropped frames)', async () => {
    const { client, commands } = makeFakeS3();
    const p = new S3Persistence({ client, commands, bucket: 'b' });
    // 7 frames > PAGE_SIZE (3) ⇒ spans 3 list pages. A single-page load
    // would silently drop the tail; assert every frame is replayed in order.
    const frames = [
      [1],
      [2],
      [3],
      [4],
      [5],
      [6],
      [7],
    ];
    for (const f of frames) await p.append('room', new Uint8Array(f));
    const all = await p.load('room');
    expect(all).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7]));
  });

  it('compact paginates removeLog so no log frames are orphaned', async () => {
    const { client, commands, store } = makeFakeS3();
    const p = new S3Persistence({ client, commands, bucket: 'b' });
    for (let i = 0; i < 7; i++) await p.append('room', new Uint8Array([i]));
    await p.compact('room', new Uint8Array([42]));
    const logKeys = Array.from(store.keys()).filter((k) => k.startsWith('room.log/'));
    expect(logKeys).toEqual([]);
  });

  it('drop removes everything for the room', async () => {
    const { client, commands, store } = makeFakeS3();
    const p = new S3Persistence({ client, commands, bucket: 'b', prefix: 'col/' });
    await p.append('room', new Uint8Array([1]));
    await p.compact('room', new Uint8Array([1, 1]));
    await p.append('room', new Uint8Array([2]));
    await p.drop('room');
    const remaining = Array.from(store.keys()).filter((k) => k.includes('room'));
    expect(remaining).toEqual([]);
  });
});
