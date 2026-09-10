/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linearToSrgb } from '@ifc-lite/data';
import type { MeshData } from '@ifc-lite/geometry';
import { useViewerStore, type ViewerState } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { captureRegion, captureRegistration } from './region';

function fixture() {
  // Coincident first/last triangle vertices deliberately carry distinct UVs.
  const mesh: MeshData = { expressId: 10, color: [1,1,1,1], origin: [2,3,4],
    positions: new Float32Array([0,0,0, 2,0,0, 0,0,-2, 0,0,0, 0,0,-2, -2,0,0]),
    normals: new Float32Array(18), indices: new Uint32Array([0,1,2, 3,4,5]),
    uvs: new Float32Array([0,0, 1,0, 0,1, 1,0.25, 1,1, 0,1]),
    textureRef: { textureId: 5, url: 'textures/capture.png', repeatS: false, repeatT: false } };
  const bounds = { min: { x:0,y:0,z:0 }, max: { x:2,y:2,z:2 } };
  const geometry = { meshes: [mesh], totalTriangles: 2, totalVertices: 6,
    coordinateInfo: { originShift: { x:10,y:20,z:30 }, wasmRtcOffset: { x:5000000,y:100,z:200 },
      originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: true } };
  const model = { ...fixtureModel('capture'), loadedAt: 1, geometryResult: geometry };
  let state: ViewerState = { ...useViewerStore.getState(), models: new Map([['capture', model]]), activeModelId: 'capture',
    geometryResult: geometry, modelPlacement: { ...emptyPlacementState(),
      placements: new Map([['capture', { translation: [7,8,9] as const, locked: false }]]) } };
  return { mesh, getState: () => state, update: (next: typeof state) => { state = next; } };
}

test('capture region preserves explicit triangle order, UV seams and world coordinates without welding (#4380)', () => {
  const { mesh, getState } = fixture();
  const result = captureRegion(mesh, [1,0], captureRegistration('capture', mesh, getState));
  assert.deepEqual(result.mesh.triangles, [[0,1,2],[3,4,5]]);
  assert.deepEqual(result.mesh.uvTriangles, result.mesh.triangles);
  assert.deepEqual(result.mesh.positions[0], [5000019,74,232]);
  assert.deepEqual(result.mesh.positions[3], result.mesh.positions[0]);
  assert.deepEqual(result.mesh.uvs[0], [1,0.75]);
  assert.deepEqual(result.mesh.uvs[3], [0,1]);
  assert.equal(result.mesh.positions.length, 6, 'coincident vertices remain distinct across seam');
  assert.deepEqual(result.textureRef, mesh.textureRef);
  assert.deepEqual([...mesh.indices], [0,1,2,3,4,5], 'source topology untouched');
});

test('capture registration uses stable federation anchor, independent of active model (#4380)', () => {
  const f = fixture(), before = captureRegion(f.mesh, [0], captureRegistration('capture', f.mesh, f.getState));
  const first = f.getState(), different = { ...first.geometryResult!,
    coordinateInfo: { ...first.geometryResult!.coordinateInfo, wasmRtcOffset: { x:123,y:456,z:789 } } };
  const other = { ...fixtureModel('other'), loadedAt: 2, geometryResult: different };
  f.update({ ...first, models: new Map([...first.models, ['other', other]]), activeModelId: 'other', geometryResult: different });
  const after = captureRegion(f.mesh, [0], captureRegistration('capture', f.mesh, f.getState));
  assert.deepEqual(after, before);
});

test('adding an editable destination does not invalidate a prepared scan region (#4477)', () => {
  const f = fixture(), registration = captureRegistration('capture', f.mesh, f.getState);
  const first = f.getState(), destination = fixtureModel('destination');
  f.update({ ...first, models: new Map([...first.models, ['destination', destination]]),
    mutationVersion: first.mutationVersion + 1 });
  assert.doesNotThrow(() => registration.validate());
  assert.equal(captureRegion(f.mesh, [0], registration).mesh.triangles.length, 1);
});

test('capture refuses placement copies and stale sources or workspace movement (#4380)', () => {
  const f = fixture();
  assert.throws(() => captureRegistration('capture', { ...f.mesh }, f.getState), /raw loaded/);
  const registration = captureRegistration('capture', f.mesh, f.getState);
  assert.throws(() => captureRegion({ ...f.mesh }, [0], registration), /another captured/);
  f.update({ ...f.getState(), modelPlacement: { ...f.getState().modelPlacement,
    placements: new Map([['capture', { translation: [8,8,9], locked: false }]]) } });
  assert.throws(() => registration.validate(), /changed/);
  const current = captureRegistration('capture', f.mesh, f.getState);
  f.update({ ...f.getState(), models: new Map() });
  assert.throws(() => current.validate(), /changed/);
});

test('capture rejects invalid regions, missing correspondence, out-of-image UVs and unbaked materials (#4380)', () => {
  const f = fixture(), registration = captureRegistration('capture', f.mesh, f.getState);
  for (const ids of [[], [2], [-1], [0.5], [0,0], new Array<number>(200001).fill(0)]) {
    assert.throws(() => captureRegion(f.mesh, ids, registration));
  }
  f.mesh.uvs![0] = 2;
  assert.throws(() => captureRegion(f.mesh, [0], registration), /non-repeating/);
  f.mesh.uvs![0] = 0; f.mesh.color[0] = 0.5;
  assert.throws(() => captureRegion(f.mesh, [0], captureRegistration('capture', f.mesh, f.getState)), /tint/);
  f.mesh.color[0] = 1; f.mesh.textureRef!.repeatS = true;
  assert.throws(() => registration.validate(), /changed/, 'a sampler edit invalidates an earlier capture');
  const repeated = captureRegion(f.mesh, [0], captureRegistration('capture', f.mesh, f.getState));
  assert.equal(repeated.textureRef.repeatS, true);
  assert.equal(repeated.textureRef.repeatT, false);
  assert.deepEqual(repeated.mesh.uvs[0], [0,1], 'sampler preservation does not wrap or shift source UVs');
});

test('capture bounds compact output rows while allowing a small region of a larger scan (#4380)', () => {
  const f = fixture(), count = 200001;
  f.mesh.positions = new Float32Array(count * 3);
  f.mesh.uvs = new Float32Array(count * 2);
  f.mesh.indices = Uint32Array.from({ length: count }, (_, i) => i);
  const registration = captureRegistration('capture', f.mesh, f.getState);
  assert.equal(captureRegion(f.mesh, [0], registration).mesh.positions.length, 3);
  assert.throws(() => captureRegion(f.mesh, Array.from({ length: count / 3 }, (_, i) => i), registration), /200,000 vertices/);
});


test('explicit white glTF albedo remains neutral at the renderer upload precision (#4380)', () => {
  const f = fixture();
  const white = linearToSrgb(1);
  f.mesh.color = [white, white, white, 1];
  assert.equal(captureRegion(f.mesh,[0],captureRegistration('capture',f.mesh,f.getState)).mesh.triangles.length,1);
  f.mesh.color[0] = linearToSrgb(.9);
  assert.throws(() => captureRegion(f.mesh,[0],captureRegistration('capture',f.mesh,f.getState)), /tint/);
});
