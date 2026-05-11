/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { createCollabDoc } from '../src/doc/schema.js';
import { createEntity, setGeometryRef } from '../src/doc/entity.js';
import { createGeometry, setGeometryBlobHash } from '../src/doc/geometry.js';
import { MemoryBlobStore } from '../src/geometry/blob-store.js';
import {
  collectReferencedBlobHashes,
  planBlobSweep,
  sweepBlobs,
} from '../src/geometry/gc.js';

describe('blob GC', () => {
  it('collects every blob hash reachable from entity geometry refs', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'wall');
    createGeometry(doc, 'g1', { type: 'mesh', source: 'mesh-blob', blobHash: 'a'.repeat(32) });
    setGeometryRef(doc, 'wall', { geomId: 'g1' });

    const referenced = collectReferencedBlobHashes(doc);
    expect(referenced.has('a'.repeat(32))).toBe(true);
  });

  it('plans + sweeps unreferenced blobs older than the epoch', async () => {
    const doc = createCollabDoc();
    createEntity(doc, 'wall');
    createGeometry(doc, 'g1', { type: 'mesh', source: 'mesh-blob' });
    setGeometryRef(doc, 'wall', { geomId: 'g1' });

    const store = new MemoryBlobStore();
    // Referenced via doc once we wire it.
    const used = await store.put(new Uint8Array([1, 2, 3]));
    setGeometryBlobHash(doc, 'g1', used.hash);
    // Unreferenced: leftover after a swap, never linked.
    const orphan = await store.put(new Uint8Array([9, 9, 9]));

    const referenced = collectReferencedBlobHashes(doc);
    expect(referenced.has(used.hash)).toBe(true);
    expect(referenced.has(orphan.hash)).toBe(false);

    const decision = await planBlobSweep(store, referenced, { epochMs: 0 });
    expect(decision.drop).toEqual([orphan.hash]);
    expect(decision.reclaimBytes).toBeGreaterThan(0);

    const freed = await sweepBlobs(store, decision);
    expect(freed).toBeGreaterThan(0);
    expect(await store.has(orphan.hash)).toBe(false);
    expect(await store.has(used.hash)).toBe(true);
  });

  it('respects the epoch grace window', async () => {
    const store = new MemoryBlobStore();
    const orphan = await store.put(new Uint8Array([0, 0, 0]));

    const decision = await planBlobSweep(store, new Set(), {
      epochMs: 60_000,
      now: () => Date.now() - 30_000, // simulate "30s ago" check
    });
    expect(decision.drop).toEqual([]); // too young
  });
});
