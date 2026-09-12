/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { unpackTransfer } from './wasm-mesh-transfer-contract.mjs';
import { thinWallIfc, thinWallRequest } from './wasm-mesh-transfer-surfaces-contract.mjs';

const THICKNESS = 0.004;
/** Deterministic jitter in (-1, 1), the same hash as the native control. */
function jitter(i, salt) {
  let h = (Math.imul(i, 2654435761) + Math.imul(salt, 40503)) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; h ^= h >>> 13;
  return (h % 20001) / 10000 - 1;
}
/** XZ sheet at `y` over `x` × 0..1 at `spacing` with ±`noise` along Y; station 0 stands 2 m in front (-Y), station 1 behind. */
function sheet(cloud, y, [x0, x1], spacing, noise, facingNegativeY, color) {
  const nx = Math.round((x1 - x0) / spacing), nz = Math.round(1 / spacing);
  for (let i = 0; i <= nx; i++) for (let k = 0; k <= nz; k++) {
    const index = cloud.positions.length / 3;
    const px = Math.min(x1, Math.max(x0, x0 + i * spacing + jitter(index, 1) * spacing * 0.2));
    const pz = Math.min(1, Math.max(0, k * spacing + jitter(index, 2) * spacing * 0.2));
    cloud.positions.push(px, y + jitter(index, 3) * noise, pz);
    cloud.colors.push(...color);
    cloud.normals.push(0, facingNegativeY ? -1 : 1, 0);
    cloud.stations.push(facingNegativeY ? 0 : 1);
  }
}
export function pointCloudRequest(api, cloud, orientation, maxBehindMetres) {
  const request = thinWallRequest(api, {
    kind: 'points', pointCount: cloud.positions.length / 3, orientation, neighborhoodRadiusMetres: 0.03,
    minNeighbors: 4, maxNeighbors: 32, surfaceBandMetres: 0.003,
    viewpoints: orientation === 'viewpoints' ? [[0.5, -2, 0.5], [0.5, 2, 0.5]] : [],
  }, 0.02, maxBehindMetres);
  delete request.sourceImage;
  return request;
}
export function pointPayload(cloud, orientation) {
  return [Float64Array.from(cloud.positions), Uint8Array.from(cloud.colors),
    orientation === 'source-normals' ? Float32Array.from(cloud.normals) : new Float32Array(0),
    orientation === 'viewpoints' ? Uint32Array.from(cloud.stations) : new Uint32Array(0)];
}
/** RGB point-cloud source over the real WASM boundary (#4381): each thin-wall
 * face observes only its own side under every orientation source; holes and
 * sparse captures stay unknown; the payload is bound into the digest. */
export function checkPointTransferContract(IfcAPI) {
  const api = new IfcAPI();
  try {
    const bytes = new TextEncoder().encode(thinWallIfc), noRasters = new Uint8Array(0);
    const run = (request, cloud, orientation) => unpackTransfer(api.planPointTransfer(bytes, JSON.stringify(request), noRasters, ...pointPayload(cloud, orientation)));
    const cloud = { positions: [], colors: [], normals: [], stations: [] };
    sheet(cloud, -0.001, [0, 1], 0.005, 0.001, true, [255, 0, 0]);
    sheet(cloud, THICKNESS + 0.001, [0, 0.5], 0.005, 0.001, false, [0, 0, 255]);
    const digests = new Set();
    for (const orientation of ['source-normals', 'viewpoints', 'target-referenced']) {
      const { metadata, png } = run(pointCloudRequest(api, cloud, orientation, 0.01), cloud, orientation);
      const coverage = metadata.transfer.coverage;
      assert.equal(metadata.transfer.applicable, true, orientation);
      assert.deepEqual(metadata.transfer.source, { kind: 'points', orientation, pointCount: cloud.positions.length / 3 });
      assert.ok(png.length > 0 && metadata.assets.length === 1);
      assert.ok(coverage.observedRasterInteriorTexels > 0);
      assert.equal(coverage.unknownDistanceSamples, 0, JSON.stringify(coverage));
      assert.equal(coverage.unknownSparseSamples, 0, JSON.stringify(coverage));
      assert.ok(Math.abs(coverage.observedAreaEstimateM2 + coverage.unknownAreaEstimateM2 - 2) < 1e-9);
      assert.ok(coverage.observedAreaEstimateM2 > 1.4 && coverage.observedAreaEstimateM2 < 1.6, orientation + ' ' + JSON.stringify(coverage));
      // The uncaptured back half refuses the red front capture by its normal when
      // the points carry an orientation, by target self-occlusion otherwise.
      if (orientation === 'target-referenced') assert.ok(coverage.unknownBehindSamples > 0 && coverage.unknownNormalSamples === 0, JSON.stringify(coverage));
      else assert.ok(coverage.unknownNormalSamples > 0 && coverage.unknownBehindSamples === 0, JSON.stringify(coverage));
      assert.equal(coverage.samples, coverage.observedSamples + coverage.unknownNormalSamples + coverage.unknownBehindSamples + coverage.unknownAmbiguousSamples);
      digests.add(metadata.transfer.preparedSha256);
    }
    assert.equal(digests.size, 3, 'the orientation source is bound into the prepared digest');
    // A hole in the front capture and no back capture: unknown by distance, never painted.
    const holed = { positions: [], colors: [], normals: [], stations: [] };
    sheet(holed, -0.001, [0, 0.4], 0.005, 0.001, true, [255, 0, 0]);
    sheet(holed, -0.001, [0.6, 1], 0.005, 0.001, true, [255, 0, 0]);
    const gap = run(pointCloudRequest(api, holed, 'target-referenced', 0.01), holed, 'target-referenced').metadata.transfer.coverage;
    assert.ok(gap.unknownDistanceSamples > 0 && gap.unknownBehindSamples > 0, JSON.stringify(gap));
    // Too sparse for a local plane almost everywhere (5 cm spacing under a 3 cm
    // support radius): sparse dominates and the nearest colour is never used in its place.
    const sparse = { positions: [], colors: [], normals: [], stations: [] };
    sheet(sparse, -0.001, [0, 1], 0.05, 0, true, [255, 0, 0]);
    const thin = run(pointCloudRequest(api, sparse, 'target-referenced', 0.01), sparse, 'target-referenced').metadata.transfer.coverage;
    assert.ok(thin.unknownSparseSamples > thin.samples / 3 && thin.observedSamples * 100 < thin.samples, JSON.stringify(thin));
    // Payload and orientation must agree; a mesh request cannot carry points and vice versa.
    const recoloured = { ...cloud, colors: cloud.colors.slice() }; recoloured.colors[0] = 7;
    assert.notEqual(run(pointCloudRequest(api, recoloured, 'target-referenced', 0.01), recoloured, 'target-referenced').metadata.transfer.preparedSha256,
      run(pointCloudRequest(api, cloud, 'target-referenced', 0.01), cloud, 'target-referenced').metadata.transfer.preparedSha256);
    assert.throws(() => run(pointCloudRequest(api, cloud, 'source-normals', 0.01), cloud, 'target-referenced'), /orientation/);
    assert.throws(() => run(pointCloudRequest(api, cloud, 'target-referenced', 0.01), cloud, 'viewpoints'), /orientation/);
    const short = pointCloudRequest(api, cloud, 'target-referenced', 0.01); short.source.pointCount -= 1;
    assert.throws(() => run(short, cloud, 'target-referenced'), /point payload/);
    const unknownField = pointCloudRequest(api, cloud, 'target-referenced', 0.01); unknownField.source.gaussianRadius = 0.1;
    assert.throws(() => run(unknownField, cloud, 'target-referenced'), /unknown field/);
    assert.throws(() => api.planMeshTransfer(bytes, JSON.stringify(pointCloudRequest(api, cloud, 'target-referenced', 0.01)), noRasters), /binary point payload/);
  } finally { api.free(); }
}
