/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { MeshData } from '@ifc-lite/geometry';
import { fixtureModel } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { sameLandmarkGeometry } from './geometry-proof';
import { targetTransferFrame } from './transfer-frame';
import { validateTransferReview, type ScanTransferSettings } from './prepare-transfer';
import type { ScanRegistrationRequest, ScanRegistrationReport } from './types';

const settings: ScanTransferSettings = { toleranceMetres: 0.01, reviewed: true, texelsPerMetre: 64, maxDistanceMetres: 0.02, minNormalDot: 0.8, ambiguityDistanceMetres: 0.001, maxBehindMetres: 0.005,
  neighborhoodRadiusMetres: 0.03, minNeighbors: 4, maxNeighbors: 32, surfaceBandMetres: 0.003 };
test('transfer review rejects the independently wrong actual browser check despite an unchanged fit #4381', () => {
  const load = (name: string) => (JSON.parse(readFileSync(new URL(`../../../../../../docs/architecture/evidence/scan-alignment-workbench/${name}.json`, import.meta.url), 'utf8')) as { result: { request: ScanRegistrationRequest; report: ScanRegistrationReport } }).result;
  const good = load('good'), wrong = load('wrong-heldout');
  assert.doesNotThrow(() => validateTransferReview(good, settings));
  assert.deepEqual(good.report.rotation, wrong.report.rotation);
  assert.throws(() => validateTransferReview(wrong, settings), /exceeds/);
  assert.throws(() => validateTransferReview(good, { ...settings, reviewed: false }), /Review/);
  assert.throws(() => validateTransferReview({ ...good, request: { ...good.request, heldOut: good.request.heldOut.slice(0, 3) } }, settings), /four/);
});
test('known appearance vertex duplication preserves barycentric geometry but moved or reordered corners do not #4381', () => {
  const mesh: MeshData = { expressId: 10, geometryItemId: 8, positions: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), indices: new Uint32Array([0, 1, 2]), normals: new Float32Array(9), color: [1, 1, 1, 1], origin: [1e6, 0, 0] };
  const duplicate: MeshData = { ...mesh, positions: new Float32Array([7, 8, 9, 1, 2, 3, 4, 5, 6]), indices: new Uint32Array([1, 2, 0]), uvs: new Float32Array([0, 0, 1, 0, 0, 1]) };
  assert.equal(sameLandmarkGeometry(mesh, duplicate), true);
  assert.equal(sameLandmarkGeometry(mesh, { ...duplicate, indices: new Uint32Array([2, 1, 0]) }), false);
  assert.equal(sameLandmarkGeometry(mesh, { ...duplicate, origin: [1e6 + 1, 0, 0] }), false);
});
test('target frame restores unequal federation rebases exactly once and ignores camera building rotation metadata #4381', () => {
  const first = fixtureModel('anchor'), target = fixtureModel('target');
  const geometry = { meshes: [], totalTriangles: 0, totalVertices: 0 };
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
  const info = { originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: true, originShift: { x: 100, y: 200, z: 300 }, wasmRtcOffset: { x: 1000, y: 2000, z: 3000 }, buildingRotation: Math.PI / 2 };
  const models = new Map([['anchor', { ...first, loadedAt: 1, geometryResult: { ...geometry, coordinateInfo: info } }], ['target', { ...target, loadedAt: 2, geometryResult: { ...geometry, coordinateInfo: { ...info, originShift: { x: 10, y: 20, z: 30 } } } }]]);
  const state = { ...useViewerStore.getState(), models, modelPlacement: { ...emptyPlacementState(), placements: new Map([['target', { translation: [1, 2, 3] as const, locked: false }]]) } };
  assert.deepEqual(targetTransferFrame(state, 'target'), { rotation: [[1,0,0],[0,1,0],[0,0,1]], sourceAnchor: [0,0,0], targetAnchor: [91,-268,183] });
  assert.deepEqual(targetTransferFrame({ ...state, models: new Map([['target', models.get('target')!]]) }, 'target').targetAnchor, [1,2,3]);
  assert.throws(() => targetTransferFrame({ ...state, models: new Map([['target', { ...models.get('target')!, federationAlignmentStatus: 'same-crs' }]]) }, 'target'), /realigned/);
});
