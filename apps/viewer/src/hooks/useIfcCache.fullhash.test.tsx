/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `saveToCache` must store the TRUE full-file hash for BOTH cache tiers
 * (#4269). Before the fix, the write path computed `fullSourceHash` only when
 * `persistSource` was false (the mesh-only tier), so a source-persisting entry
 * could never be background-revalidated — an mtime-preserved,
 * byte-length-preserving in-place edit (invisible to the spread-sampled cache
 * key by design, see `sourceFingerprint.ts`) was served stale forever.
 *
 * Drives the REAL hook (`saveToCache`) against fake-indexeddb and reads the
 * persisted record back through the real `getCached`, asserting the stored
 * hash against an INDEPENDENT SHA-256 (node:crypto) rather than the
 * implementation's own `computeFullSourceHash` — so a hash-function bug cannot
 * self-certify.
 */

import 'fake-indexeddb/auto';
import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  StringTable,
  EntityTableBuilder,
  PropertyTableBuilder,
  QuantityTableBuilder,
  RelationshipGraphBuilder,
} from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { GeometryData } from '@ifc-lite/cache';
import { useIfcCache, getCached } from './useIfcCache.js';

function buildDataStore(): IfcDataStore {
  const strings = new StringTable();
  const entityBuilder = new EntityTableBuilder(2, strings);
  entityBuilder.add(1, 'IfcProject', 'guid-project', 'Test Project', '', '', false, false);
  return {
    schemaVersion: 'IFC4',
    entityCount: 1,
    strings,
    entities: entityBuilder.build(),
    properties: new PropertyTableBuilder(strings).build(),
    quantities: new QuantityTableBuilder(strings).build(),
    relationships: new RelationshipGraphBuilder().build(),
  } as unknown as IfcDataStore;
}

const GEOMETRY: GeometryData = {
  meshes: [],
  totalVertices: 0,
  totalTriangles: 0,
  coordinateInfo: {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    hasLargeCoordinates: false,
  },
};

let saveToCache: ReturnType<typeof useIfcCache>['saveToCache'] | null = null;

function Probe(): null {
  ({ saveToCache } = useIfcCache());
  return null;
}

let root: Root | null = null;

beforeEach(async () => {
  saveToCache = null;
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
  assert.ok(saveToCache, 'the hook must expose saveToCache');
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
});

/** Independent expectation: SHA-256 hex via node:crypto, NOT the viewer's own
 *  `computeFullSourceHash`. */
function sha256hex(buffer: ArrayBuffer): string {
  return createHash('sha256').update(new Uint8Array(buffer)).digest('hex');
}

async function saveAndRead(key: string, persistSource: boolean) {
  const sourceBuffer = new TextEncoder()
    .encode(`ISO-10303-21; /* ${key} */ END-ISO-10303-21;`).buffer as ArrayBuffer;
  await act(async () => {
    await saveToCache!(key, buildDataStore(), GEOMETRY, sourceBuffer, `${key}.ifc`, {
      persistSource,
      lastModified: 1_700_000_000_000,
    });
  });
  const entry = await getCached(key);
  assert.ok(entry, 'the entry must have been written');
  return { entry, sourceBuffer };
}

describe('saveToCache stores the full-file validation hash for BOTH tiers (#4269)', () => {
  it('a SOURCE-PERSISTING write stores fullSourceHash (was skipped before the fix)', async () => {
    const { entry, sourceBuffer } = await saveAndRead('fullhash-source-tier', true);
    assert.ok(entry.sourceBuffer, 'the source tier must persist the source buffer');
    assert.equal(
      entry.fullSourceHash,
      sha256hex(sourceBuffer),
      'a source-persisting entry must carry the TRUE full-file SHA-256 so a '
      + 'served hit can be background-revalidated (#4269 — the pre-fix write '
      + 'path computed it only for the mesh-only tier)',
    );
    assert.equal(entry.lastModified, 1_700_000_000_000, 'the mtime guard field must be stored too');
  });

  it('a MESH-ONLY write still stores fullSourceHash (unchanged behavior control)', async () => {
    const { entry, sourceBuffer } = await saveAndRead('fullhash-mesh-only-tier', false);
    assert.equal(entry.sourceBuffer, undefined, 'the mesh-only tier must not persist the source');
    assert.equal(
      entry.fullSourceHash,
      sha256hex(sourceBuffer),
      'the mesh-only tier must keep storing the full-file SHA-256 it already had',
    );
  });
});
