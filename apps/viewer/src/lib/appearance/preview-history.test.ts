/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { invertAppearancePartition, type AppearanceChange, type AppearancePartition, type Renderer } from '@ifc-lite/renderer';
import { appearanceHistoryParts } from './preview.js';

function fixture() {
  const before: MeshData = {
    expressId: 19, geometryItemId: 21,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1],
  };
  // UV-dependent welding may choose a different nearby normal representative.
  // The canonical target supplies that shading; triangle positions stay exact.
  const after = { ...before, normals: new Float32Array([0.0004, 0, 0.99999994, 0, 0, 1, 0, 0, 1]) };
  const change: AppearanceChange = { owner: { expressId: 19, modelIndex: 0 }, before: [before], after: [after] };
  const renderer = (current: MeshData) => ({ getScene: () => ({ getMeshDataPieces: () => [current] }), getAppearancePreview: () => ({}) }) as unknown as Renderer;
  return { before, after, change, renderer };
}
describe('appearance history preserves canonical target shading (#4243)', () => {
  it('undoes and redoes the known normal transition on primary-model geometry', () => {
    const f = fixture();
    assert.deepEqual(appearanceHistoryParts(f.renderer(f.after), [f.change], 'undo')[0].parts[0].normals, f.before.normals);
    assert.deepEqual(appearanceHistoryParts(f.renderer(f.before), [f.change], 'redo')[0].parts[0].normals, f.after.normals);
  });
  it('refuses an unexpected current normal change instead of treating it as the saved transition', () => {
    const f = fixture(), changed = { ...f.after, normals: f.after.normals.slice() };
    changed.normals[0] = 0.25;
    assert.throws(() => appearanceHistoryParts(f.renderer(changed), [f.change], 'undo'), /geometry|topology|shading/);
  });
  it('still refuses a saved transition that moves triangle positions', () => {
    const f = fixture(), moved = { ...f.before, positions: f.before.positions.slice() };
    moved.positions[0] = 0.1;
    assert.throws(() => appearanceHistoryParts(f.renderer(f.after), [{ ...f.change, before: [moved] }], 'undo'), /geometry|topology/);
  });
  it('refuses a changed placement origin even when geometry arrays are shared', () => {
    const f = fixture(), moved: MeshData = { ...f.after, origin: [1, 0, 0] };
    assert.throws(() => appearanceHistoryParts(f.renderer(moved), [f.change], 'undo'), /geometry|topology/);
  });
});

it('history reverses only the recorded occurrence item remap (#4404)', () => {
  const f = fixture();
  const after = { ...f.after, geometryItemId: 31 };
  const change = { ...f.change, after: [after], geometryItemRemaps: [{ from: 21, to: 31 }] };
  const undo = appearanceHistoryParts(f.renderer(after), [change], 'undo')[0];
  assert.equal(undo.parts[0].geometryItemId, 21);
  assert.deepEqual(undo.geometryItemRemaps, [{ from: 31, to: 21 }]);
  const redo = appearanceHistoryParts(f.renderer(f.before), [change], 'redo')[0];
  assert.equal(redo.parts[0].geometryItemId, 31);
  assert.throws(() => appearanceHistoryParts(f.renderer(after), [{ ...change, geometryItemRemaps: [] }], 'undo'), /topology/);
  assert.throws(() => appearanceHistoryParts(f.renderer({ ...after, geometryItemId: 99 }), [change], 'undo'), /geometry/);
});

// #4404: a face-masked owner is recorded as a partition. Undo joins the
// textured and retained parts back into the one original through the inverted
// record; Redo splits again. Either direction refuses a changed resident part.
it('history joins and splits a partitioned owner through the inverted partition (#4404)', () => {
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  const original: MeshData = { expressId: 19, geometryItemId: 21, modelIndex: 0, color: [0.8, 0.2, 0.1, 1],
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), normals: new Float32Array(12).map((_, i) => i % 3 === 2 ? 1 : 0),
    indices, appearanceSource: { kind: 'canonical-item', indices, sourceIndices: indices } };
  const texturedIndices = new Uint32Array([0, 1, 2]), retainedIndices = new Uint32Array([0, 2, 3]);
  const textured: MeshData = { ...original, geometryItemId: 101, color: [1, 1, 1, 1], indices: texturedIndices,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1]), textureRef: { textureId: -1, url: 'textures/a.png', repeatS: true, repeatT: true },
    textureBitmap: {} as ImageBitmap, appearanceSource: { kind: 'canonical-item', indices: texturedIndices, sourceIndices: indices,
      cornerIndices: new Uint32Array([0, 1, 2]) } };
  const retained: MeshData = { ...original, geometryItemId: 102, indices: retainedIndices,
    appearanceSource: { kind: 'canonical-item', indices: retainedIndices, sourceIndices: indices,
      cornerIndices: new Uint32Array([3, 4, 5]) } };
  const partition = { sourceGeometryItemId: 21, triangleCount: 2,
    before: [{ partId: 0, geometryItemId: 21, triangles: [0, 1] }],
    after: [{ partId: 0, geometryItemId: 101, triangles: [0] }, { partId: 1, geometryItemId: 102, triangles: [1] }] };
  const change: AppearanceChange = { owner: { expressId: 19, modelIndex: 0 }, before: [original], after: [textured, retained], partition };
  const renderer = (current: MeshData[]) => ({ getScene: () => ({ getMeshDataPieces: () => current }), getAppearancePreview: () => ({}) }) as unknown as Renderer;
  const undo = appearanceHistoryParts(renderer([textured, retained]), [change], 'undo')[0];
  assert.deepEqual(undo.parts.map(part => part.geometryItemId), [21]);
  assert.equal(undo.parts[0].positions, original.positions);
  assert.deepEqual(undo.partition, invertAppearancePartition(partition));
  assert.equal(undo.geometryItemRemaps, undefined);
  const redo = appearanceHistoryParts(renderer([original]), [change], 'redo')[0];
  assert.deepEqual(redo.parts.map(part => part.geometryItemId), [101, 102]);
  assert.equal(redo.parts[0].textureBitmap, textured.textureBitmap);
  assert.deepEqual(redo.partition, partition);
  assert.throws(() => appearanceHistoryParts(renderer([textured]), [change], 'undo'), /geometry or shading changed/);
  assert.throws(() => appearanceHistoryParts(renderer([retained, textured]), [change], 'undo'), /geometry or shading changed/);
  const moved = { ...retained, positions: retained.positions.slice() }; moved.positions[0] = 0.25;
  assert.throws(() => appearanceHistoryParts(renderer([textured, moved]), [change], 'undo'), /geometry or shading changed/);
  assert.throws(() => appearanceHistoryParts(renderer([textured, retained]), [change], 'redo'), /geometry or shading changed/);
});

it('history joins and re-splits streamed parts with repeated item ids (#4556)', () => {
  const fullIndices = new Uint32Array([0, 1, 2, 0, 2, 3, 1, 4, 2, 4, 5, 2]);
  const fullPositions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 0, 0, 2, 1, 0]);
  const fullNormals = new Float32Array(18).map((_, i) => i % 3 === 2 ? 1 : 0);
  const make = (geometryItemId: number, triangles: readonly number[]): MeshData => {
    const cornerIndices = Uint32Array.from(triangles.flatMap(ordinal => [ordinal * 3, ordinal * 3 + 1, ordinal * 3 + 2]));
    const indices = Uint32Array.from(cornerIndices, corner => fullIndices[corner]);
    return { expressId: 19, modelIndex: 0, geometryItemId, color: [geometryItemId / 100, 0, 0, 1],
      positions: fullPositions, normals: fullNormals, indices,
      appearanceSource: { kind: 'canonical-item', indices, sourceIndices: fullIndices, cornerIndices } };
  };
  const before = [make(21, [0, 1]), make(21, [2, 3])];
  const after = [make(101, [0]), make(102, [1]), make(101, [2]), make(102, [3])];
  const partition: AppearancePartition = { sourceGeometryItemId: 21, triangleCount: 4,
    before: [{ partId: 0, geometryItemId: 21, triangles: [0, 1] }, { partId: 1, geometryItemId: 21, triangles: [2, 3] }],
    after: [{ partId: 0, geometryItemId: 101, triangles: [0] }, { partId: 1, geometryItemId: 102, triangles: [1] },
      { partId: 2, geometryItemId: 101, triangles: [2] }, { partId: 3, geometryItemId: 102, triangles: [3] }] };
  const change: AppearanceChange = { owner: { expressId: 19, modelIndex: 0 }, before, after, partition };
  const renderer = (current: MeshData[]) => ({ getScene: () => ({ getMeshDataPieces: () => current }),
    getAppearancePreview: () => ({}) }) as unknown as Renderer;
  const undo = appearanceHistoryParts(renderer(after), [change], 'undo')[0];
  assert.deepEqual(undo.parts.map(part => part.geometryItemId), [21, 21]);
  assert.deepEqual(undo.partition, invertAppearancePartition(partition));
  const redo = appearanceHistoryParts(renderer(before), [change], 'redo')[0];
  assert.deepEqual(redo.parts.map(part => part.geometryItemId), [101, 102, 101, 102]);
  assert.deepEqual(redo.partition, partition);
  assert.throws(() => appearanceHistoryParts(renderer([after[2], after[1], after[0], after[3]]), [change], 'undo'), /geometry or shading changed/);
  const staleSource = fullIndices.slice(); staleSource[6] = 0;
  const stale = { ...after[2], appearanceSource: { ...after[2].appearanceSource!, sourceIndices: staleSource } };
  assert.throws(() => appearanceHistoryParts(renderer([after[0], after[1], stale, after[3]]), [change], 'undo'), /geometry or shading changed/);
});
