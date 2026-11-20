/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10876: a mesh with empty arrays adds a record but no bytes, so the byte
 * bounds alone neither sealed a chunk nor paused an append over a list of
 * them. Records bound both now.
 */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { MeshData } from '@ifc-lite/geometry';
import { BackingDatabase } from './backing-database';
import { GeometryBackingRegistry } from './geometry-backing-registry';

const empty = (expressId: number): MeshData => ({ expressId, positions: new Float32Array(0), normals: new Float32Array(0),
  indices: new Uint32Array(0), color: [1, 1, 1, 1] });

it('#10876 an append of empty-geometry meshes seals record-bounded chunks and pauses on queued chunks', async () => {
  const registry = await GeometryBackingRegistry.open({ name: `writer-records-${process.pid}`, locks: null });
  const original = BackingDatabase.prototype.commit;
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  BackingDatabase.prototype.commit = async function (this: BackingDatabase, ...args: Parameters<typeof original>) {
    await gate; // storage is slow: nothing commits until released
    return original.apply(this, args);
  };
  try {
    const backing = await registry.begin('m', { chunkRecords: 100, queueChunks: 2 });
    let appended = false;
    const appending = backing.writer.append(Array.from({ length: 1000 }, (_, i) => empty(i + 1))).then(() => { appended = true; });
    await new Promise((done) => setTimeout(done, 20));
    const queued = (backing.writer as unknown as { queue: unknown[] }).queue.length;
    assert.equal(appended, false, 'the append waits for room instead of encoding all 1,000 records at once');
    assert.ok(queued <= 3, `at most the bound of queued chunks plus the one in flight (${queued})`);
    release();
    await appending;
    await backing.writer.close();
    assert.equal(backing.directory.chunks.length, 10, '1,000 records sealed in chunks of at most 100');
  } finally {
    BackingDatabase.prototype.commit = original;
    release();
    await registry.close();
  }
});
