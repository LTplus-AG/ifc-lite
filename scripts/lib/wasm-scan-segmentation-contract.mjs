/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';

/** Seeded box room, Z up: 5 x 4 m, 2.6 m high, a column r 0.25 at (3.5, 2), 3 mm noise, 1% outliers. */
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
  const column = Math.round(2 * Math.PI * 0.25 * 2.6 * 3000);
  for (let i = 0; i < column; i++) {
    const [angle, z] = [random() * 2 * Math.PI, random() * 2.6];
    points.push(3.5 + 0.25 * Math.cos(angle) + 0.003 * gauss(), 2 + 0.25 * Math.sin(angle) + 0.003 * gauss(), z + 0.003 * gauss());
  }
  const outliers = Math.round(points.length / 300);
  for (let i = 0; i < outliers; i++) points.push(random() * 5, random() * 4, random() * 2.6);
  return { positions: Float32Array.from(points), faces };
}

/** Seeded floor (4 x 4 m, Z up) with a regular octagonal column, circumradius 0.6 m at (2, 2), 3 mm noise (#6893). */
function octagon() {
  let state = 6893n;
  const random = () => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    return Number(state >> 11n) / 2 ** 53;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(random(), 1e-300))) * Math.cos(2 * Math.PI * random());
  const [r, apothem] = [0.6, 0.6 * Math.cos(Math.PI / 8)];
  const inside = (x, y) => [...Array(8).keys()].every(k => {
    const m = (2 * Math.PI * (k + 0.5)) / 8;
    return (x - 2) * Math.cos(m) + (y - 2) * Math.sin(m) < apothem;
  });
  const points = [];
  const push = p => points.push(...p.map(v => v + 0.003 * gauss()));
  for (let i = 0; i < 16 * 3000; i++) {
    const [x, y] = [random() * 4, random() * 4];
    if (!inside(x, y)) push([x, y, 0]);
  }
  const corner = k => [2 + r * Math.cos((2 * Math.PI * k) / 8), 2 + r * Math.sin((2 * Math.PI * k) / 8)];
  const side = 2 * r * Math.sin(Math.PI / 8);
  for (let k = 0; k < 8; k++) {
    const [a, b] = [corner(k), corner(k + 1)];
    for (let i = 0; i < Math.round(side * 2.6 * 3000); i++) {
      const [s, z] = [random(), random() * 2.6];
      push([a[0] + s * (b[0] - a[0]), a[1] + s * (b[1] - a[1]), z]);
    }
  }
  return Float32Array.from(points);
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
const CYLINDER_FIELDS = ['arcDegrees', 'axisDirection', 'axisEnd', 'axisStart', 'faceted', 'heightRange', 'inlierPoints', 'inlierVoxels', 'length', 'orientation', 'radius', 'rmsMetres'];

/** Actual Rust/WASM calls: plane and cylinder recovery, order invariance, strict options. */
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
    assert.equal(report.cylinders.length, 1, 'the column, and nothing along the room edges');
    const [column] = report.cylinders;
    assert.deepEqual(Object.keys(column).sort(), CYLINDER_FIELDS);
    assert.equal(column.faceted, null, 'a round column');
    assert.ok(Math.abs(column.radius - 0.25) < 0.01, `column radius ${column.radius}`);
    assert.equal(column.orientation, 'vertical');
    assert.ok(Math.hypot(column.axisStart[0] - 3.5, column.axisStart[1] - 2) < 0.015, `column axis ${column.axisStart}`);
    assert.ok(column.length > 2.4 && column.length < 2.7, `column length ${column.length}`);
    assert.equal(decode(api.segmentScanPoints(positions, '{"detectCylinders":false}')).cylinders.length, 0);
    // A polygonal column is one faceted cylinder, and its faces are not also planes (#6893).
    const prism = decode(api.segmentScanPoints(octagon(), '{}'));
    assert.equal(prism.cylinders.length, 1, 'the octagonal column');
    const [faceted] = prism.cylinders;
    assert.equal(faceted.faceted?.faces, 8);
    assert.ok(Math.abs(faceted.radius - 0.6) < 0.01, `circumradius ${faceted.radius}`);
    assert.ok(Math.abs(faceted.faceted.apothem - 0.6 * Math.cos(Math.PI / 8)) < 0.01, `apothem ${faceted.faceted.apothem}`);
    assert.equal(prism.planes.length, 1, 'only the floor remains a plane');
    assert.equal(prism.stats.planesAbsorbedIntoCylinders, 8);
    // Integer voxel sums: any point order yields the identical report bytes.
    assert.deepEqual(api.segmentScanPoints(shuffled(positions), options), bytes);
    assert.throws(() => api.segmentScanPoints(positions, '{"surprise":1}'), /unknown field/);
    assert.throws(() => api.segmentScanPoints(positions, ' '.repeat(64 * 1024 + 1)), /64 KiB/);
    assert.throws(() => api.segmentScanPoints(positions.subarray(0, 4), '{}'), /xyz triples/);
    assert.throws(() => api.segmentScanPoints(positions, '{"voxelSizeMetres":0}'), /voxelSizeMetres/);
  } finally { api.free(); }
}
