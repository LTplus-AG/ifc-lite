/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import type { BackingDatabase } from '../backing-database';
import { GeometryBackingRegistry } from '../geometry-backing-registry';

/** Runs in an exposed-GC subprocess so the normal suite need not enable GC. */
export async function canonicalSourceGcRace(): Promise<void> {
  assert.ok(globalThis.gc, 'the race witness requires --expose-gc');
  const registry = await GeometryBackingRegistry.open({ name: `backing-gc-${process.pid}`, locks: null });
  const backing = await registry.begin('m', { chunkBytes: 1, queueBytes: 1024 * 1024 });
  const piece = (expressId: number, sourceIndices: Uint32Array): MeshData => {
    const indices = Uint32Array.from([0, 1, 2]);
    return { expressId, positions: new Float32Array(9), normals: new Float32Array(9),
      indices, color: [1, 1, 1, 1],
      appearanceSource: { kind: 'canonical-item', indices, sourceIndices } };
  };
  try {
    let source: Uint32Array | undefined = new Uint32Array(1 << 16);
    await backing.writer.append([piece(1, source), piece(2, source)]);
    source = undefined;
    await backing.writer.close();
    const warm = async () => {
      const lease = await backing.reader.leaseChunks([0]);
      lease.release();
    };
    await warm();
    backing.reader.clear();
    const db = (registry as unknown as { db: BackingDatabase }).db;
    const read = db.read.bind(db);
    db.read = async (stores, collect) => {
      const result = await read(stores, collect);
      // WeakRef keep-alive ends at the turn boundary. Force collection after
      // the request saw the weak hit, before the reader resumes from the DB.
      await new Promise<void>((resolve) => setImmediate(resolve));
      globalThis.gc!();
      await new Promise<void>((resolve) => setImmediate(resolve));
      return result;
    };
    const lease = await backing.reader.leaseChunks([1]);
    try {
      assert.equal(lease.meshes[0].appearanceSource?.sourceIndices.length, 1 << 16);
    } finally {
      lease.release();
    }
  } finally {
    await registry.close();
  }
}
