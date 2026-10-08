/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `saveToCache` must store a TRUE full-file content hash for BOTH cache tiers
 * (#4269). Before that fix, the write path computed `fullSourceHash` only when
 * `persistSource` was false (the mesh-only tier), so a source-persisting entry
 * could never be background-revalidated — an mtime-preserved,
 * byte-length-preserving in-place edit (invisible to the spread-sampled cache
 * key by design, see `@ifc-lite/cache`'s `source-fingerprint.ts`) was served stale forever.
 *
 * Since #7022 that hash is the load's own placement identity, handed in by the
 * loader: the write stores it and hashes nothing itself, so a cold load digests
 * its source once. The expectation is computed with node:crypto, not with the
 * viewer's hashing, so a hash-function bug cannot self-certify.
 *
 * Drives the REAL hook (`saveToCache`) against fake-indexeddb and reads the
 * persisted record back through the real `getCached`.
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

const MIB = 1024 * 1024;
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
/** Independent expectation: the placement identity's chunked SHA-256 via
 *  node:crypto, NOT the viewer's own `placementSourceIdentity`. */
function referenceIdentity(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const parts = [`placement-sha256-1m-v1:${bytes.byteLength}`];
  for (let start = 0; start < bytes.byteLength; start += MIB) parts.push(sha256(bytes.subarray(start, start + MIB)));
  return `placement-sha256-1m-v1:${sha256(parts.join(':'))}`;
}

async function saveAndRead(key: string, persistSource: boolean) {
  const sourceBuffer = new TextEncoder()
    .encode(`ISO-10303-21; /* ${key} */ END-ISO-10303-21;`).buffer as ArrayBuffer;
  const identity = referenceIdentity(sourceBuffer);
  const subtle = globalThis.crypto.subtle;
  const realDigest = subtle.digest.bind(subtle);
  let digests = 0;
  Object.defineProperty(subtle, 'digest', { configurable: true, writable: true,
    value: (algorithm: AlgorithmIdentifier, data: BufferSource) => { digests++; return realDigest(algorithm, data); } });
  try {
    await act(async () => {
      await saveToCache!(key, buildDataStore(), GEOMETRY, sourceBuffer, `${key}.ifc`, {
        persistSource,
        lastModified: 1_700_000_000_000,
        fullSourceHash: Promise.resolve(identity),
      });
    });
  } finally {
    delete (subtle as { digest?: unknown }).digest;
  }
  const entry = await getCached(key);
  assert.ok(entry, 'the entry must have been written');
  return { entry, identity, digests };
}

describe('saveToCache stores the load\'s full-content hash for BOTH tiers (#4269, #7022)', () => {
  it('a SOURCE-PERSISTING write stores fullSourceHash without hashing the source again', async () => {
    const { entry, identity, digests } = await saveAndRead('fullhash-source-tier', true);
    assert.ok(entry.sourceBuffer, 'the source tier must persist the source buffer');
    assert.equal(
      entry.fullSourceHash,
      identity,
      'a source-persisting entry must carry the full-content hash so a served hit '
      + 'can be background-revalidated (#4269), and it is the load\'s identity (#7022)',
    );
    assert.equal(digests, 0, 'the write reuses the load\'s hash instead of digesting the source a second time');
    assert.equal(entry.lastModified, 1_700_000_000_000, 'the mtime guard field must be stored too');
  });

  it('a MESH-ONLY write stores the same hash, also without hashing', async () => {
    const { entry, identity, digests } = await saveAndRead('fullhash-mesh-only-tier', false);
    assert.equal(entry.sourceBuffer, undefined, 'the mesh-only tier must not persist the source');
    assert.equal(entry.fullSourceHash, identity);
    assert.equal(digests, 0);
  });
});
