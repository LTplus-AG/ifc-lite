/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Drop-in replacement for the removed `IfcAPI.parseMeshes(content)`.
 *
 * Runs the canonical geometry path — `buildPrePassOnce` + a single
 * `processGeometryBatch` over all jobs — and returns a `MeshCollection`-like
 * facade exposing the members the old collection did (`length`, `get(i)`,
 * `totalVertices`, `totalTriangles`, `rtcOffset*`, `hasRtcOffset()`,
 * `buildingRotation`, `free()`), so existing script assertions work unchanged.
 *
 * Each mesh is copied out into a plain JS object and the underlying
 * wasm `MeshDataJs` / `MeshCollection` handles are freed immediately —
 * mirroring `convertMeshCollectionToBatch` in the geometry package. This is
 * essential when scripts run many files through a single `IfcAPI`: leaving
 * wasm handles unfreed would grow wasm memory until later files OOM.
 *
 * @param {object} api  An initialized `IfcAPI` instance.
 * @param {string} content  IFC STEP text.
 */
export function parseMeshesViaPrePass(api, content) {
  const bytes = new TextEncoder().encode(content);
  const pre = api.buildPrePassOnce(bytes);
  const meshes = [];
  let totalVertices = 0;
  let totalTriangles = 0;

  const total = (pre && pre.totalJobs) || 0;
  const rtcX = pre && pre.rtcOffset ? (pre.rtcOffset[0] || 0) : 0;
  const rtcY = pre && pre.rtcOffset ? (pre.rtcOffset[1] || 0) : 0;
  const rtcZ = pre && pre.rtcOffset ? (pre.rtcOffset[2] || 0) : 0;

  if (pre && pre.jobs && total > 0) {
    const col = api.processGeometryBatch(
      bytes, pre.jobs, pre.unitScale, rtcX, rtcY, rtcZ, pre.needsShift,
      pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors,
    );
    try {
      for (let i = 0; i < col.length; i++) {
        const m = col.get(i);
        if (!m) continue;
        // Copy out into a plain JS object, then free the wasm handle.
        meshes.push({
          expressId: m.expressId,
          ifcType: m.ifcType,
          positions: m.positions,
          normals: m.normals,
          indices: m.indices,
          color: m.color,
          vertexCount: m.vertexCount,
          triangleCount: m.triangleCount,
          free: () => {},
        });
        totalVertices += m.vertexCount;
        totalTriangles += m.triangleCount;
        m.free();
      }
    } finally {
      col.free();
    }
  }

  if (api.clearPrePassCache) api.clearPrePassCache();

  return {
    length: meshes.length,
    get: (i) => meshes[i],
    totalVertices,
    totalTriangles,
    rtcOffsetX: rtcX,
    rtcOffsetY: rtcY,
    rtcOffsetZ: rtcZ,
    hasRtcOffset: () => Boolean(pre && pre.needsShift),
    buildingRotation: (pre && pre.buildingRotation) || 0,
    free: () => {},
  };
}
