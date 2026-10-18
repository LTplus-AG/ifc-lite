// Names/types verified in candidate frozen glue 3641-4222, its .d.ts, and Rust
// zero_copy/mesh.rs plus geometry_hash getters (see SOURCE-CONTRACT.md).
import assert from 'node:assert/strict';
import { exact } from './exact-wire.mjs';
export const MESH_GETTERS = ('expressId ifcType positions normals indices color shadingColor metallic roughness vertexCount triangleCount hasTexture uvs textureRgba textureWidth textureHeight textureRepeatS textureRepeatT textureId textureUrl geometryClass geometryItemId materialId origin localBounds localToWorld').split(' ');
export const COLLECTION_GETTERS = ('length totalVertices totalTriangles rtcOffsetX rtcOffsetY rtcOffsetZ buildingRotation geometryHashCount diagnostics geometryHashIds geometryHashValues geometryAabbValues geometryVolumeValues geometryClosureFlags').split(' ');
export const COLUMN_TYPES = {
  referencedRepmaps: 'Uint32Array', instantiatedTypeIds: 'Uint32Array', mappedInstancePlan: 'Uint32Array',
  mliElementIds: 'Uint32Array', mliAxis: 'Uint32Array', mliLayerCounts: 'Uint32Array',
  mliDirectionSense: 'Float64Array', mliOffset: 'Float64Array',
  mliLayerMaterialIds: 'Uint32Array', mliLayerThicknesses: 'Float64Array',
};
export function assertLiveColumns(c) {
  for (const [key, type] of Object.entries(COLUMN_TYPES)) {
    assert.ok(ArrayBuffer.isView(c?.[key]) && c[key].constructor.name === type,
      `live typed column required: ${key}`);
  }
  const n = c.mliElementIds.length;
  for (const key of ['mliAxis', 'mliLayerCounts', 'mliDirectionSense', 'mliOffset']) assert.equal(c[key].length, n);
  const layers = c.mliLayerCounts.reduce((a, b) => a + b, 0);
  assert.equal(c.mliLayerMaterialIds.length, layers); assert.equal(c.mliLayerThicknesses.length, layers);
}
export function publicColumnInstall(api, c) {
  assertLiveColumns(c); // never accept exact(event) serialized records
  api.setReferencedRepmaps(c.referencedRepmaps);
  api.setInstantiatedTypeIds(c.instantiatedTypeIds);
  api.setMappedInstancePlan(c.mappedInstancePlan);
  api.setMaterialLayerIndex(c.mliElementIds, c.mliAxis, c.mliLayerCounts,
    c.mliDirectionSense, c.mliOffset, c.mliLayerMaterialIds, c.mliLayerThicknesses);
}
// Capture every actual getter, plus all required names even when missing. Read
// failures remain raw and make status incomplete; one failure does not erase the
// other getter values. The callback must retain the failure in the final receipt.
export function readGetters(obj, required, onFailure) {
  const names = new Set(required);
  for (let p = Object.getPrototypeOf(obj); p && p !== Object.prototype; p = Object.getPrototypeOf(p))
    for (const name of Object.getOwnPropertyNames(p))
      if (Object.getOwnPropertyDescriptor(p, name)?.get) names.add(name);
  const presence = {}, values = {};
  for (const name of names) {
    let descriptor;
    for (let p = obj; p && !descriptor; p = Object.getPrototypeOf(p)) descriptor = Object.getOwnPropertyDescriptor(p, name);
    presence[name] = Boolean(descriptor?.get);
    if (!presence[name]) {
      values[name] = { missingGetter: true }; onFailure(`missing getter ${name}`); continue;
    }
    try { values[name] = exact(obj[name]); }
    catch (error) { values[name] = { getterError: String(error) }; onFailure(`getter ${name}: ${String(error)}`); }
  }
  return { presence, values };
}
// Each cleanup attempt records errors; the outer caller's finally writes the
// receipt even when frees throw. This never makes a cleanup error qualify.
export function cleanup(actions, onFailure) {
  for (const [label, action] of actions) {
    try { action(); } catch (error) { onFailure(`cleanup ${label}: ${String(error)}`); }
  }
}
