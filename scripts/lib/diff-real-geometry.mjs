/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { IfcAPI } from '../../packages/wasm/pkg/ifc-lite.js';
import { extractGeometryFingerprints } from '../../packages/geometry/dist/geometry-fingerprints.js';

/** #8042: canonical Rust element production, not GeometryRouter or Qto volume.
 * The caller caps file size before parsing; cap jobs before meshing as well.
 * No viewer, workers, downloads, or second geometry implementation required. */
export function enrichGeometry(bytes, fingerprints) {
  const api = new IfcAPI();
  try {
    api.setComputeGeometryHashes(1e-3);
    const pre = api.buildPrePassOnce(bytes);
    assert.ok(pre.totalJobs > 0 && pre.totalJobs <= 4096,
      `acceptance fixture must have 1..4096 geometry jobs, got ${pre.totalJobs}`);
    const collection = api.processGeometryBatch(
      bytes, pre.jobs, pre.unitScale, ...pre.rtcOffset, pre.needsShift,
      pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors,
      pre.planeAngleToRadians, pre.materialElementIds, pre.materialColorCounts, pre.materialColors,
    );
    try {
      const ids = collection.geometryHashIds;
      const hashes = collection.geometryHashValues;
      const boxes = collection.geometryAabbValues;
      const volumes = collection.geometryVolumeValues;
      assert.ok(hashes instanceof BigUint64Array);
      assert.ok(boxes instanceof Float64Array && volumes instanceof Float64Array);
      assert.ok(ids.length > 0 && collection.totalTriangles > 0, 'real geometry must be nonempty');
      assert.equal(hashes.length, ids.length);
      assert.equal(boxes.length, ids.length * 6);
      assert.equal(volumes.length, ids.length);
      assert.equal(new Set(ids).size, ids.length, 'one geometry record per express id');
      // Reuse the production reader's stride, coordinate frame and absent
      // sentinel handling. Read each copy-to-JS getter only once above.
      const geometry = extractGeometryFingerprints({
        geometryHashCount: ids.length, geometryHashIds: ids, geometryHashValues: hashes,
        geometryAabbValues: boxes, geometryVolumeValues: volumes,
      });
      const rows = fingerprints.map(row => {
        const measured = geometry.get(row.ref);
        if (!measured) return { ...row };
        if (measured.aabb) assert.ok(measured.aabb.min.every((min, axis) => min <= measured.aabb.max[axis]));
        return {
          ...row, geometryHash: measured.hash,
          ...(measured.aabb ? { aabb: measured.aabb } : {}),
          ...(measured.volume === undefined ? {} : { volume: measured.volume }),
        };
      });
      const hashed = rows.filter(row => row.geometryHash !== undefined);
      const closed = hashed.filter(row => row.volume !== undefined);
      assert.ok(hashed.length > 0, 'real geometry ids must join the CLI projection by express id');
      assert.ok(closed.length > 0, 'fixture must expose at least one producer-proved closed solid');
      return {
        rows,
        evidence: {
          jobs: pre.totalJobs, triangles: collection.totalTriangles,
          hashed: hashed.length, closed: closed.length,
        },
      };
    } finally { collection.free(); }
  } finally {
    try { api.clearPrePassCache(); } finally { api.free(); }
  }
}
