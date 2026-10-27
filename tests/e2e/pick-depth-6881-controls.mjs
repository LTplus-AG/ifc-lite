/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';

/** #6881: mutate a stated triangle fixture through the actual fingerprint. */
export async function runGeometryControls(geometryWitness) {
  const previous = globalThis.__ifc_lite_viewer_store__;
  const fixture = { meshes: [{ expressId: 7,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]), color: [1, 0, 0, 1] }],
  totalTriangles: 1, totalVertices: 3, coordinateInfo: { origin: [0, 0, 0] },
  instancedGeometryHashes: new Map([[10, 123n], [11, 456n]]) };
  let result = structuredClone(fixture);
  const model = { loadState: 'complete', ifcDataStore: { entities: { expressId: new Uint32Array([7]) } }, idOffset: 0, get geometryResult() { return result; } };
  const state = { loading: false, geometryStreamingActive: false, models: new Map([['triangle', model]]) };
  globalThis.__ifc_lite_viewer_store__ = { getState: () => state };
  const capture = async () => JSON.stringify(await geometryWitness());
  const controls = [];
  try {
    const original = await capture();
    for (const [name, mutate] of [
      ['position', r => { r.meshes[0].positions[0] = 0.25; }],
      ['index', r => { r.meshes[0].indices[0] = 2; }],
      ['normal', r => { r.meshes[0].normals[0] = 1; }],
      ['color', r => { r.meshes[0].color[1] = 1; }],
      ['origin', r => { r.coordinateInfo.origin[0] = 5000000; }],
      ['signed-zero', r => { r.coordinateInfo.origin[0] = -0; }],
      ['instance-hash', r => { r.instancedGeometryHashes.set(10, 124n); }],
      ['item-identity', r => { r.meshes[0].geometryItemId = 42; }],
    ]) {
      result = structuredClone(fixture); mutate(result);
      assert.notEqual(await capture(), original, name); controls.push({ name, passed: true });
    }
    result = { ...structuredClone(fixture), instancedGeometryHashes: new Map([[11, 456n], [10, 123n]]) };
    assert.equal(await capture(), original);
    controls.push({ name: 'map-insertion-order', passed: true });
    result = structuredClone(fixture);
    result.meshes.push({ ...structuredClone(fixture.meshes[0]), expressId: 8 });
    result.totalTriangles = 2; result.totalVertices = 6;
    const twoMeshes = await capture(); result.meshes.reverse();
    assert.equal(await capture(), twoMeshes);
    result.meshes.pop(); assert.notEqual(await capture(), twoMeshes);
    controls.push({ name: 'mesh-order-and-multiplicity', passed: true });
    result = structuredClone(fixture); state.loading = true;
    await assert.rejects(capture, /Incomplete publication/); state.loading = false;
    model.loadState = 'failed'; await assert.rejects(capture, /Incomplete model/); model.loadState = 'complete';
    model.loadState = undefined; assert.equal(await capture(), original);
    const metadata = model.ifcDataStore; delete model.ifcDataStore;
    await assert.rejects(capture, /Incomplete model/); model.ifcDataStore = metadata;
    state.models.clear(); await assert.rejects(capture, /Incomplete publication/);
    controls.push({ name: 'loading-failed-and-empty-publications-refused', passed: true });
    return { scope: 'Fingerprint algorithm invariants on a stated triangle fixture; not native GPU qualification', controls };
  } finally {
    if (previous === undefined) delete globalThis.__ifc_lite_viewer_store__;
    else globalThis.__ifc_lite_viewer_store__ = previous;
  }
}
