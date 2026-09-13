/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { applyFederationOffsetToMesh } from './ingest/federationOffset.js';
import { meshedFillItems } from './symbolic-meshed-fills.js';
import { buildSymbolicRichChannels } from './symbolic-rich-channels.js';
import { createEmptyFlatSymbolic, buildParseResult } from '../lib/overlay-parse/symbolic-parse.js';

function mesh(owner: number, item?: number): MeshData {
  return { expressId: owner, geometryItemId: item,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]), color: [1, 0, 0, 1] };
}
function parsed() {
  const flat = createEmptyFlatSymbolic();
  flat.typeNames = ['IfcAnnotation'];
  flat.fillOwner = new Uint32Array([1, 1, 2, 1]);
  flat.fillGeometryItem = new Uint32Array([11, 12, 11, 0]);
  flat.fillType = new Uint16Array(4);
  flat.fillFlags = new Uint8Array(4);
  flat.fillWorldY = new Float32Array([3, 3, 3, 3]);
  flat.fillColor = new Float32Array(Array.from({ length: 4 }, () => [1, 0, 0, 1]).flat());
  flat.fillHatch = new Float32Array(16);
  flat.fillPoints = new Float32Array(Array.from({ length: 4 }, () => [0, 0, 1, 0, 0, 1]).flat());
  flat.fillPointStart = new Uint32Array([0, 6, 12, 18, 24]);
  flat.fillHoleStart = new Uint32Array(5);
  return buildParseResult(flat, { elementToStorey: new Map(), storeyElevations: new Map() });
}
const params = { enabled: true, effectiveGridEnabled: false, clipEnabled: false,
  clipPos: 0, clipDepth: 1, fallbackY: 0 };

it('omits only the exact meshed owner/item from 3D while retaining all 2D fills (#4459)', () => {
  const cached = parsed();
  const untouched = buildSymbolicRichChannels([{ cached }], params);
  assert.equal(untouched.fills.length, 4);
  const filtered = buildSymbolicRichChannels([{ cached, isMeshedFill: meshedFillItems([mesh(1, 11)], id => id) }], params);
  assert.equal(filtered.fills.length, 3);
  assert.deepEqual(filtered.fills.map(f => f.points), untouched.fills.slice(1).map(f => f.points));
  assert.equal(buildSymbolicRichChannels([{ cached }], params).fills.length, 4,
    '3D routing must not mutate the cached 2D drawing');
});

it('keeps federated collisions and unknown/empty mesh provenance visible (#4459)', () => {
  const a = parsed(), b = parsed();
  const result = buildSymbolicRichChannels([
    { cached: a, isMeshedFill: meshedFillItems([mesh(1, 11)], id => id) },
    { cached: b, isMeshedFill: meshedFillItems([], id => id) },
  ], params);
  assert.equal(result.fills.length, 7);
  const empty = { ...mesh(1, 11), indices: new Uint32Array() };
  assert.equal(buildSymbolicRichChannels([{ cached: a,
    isMeshedFill: meshedFillItems([empty, mesh(1)], id => id) }], params).fills.length, 4);
});

it('matches both ids after the actual loader federation transformation (#4459)', () => {
  const state = useViewerStore.getState();
  state.clearAllModels();
  try {
    state.registerModelOffset('primary', 100);
    const offset = state.registerModelOffset('secondary', 100);
    assert.ok(offset > 0);
    const secondaryMesh = mesh(1, 11);
    applyFederationOffsetToMesh(secondaryMesh, offset);
    const secondary = meshedFillItems([secondaryMesh], id => state.toGlobalId('secondary', id));
    assert.equal(buildSymbolicRichChannels([{ cached: parsed(), isMeshedFill: secondary }], params).fills.length, 3);
    const primary = meshedFillItems([secondaryMesh], id => state.toGlobalId('primary', id));
    assert.equal(buildSymbolicRichChannels([{ cached: parsed(), isMeshedFill: primary }], params).fills.length, 4);
  } finally { state.clearAllModels(); }
});

it('retains uploaded identity after actual bounded CPU geometry release (#4459)', () => {
  const state = useViewerStore.getState();
  state.clearAllModels();
  const present = mesh(1, 11), empty = { ...mesh(1, 12), indices: new Uint32Array() };
  useViewerStore.setState({ boundedGeometryMode: true, geometryResult: {
    meshes: [present, empty], totalTriangles: 1, totalVertices: 3,
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false,
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } } },
  } });
  try {
    state.releaseGeometryMemory();
    assert.equal(present.indices.length, 0, 'CPU buffers really were released');
    const result = buildSymbolicRichChannels([{ cached: parsed(),
      isMeshedFill: meshedFillItems([present, empty], id => id) }], params);
    assert.equal(result.fills.length, 3, 'released mesh still routes through GPU geometry; empty item does not');
    present.geometryItemId = 12;
    assert.equal(meshedFillItems([present], id => id)(1, 12), false, 'stale identity cannot claim a replacement item');
  } finally { state.clearAllModels(); useViewerStore.setState({ boundedGeometryMode: false }); }
});
