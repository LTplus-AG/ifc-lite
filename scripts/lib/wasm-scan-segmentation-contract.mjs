/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';

/** Seeded box room, Z up: 5 x 4 m, 2.6 m high, 3 mm noise, 1% outliers. */
function room() {
  let state = 6870n;
  const random = () => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    return Number(state >> 11n) / 2 ** 53;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(random(), 1e-300))) * Math.cos(2 * Math.PI * random());
  const faces = [
    { n: [0, 0, 1], at: [0, 0, 0], u: [5, 0, 0], v: [0, 4, 0] },
    { n: [0, 0, -1], at: [0, 0, 2.6], u: [5, 0, 0], v: [0, 4, 0] },
    { n: [1, 0, 0], at: [0, 0, 0], u: [0, 4, 0], v: [0, 0, 2.6] },
    { n: [-1, 0, 0], at: [5, 0, 0], u: [0, 4, 0], v: [0, 0, 2.6] },
    { n: [0, 1, 0], at: [0, 0, 0], u: [5, 0, 0], v: [0, 0, 2.6] },
    { n: [0, -1, 0], at: [0, 4, 0], u: [5, 0, 0], v: [0, 0, 2.6] },
  ];
  const points = [];
  for (const f of faces) {
    const count = Math.round(Math.hypot(...f.u) * Math.hypot(...f.v) * 3000);
    for (let i = 0; i < count; i++) {
      const [s, t] = [random(), random()];
      for (let a = 0; a < 3; a++) points.push(f.at[a] + s * f.u[a] + t * f.v[a] + 0.003 * gauss());
    }
  }
  const outliers = Math.round(points.length / 300);
  for (let i = 0; i < outliers; i++) points.push(random() * 5, random() * 4, random() * 2.6);
  return { positions: Float32Array.from(points), faces };
}

/** Same triples, Fisher-Yates permuted by a fixed seed. */
function shuffled(positions) {
  const out = positions.slice();
  let state = 99;
  for (let i = out.length / 3 - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    for (let a = 0; a < 3; a++) [out[i * 3 + a], out[j * 3 + a]] = [out[j * 3 + a], out[i * 3 + a]];
  }
  return out;
}

const PLANE_FIELDS = ['areaSquareMetres', 'centroid', 'd', 'extent', 'inlierPoints', 'inlierVoxels', 'normal', 'normalSource', 'orientation', 'rmsMetres'];

/** Actual Rust/WASM calls: plane recovery, order invariance, strict options. */
export function checkScanSegmentationContract(IfcAPI) {
  const api = new IfcAPI();
  const decode = bytes => JSON.parse(new TextDecoder().decode(bytes));
  try {
    const { positions, faces } = room();
    const options = JSON.stringify({ scannerPosition: [2.5, 2, 1.5] });
    const bytes = api.segmentScanPoints(positions, options);
    const report = decode(bytes);
    assert.equal(report.algorithm, 'ifclite-scan-planes-v1');
    assert.equal(report.stats.inputPoints, positions.length / 3);
    assert.equal(report.planes.length, faces.length, 'six faces, no extra planes from outliers');
    assert.deepEqual(Object.keys(report.planes[0]).sort(), PLANE_FIELDS);
    for (const face of faces) {
      const d = -face.n.reduce((sum, v, a) => sum + v * face.at[a], 0);
      const found = report.planes.find(p => p.normal.reduce((sum, v, a) => sum + v * face.n[a], 0) > Math.cos(Math.PI / 180));
      assert.ok(found, `face ${face.n} recovered within 1 degree, facing the scanner`);
      assert.ok(Math.abs(found.d - d) < 0.01, `face ${face.n} offset ${found.d} vs ${d}`);
      assert.equal(found.normalSource, 'scanner');
      assert.equal(found.orientation, face.n[2] === 0 ? 'vertical' : 'horizontal');
    }
    // Integer voxel sums: any point order yields the identical report bytes.
    assert.deepEqual(api.segmentScanPoints(shuffled(positions), options), bytes);
    assert.throws(() => api.segmentScanPoints(positions, '{"surprise":1}'), /unknown field/);
    assert.throws(() => api.segmentScanPoints(positions, ' '.repeat(64 * 1024 + 1)), /64 KiB/);
    assert.throws(() => api.segmentScanPoints(positions.subarray(0, 4), '{}'), /xyz triples/);
    assert.throws(() => api.segmentScanPoints(positions, '{"voxelSizeMetres":0}'), /voxelSizeMetres/);
  } finally { api.free(); }
}
