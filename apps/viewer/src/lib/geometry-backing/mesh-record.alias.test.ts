/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10876: the record codec restores array identities: a canonical source that
 * aliases the corner mapping reads back as one array, as it was resident.
 */

import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { MeshData } from '@ifc-lite/geometry';
import { decodeMeshRecord, encodeMeshRecord, SourcePool, TextureBitmapTable } from './mesh-record';

it('#10876 a canonical source aliasing the corner mapping reads back as the same array', () => {
  const shared = Uint32Array.from([0, 1, 2]);
  const mesh = { expressId: 1, positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array(9),
    indices: Uint32Array.from([0, 1, 2]), color: [1, 1, 1, 1],
    appearanceSource: { kind: 'canonical-item', indices: Uint32Array.from([0, 1, 2]), sourceIndices: shared, cornerIndices: shared } } as unknown as MeshData;
  const encoded = encodeMeshRecord(mesh, new SourcePool(), new TextureBitmapTable());
  const pooled = new Map(encoded.sources.map((source) => [source.id, source.indices]));
  const decoded = decodeMeshRecord(structuredClone(encoded.record), { source: (id) => pooled.get(id)!, bitmap: () => undefined });
  const appearance = decoded.appearanceSource as unknown as { sourceIndices: Uint32Array; cornerIndices: Uint32Array; indices: Uint32Array };
  assert.equal(appearance.sourceIndices, appearance.cornerIndices, 'one array, as it was resident');
  assert.deepEqual([...appearance.cornerIndices], [0, 1, 2]);
  assert.notEqual(appearance.sourceIndices, appearance.indices, 'and still distinct from the fence');
});
