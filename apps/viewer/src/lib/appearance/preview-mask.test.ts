/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { appearanceSourceTriangle, expandAppearanceCorners, type Renderer } from '@ifc-lite/renderer';
import type { ViewerState } from '@/store';
import { bindAppearancePreview } from './preview.js';
import type { AppearancePlan } from './planner-types.js';

// The evaluated source surface is a quad: two triangles over four corners.
const sourceIndices = [0, 1, 2, 0, 2, 3];
const sourcePositions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
function plan(conversion: Partial<NonNullable<AppearancePlan['conversions']>[number]>, item: Partial<AppearancePlan['items'][number]> = {}): AppearancePlan {
  return { sourceRevision: 'r', nextExpressId: 100, nextAvailableExpressId: 106, created: [], edits: [], removed: [], exclusions: [],
    items: [{ productId: 25, geometryItemId: 101, texCoords: [], texCoordIndex: [], sourceIndices, targetIndices: sourceIndices,
      targetVertexCount: 4, previewCornerUvs: [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], targetCornerNormals: Array(18).fill(0).map((_, i) => i % 3 === 1 ? 1 : 0), ...item }],
    conversions: [{ productId: 25, representationId: 23, sourceGeometryItemId: 11, geometryItemId: 101, sourceIndices,
      sourcePositions, sourceNormals: Array(12).fill(0).map((_, i) => i % 3 === 2 ? 1 : 0), sourceOrigin: [0, 0, 0],
      sourceColor: [0.8, 0.2, 0.1, 1], rtcOffset: [0, 0, 0], surfaceFingerprint: 'f'.repeat(64), ...conversion }] };
}
const indices = new Uint32Array(sourceIndices);
const original: MeshData = { expressId: 25, geometryItemId: 11, modelIndex: 0, color: [0.8, 0.2, 0.1, 1],
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, -1, 0, 0, -1]), normals: new Float32Array(12).map((_, i) => i % 3 === 1 ? 1 : 0),
  indices, appearanceSource: { kind: 'canonical-item', indices, sourceIndices: indices } };
const state = { toGlobalId: (_model: string, id: number) => id, models: new Map(), modelPlacement: { frameKey: 'test', placements: new Map() },
  resolveGlobalIdFromModels: (id: number) => ({ modelId: 'model', expressId: id }) } as unknown as ViewerState;
const renderer = (pieces: MeshData[] | undefined) => ({ getScene: () => ({ getMeshDataPieces: () => pieces, isInstancedEntity: () => false }) }) as unknown as Renderer;
const bitmap = {} as ImageBitmap;
const bind = (masked: AppearancePlan, pieces: MeshData[] | undefined = [original]) =>
  bindAppearancePreview(state, renderer(pieces), 'model', masked, bitmap, 'textures/a.png', true, true, expandAppearanceCorners);

// The masked item covers one triangle: three corners of UVs, normals and topology.
const maskedItem = { sourceIndices: [0, 1, 2], targetIndices: [0, 1, 2], targetVertexCount: 3,
  previewCornerUvs: [0, 0, 1, 0, 1, 1], targetCornerNormals: [0, 1, 0, 0, 1, 0, 0, 1, 0] };

test('a face-masked conversion previews as textured and retained parts of one owner (#4404)', () => {
  const [group] = bind(plan({ maskedTriangles: [0], retainedGeometryItemId: 102 }, maskedItem));
  assert.equal(group.globalId, 25);
  assert.deepEqual(group.parts.map(part => part.geometryItemId), [101, 102]);
  const [textured, retained] = group.parts;
  assert.deepEqual([...textured.indices], [0, 1, 2]);
  assert.deepEqual([...textured.positions], [0, 0, 0, 1, 0, 0, 1, 0, -1], 'the textured part expands exactly the masked triangle corners');
  assert.deepEqual([...textured.uvs!], maskedItem.previewCornerUvs);
  assert.equal(textured.textureBitmap, bitmap); assert.equal(textured.textureRef?.url, 'textures/a.png');
  assert.deepEqual(textured.color, [1, 1, 1, 1]);
  assert.deepEqual([...retained.indices], [0, 2, 3], 'the retained part keeps the complementary source corners');
  assert.equal(retained.positions, original.positions);
  assert.deepEqual(retained.color, [0.8, 0.2, 0.1, 1]);
  assert.equal(retained.uvs, undefined); assert.equal(retained.textureRef, undefined); assert.equal(retained.textureBitmap, undefined);
  assert.equal(retained.appearanceSource?.indices, retained.indices);
  assert.equal(appearanceSourceTriangle(textured, 0), 0);
  assert.equal(appearanceSourceTriangle(retained, 0), 1,
    'the retained subset keeps its full evaluated-surface ordinal');
  assert.deepEqual(group.partition, { sourceGeometryItemId: 11, triangleCount: 2,
    before: [{ partId: 0, geometryItemId: 11, triangles: [0, 1] }],
    after: [{ partId: 0, geometryItemId: 101, triangles: [0] }, { partId: 1, geometryItemId: 102, triangles: [1] }] });
  assert.equal(group.geometryItemRemaps, undefined, 'a partition replaces the one-to-one item remap');
});

test('masked partition identities are renderer-global with a federation offset (#4556)', () => {
  const offset = 1_000_000;
  const federatedState = { ...state,
    toGlobalId: (_model: string, id: number) => id + offset,
    resolveGlobalIdFromModels: (id: number) => ({ modelId: 'offset-model', expressId: id - offset }),
  } as unknown as ViewerState;
  const federatedOriginal: MeshData = { ...original, expressId: 25 + offset, geometryItemId: 11 + offset, modelIndex: 1 };
  const [group] = bindAppearancePreview(federatedState, renderer([federatedOriginal]), 'offset-model',
    plan({ maskedTriangles: [0], retainedGeometryItemId: 102 }, maskedItem), bitmap, 'textures/a.png', true, true,
    expandAppearanceCorners);
  assert.equal(group.globalId, 25 + offset);
  assert.equal(group.modelIndex, 1);
  assert.equal(group.partition?.sourceGeometryItemId, 11 + offset);
  assert.deepEqual(group.parts.map(part => part.geometryItemId), [101 + offset, 102 + offset]);
  assert.deepEqual(group.partition?.after.map(part => part.geometryItemId), [101 + offset, 102 + offset]);
});

test('the masked binder refuses inconsistent provenance explicitly (#4404)', () => {
  assert.throws(() => bind(plan({ maskedTriangles: [0], retainedGeometryItemId: 102 })), /Invalid native occurrence conversion provenance/);
  assert.throws(() => bind(plan({ maskedTriangles: [1, 0], retainedGeometryItemId: 102 }, maskedItem)), /Invalid native face mask provenance/);
  assert.throws(() => bind(plan({ maskedTriangles: [0, 1], retainedGeometryItemId: 102 }, maskedItem)), /Invalid native face mask provenance/);
  assert.throws(() => bind(plan({ maskedTriangles: [0] }, maskedItem)), /Invalid native face mask provenance/);
  const half = (from: number): MeshData => {
    const part = new Uint32Array(sourceIndices.slice(from, from + 3));
    return { ...original, indices: part, appearanceSource: { kind: 'canonical-item', indices: part, sourceIndices: indices, cornerIndices: Uint32Array.from([from, from + 1, from + 2]) } };
  };
  const fragmented = bind(plan({ maskedTriangles: [0], retainedGeometryItemId: 102 }, maskedItem), [half(0), half(3)])[0];
  assert.deepEqual(fragmented.parts.map(part => part.geometryItemId), [101, 102]);
  assert.deepEqual(fragmented.partition?.before.map(part => part.triangles), [[0], [1]]);
  assert.throws(() => bind(plan({ maskedTriangles: [0], retainedGeometryItemId: 102 }, maskedItem), [half(0)]), /geometry of IFC object #25 changed/);
  const renumbered = { ...original, indices: new Uint32Array([0, 2, 3, 0, 1, 2]) };
  renumbered.appearanceSource = { kind: 'canonical-item', indices: renumbered.indices, sourceIndices: renumbered.indices };
  assert.throws(() => bind(plan({ maskedTriangles: [0], retainedGeometryItemId: 102 }, maskedItem), [renumbered]), /geometry of IFC object #25 changed/);
  // The same plan without a mask still binds as one textured part.
  const [whole] = bind(plan({}));
  assert.equal(whole.parts.length, 1); assert.equal(whole.partition, undefined);
  assert.deepEqual(whole.geometryItemRemaps, [{ from: 11, to: 101 }]);
  assert.throws(() => bindAppearancePreview(state, renderer(undefined), 'model', plan({}), bitmap, 'textures/a.png', true, true, expandAppearanceCorners), /Geometry for IFC object #25 is not available/);
});

test('a mask crossing forced-size fragments keeps repeated item ids and source appearance (#4556)', () => {
  const full = [0, 1, 2, 0, 2, 3, 1, 4, 2, 4, 5, 2];
  const fullIndices = new Uint32Array(full);
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, -1, 0, 0, -1, 2, 0, 0, 2, 0, -1]);
  const normals = new Float32Array(18).map((_, i) => i % 3 === 1 ? 1 : 0);
  const oldTexture = { textureId: 77, url: 'textures/old.png', repeatS: false, repeatT: false };
  const oldBitmap = {} as ImageBitmap;
  // Equivalent to a six-index streaming threshold: each resident fragment
  // carries two canonical triangles and the same complete source topology.
  const fragment = (second: boolean): MeshData => {
    const fragmentIndices = second ? new Uint32Array([0, 1, 2, 1, 3, 2]) : new Uint32Array(full.slice(0, 6));
    const fragmentPositions = second
      ? new Float32Array([1, 0, 0, 2, 0, 0, 1, 0, -1, 2, 0, -1]) : positions.slice(0, 12);
    return { ...original, positions: fragmentPositions, normals: second ? normals.slice(3, 15) : normals.slice(0, 12), indices: fragmentIndices,
      uvs: new Float32Array(fragmentPositions.length / 3 * 2), textureRef: oldTexture, textureBitmap: oldBitmap,
      appearanceSource: { kind: 'canonical-item', indices: fragmentIndices, sourceIndices: second ? fullIndices.slice() : fullIndices,
        cornerIndices: Uint32Array.from(second ? [6, 7, 8, 9, 10, 11] : [0, 1, 2, 3, 4, 5]) } };
  };
  const base = plan({});
  const crossed: AppearancePlan = { ...base,
    items: [{ ...base.items[0], sourceIndices: [0, 1, 2, 1, 4, 2], targetIndices: [0, 1, 2, 3, 4, 5], targetVertexCount: 6,
      previewCornerUvs: [0, 0, 1, 0, 1, 1, .25, .25, .75, .25, .5, .75],
      targetCornerNormals: Array(18).fill(0).map((_, i) => i % 3 === 1 ? 1 : 0) }],
    conversions: [{ ...base.conversions![0], sourceIndices: full, sourcePositions: Array.from(positions),
      sourceNormals: Array.from(normals), maskedTriangles: [0, 2], retainedGeometryItemId: 102 }] };
  const fragments = [fragment(false), fragment(true)];
  const [group] = bind(crossed, fragments);
  assert.deepEqual(group.parts.map(part => part.geometryItemId), [101, 102, 101, 102]);
  assert.deepEqual(group.partition?.before, [
    { partId: 0, geometryItemId: 11, triangles: [0, 1] },
    { partId: 1, geometryItemId: 11, triangles: [2, 3] },
  ]);
  assert.deepEqual(group.partition?.after.map(part => ({ ...part })), [
    { partId: 0, geometryItemId: 101, triangles: [0] },
    { partId: 1, geometryItemId: 102, triangles: [1] },
    { partId: 2, geometryItemId: 101, triangles: [2] },
    { partId: 3, geometryItemId: 102, triangles: [3] },
  ]);
  assert.deepEqual(group.parts.map(part => [...part.appearanceSource!.cornerIndices!]), [
    [0, 1, 2], [3, 4, 5], [6, 7, 8], [9, 10, 11],
  ], 'every generated local triangle retains its canonical full-surface ordinal');
  assert.deepEqual(group.parts.map(part => appearanceSourceTriangle(part, 0)), [0, 1, 2, 3]);
  for (const part of group.parts) assert.strictEqual(part.appearanceSource?.sourceIndices, fullIndices);
  for (const retained of [group.parts[1], group.parts[3]]) {
    assert.strictEqual(retained.textureRef, oldTexture);
    assert.strictEqual(retained.textureBitmap, oldBitmap);
    assert.ok(retained.uvs, 'the retained fragment keeps its prior UV lane');
  }
  const overlap = fragment(true);
  overlap.appearanceSource = { ...overlap.appearanceSource!, cornerIndices: Uint32Array.from([3, 4, 5, 9, 10, 11]) };
  assert.throws(() => bind(crossed, [fragments[0], overlap]), /overlap/);
});
