/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { captureIdentity } from './interleaved-identity.mjs';
import { LIMITS } from './interleaved-plan.mjs';

// Stated invariant: every covered raw channel changes identity, including
// instanced-only owners. These are typed payload fixtures, not a mock result.
function fixture(t) {
  const mesh = { expressId: 10, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]),
    color: [1, 0, 0, 1] };
  const packed = new ArrayBuffer(88), view = new DataView(packed);
  for (const offset of [0, 20, 40, 60]) view.setFloat32(offset, 1, true);
  view.setUint32(64, 42, true); view.setFloat32(68, 1, true); view.setFloat32(80, 1, true);
  const template = { modelIndex: 0, positions: mesh.positions.slice(), normals: mesh.normals.slice(),
    indices: mesh.indices.slice(), instanceData: packed, canonicalAnchors: new Float64Array([1, 2, 3]),
    canonicalMatrixTranslations: new Float32Array([1, 2, 3]), localMin: [0, 0, 0], localMax: [1, 1, 0] };
  const scene = { instancedTemplateCpu: [template],
    instancedEntityMap: new Map([[42, [{ templateIndex: 0, byteOffset: 0, originalColor: [1, 0, 0, 1], finishBits: 0 }]]]),
    getAllMeshDataExpressIds: () => [10, ...scene.instancedEntityMap.keys()],
    getInstancedEntityCount: () => scene.instancedEntityMap.size,
    getInstancedTemplates: () => [{ instanceCount: 1 }] };
  const geometry = { meshes: [mesh], coordinateInfo: {}, totalVertices: 6, totalTriangles: 2 };
  const data = { entities: { count: 2 }, properties: { count: 0, getForEntity: () => [] },
    entityIndex: { byType: new Map([['IfcWall', [10, 42]]]) } };
  const model = { loadState: 'complete', geometryResult: geometry, ifcDataStore: data };
  const state = { models: new Map([['one', model]]), loading: false, geometryStreamingActive: false };
  const renderer = { isReady: () => true, getScene: () => scene };
  const canvas = { __reactFiber$test: { memoizedState: { memoizedState: { current: renderer } } } };
  for (const [key, value] of Object.entries({ document: { querySelector: () => canvas },
    __ifc_lite_viewer_store__: { getState: () => state } })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else delete globalThis[key]; });
  }
  return { mesh, template, scene, state, data, model };
}

test('#6537 raw flat position/normal/index/appearance channels each affect identity', async t => {
  const { mesh } = fixture(t), baseline = (await captureIdentity(LIMITS)).sha256;
  for (const [key, index, value] of [['positions', 0, 0.25], ['normals', 0, 0.5], ['indices', 0, 1], ['color', 0, 0.75]]) {
    const before = mesh[key][index]; mesh[key][index] = value;
    assert.notEqual((await captureIdentity(LIMITS)).sha256, baseline, key);
    mesh[key][index] = before;
  }
});
test('#6537 raw instance matrices/colors/anchors/normals and canonical translations affect identity', async t => {
  const { template } = fixture(t), baseline = (await captureIdentity(LIMITS)).sha256;
  for (const [key, value] of [['normals', 0.5], ['canonicalAnchors', 1.00000000001], ['canonicalMatrixTranslations', 0.125]]) {
    const before = template[key][0]; template[key][0] = value;
    assert.notEqual((await captureIdentity(LIMITS)).sha256, baseline, key); template[key][0] = before;
  }
  const view = new DataView(template.instanceData);
  for (const offset of [0, 68, 84]) {
    const before = view.getUint32(offset, true); view.setUint32(offset, before ^ 1, true);
    assert.notEqual((await captureIdentity(LIMITS)).sha256, baseline, `packed byte ${offset}`);
    view.setUint32(offset, before, true);
  }
});
test('#6537 duplicate flat pieces are retained while publication order is irrelevant', async t => {
  const { mesh, model } = fixture(t);
  const baseline = (await captureIdentity(LIMITS)).sha256;
  model.geometryResult.meshes.push({ ...mesh, positions: mesh.positions.slice() });
  const duplicate = (await captureIdentity(LIMITS)).sha256;
  assert.notEqual(duplicate, baseline);
  model.geometryResult.meshes.reverse();
  assert.equal((await captureIdentity(LIMITS)).sha256, duplicate);
});
test('#6537 unsupported appearance or unknown private fields refuse rather than certify', async t => {
  const { mesh, template, data } = fixture(t);
  mesh.uvs = new Float32Array(6);
  await assert.rejects(captureIdentity(LIMITS), /UV\/texture/); delete mesh.uvs;
  template.newAppearance = 'unsupported';
  await assert.rejects(captureIdentity(LIMITS), /unknown raw template/); delete template.newAppearance;
  data.entityIndex.byType.set('IfcTextLiteral', [99]);
  await assert.rejects(captureIdentity(LIMITS), /text appearance/);
});
test('#6537 missing instance owners, duplicate records and bounded work refuse', async t => {
  const { scene } = fixture(t);
  scene.instancedEntityMap.get(42).push({ ...scene.instancedEntityMap.get(42)[0] });
  await assert.rejects(captureIdentity(LIMITS), /duplicate occurrence/);
  scene.instancedEntityMap.get(42).pop();
  await assert.rejects(captureIdentity({ ...LIMITS, oneBufferBytes: 4 }), /one buffer/);
  await assert.rejects(captureIdentity({ ...LIMITS, records: 1 }), /walk bound/);
  scene.instancedEntityMap.clear();
  await assert.rejects(captureIdentity(LIMITS), /unowned retained template/);
});
