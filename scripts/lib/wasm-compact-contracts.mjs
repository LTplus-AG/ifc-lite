/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `MeshCollection.encodeCompact` across the real wasm boundary.
 *
 * Each fixture is meshed twice through the load path's own calls
 * (`buildPrePassOnce` + `processGeometryBatch`): once read as f32 arrays, the
 * reference, and once encoded first. The contract:
 *
 * - without the call nothing changes: two plain runs are byte-identical;
 * - a mesh the encoder takes has its arrays emptied, and its records decode to
 *   the reference within half a lattice step on every axis (0.49 mm at level
 *   10, the documented tolerance), with a box equal to the f64 fold of
 *   the reference positions;
 * - a mesh the encoder refuses keeps the reference's bytes, so the caller's
 *   f32 path draws it as before;
 * - the columns are index-parallel and in range, and each row carries its
 *   source vertex count (the camera fit weighs compact meshes by it).
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const RECORD_BYTES = 12;
const TABLE_STRIDE = 7;
const REFUSAL_KINDS = 9;
const CELL_METRES = 32;
/** Half a step, plus the f64 rounding of forming `origin + position` here and in Rust. */
const HALF_STEP = 0.5 + 1e-6;

/** Fixtures: one committed (always runs), the rest from `pnpm fixtures`. */
const FIXTURES = [
  { path: 'rust/geometry/tests/fixtures/issue_1910_building_shell_geometry.ifc', committed: true },
  { path: 'tests/models/buildingsmart/column-straight-rectangle-tessellation.ifc' },
  { path: 'tests/models/ara3d/AC20-FZK-Haus.ifc' },
  { path: 'tests/models/ara3d/duplex.ifc' },
];

/** Run the load path's batch call over every job and hand the live collection to `read`. */
function withCollection(api, bytes, read) {
  const pre = api.buildPrePassOnce(bytes);
  const [rx, ry, rz] = pre.rtcOffset ? Array.from(pre.rtcOffset) : [0, 0, 0];
  const collection = api.processGeometryBatch(
    bytes, pre.jobs, pre.unitScale, rx || 0, ry || 0, rz || 0, pre.needsShift,
    pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors,
  );
  try {
    return read(collection);
  } finally {
    collection.free();
    api.clearPrePassCache?.();
  }
}

/** Copy every mesh out (and free its handle), as the worker's extraction does. */
function readMeshes(collection) {
  const meshes = [];
  for (let i = 0; i < collection.length; i++) {
    const m = collection.get(i);
    try {
      meshes.push({
        expressId: m.expressId, positions: m.positions, normals: m.normals, indices: m.indices,
        origin: m.origin ? Array.from(m.origin) : [0, 0, 0],
      });
    } finally {
      m.free();
    }
  }
  return meshes;
}

/** Twice the summed triangle area of an indexed mesh, from a per-vertex position reader. */
function doubleArea(indices, start, count, vertex) {
  let sum = 0;
  for (let i = start; i < start + count; i += 3) {
    const a = vertex(indices[i]), b = vertex(indices[i + 1]), c = vertex(indices[i + 2]);
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
    sum += Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
  }
  return sum;
}

/** Check one encoded row against its reference mesh; returns `[referenceArea, decodedArea]` (doubled). */
function checkRow(batch, row, reference) {
  const { records, indices, table, windows, bounds } = batch;
  const t = row * TABLE_STRIDE;
  const vertexStart = table[t + 1], vertexCount = table[t + 2], indexStart = table[t + 3], indexCount = table[t + 4];
  const step = 2 ** -table[t + 5];
  assert.equal(table[t + 6], reference.positions.length / 3, `row ${row}: source vertex count`);
  assert.ok(table[t + 5] >= 9 && table[t + 5] <= 14, `row ${row}: level ${table[t + 5]}`);
  assert.ok(vertexCount > 0 && vertexCount <= 65535 && indexCount > 0 && indexCount % 3 === 0, `row ${row}: counts`);
  assert.ok((vertexStart + vertexCount) * RECORD_BYTES <= records.length && indexStart + indexCount <= indices.length, `row ${row}: ranges`);

  const view = new DataView(records.buffer, records.byteOffset + vertexStart * RECORD_BYTES, vertexCount * RECORD_BYTES);
  const window = [windows[row * 3], windows[row * 3 + 1], windows[row * 3 + 2]];
  const nodes = new Set();
  for (let v = 0; v < vertexCount; v++) {
    const q = [view.getUint16(v * RECORD_BYTES, true), view.getUint16(v * RECORD_BYTES + 2, true), view.getUint16(v * RECORD_BYTES + 4, true)];
    nodes.add(`${q[0]},${q[1]},${q[2]}`);
    assert.equal(view.getUint32(v * RECORD_BYTES + 8, true) & 0x00ffffff, reference.expressId, `row ${row}: entity lane`);
  }
  for (let i = indexStart; i < indexStart + indexCount; i++) assert.ok(indices[i] < vertexCount, `row ${row}: index in range`);

  // Every reference vertex has a record within half a step on each axis, and the box is its f64 fold.
  const { positions, origin } = reference;
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let p = 0; p < positions.length; p += 3) {
    const candidates = [[], [], []];
    for (let axis = 0; axis < 3; axis++) {
      const world = origin[axis] + positions[p + axis];
      box[axis] = Math.min(box[axis], world);
      box[axis + 3] = Math.max(box[axis + 3], world);
      const x = world / step - window[axis];
      for (const q of [Math.floor(x), Math.ceil(x)]) if (Math.abs(q - x) <= HALF_STEP) candidates[axis].push(q);
    }
    const found = candidates[0].some((x) => candidates[1].some((y) => candidates[2].some((z) => nodes.has(`${x},${y},${z}`))));
    assert.ok(found, `row ${row}: vertex ${p / 3} of #${reference.expressId} has no record within half a step (${step} m)`);
  }
  for (let k = 0; k < 6; k++) assert.equal(bounds[row * 6 + k], box[k], `row ${row}: box component ${k}`);

  const referenceArea = doubleArea(reference.indices, 0, reference.indices.length,
    (i) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]);
  const decodedArea = doubleArea(indices, indexStart, indexCount,
    (i) => [view.getUint16(i * RECORD_BYTES, true) * step, view.getUint16(i * RECORD_BYTES + 2, true) * step, view.getUint16(i * RECORD_BYTES + 4, true) * step]);
  return [referenceArea, decodedArea];
}

function checkFixture(api, bytes, label) {
  const reference = withCollection(api, bytes, readMeshes);
  const again = withCollection(api, bytes, readMeshes);
  assert.equal(again.length, reference.length, `${label}: mesh count is stable`);
  for (let i = 0; i < reference.length; i++) {
    for (const field of ['positions', 'normals', 'indices']) {
      assert.deepEqual(again[i][field], reference[i][field], `${label}: mesh ${i} ${field} without the encoder`);
    }
  }

  const encoded = withCollection(api, bytes, (collection) => {
    const batch = collection.encodeCompact(CELL_METRES);
    try {
      return {
        meshCount: batch.meshCount, records: batch.records, indices: batch.indices, table: batch.table,
        windows: batch.windows, bounds: batch.bounds, cells: batch.cells, totals: batch.totals,
        refusals: batch.refusals, meshes: readMeshes(collection),
      };
    } finally {
      batch.free();
    }
  });

  assert.ok(encoded.records instanceof Uint8Array && encoded.indices instanceof Uint16Array && encoded.table instanceof Uint32Array);
  assert.ok(encoded.windows instanceof Float64Array && encoded.bounds instanceof Float64Array && encoded.cells instanceof Int32Array);
  assert.ok(encoded.totals instanceof Float64Array && encoded.refusals instanceof Uint32Array);
  const rows = encoded.meshCount;
  assert.equal(encoded.table.length, rows * TABLE_STRIDE);
  assert.equal(encoded.windows.length, rows * 3);
  assert.equal(encoded.bounds.length, rows * 6);
  assert.equal(encoded.cells.length, rows * 3);
  assert.equal(encoded.records.length % RECORD_BYTES, 0);
  assert.equal(encoded.refusals.length, REFUSAL_KINDS);
  const refused = encoded.refusals.reduce((sum, n) => sum + n, 0);
  assert.equal(rows + refused, reference.length, `${label}: every mesh is encoded or refused`);
  assert.ok(rows > 0, `${label}: the encoder takes at least one mesh`);

  const taken = new Set();
  let referenceArea = 0, decodedArea = 0, inTriangles = 0;
  for (let row = 0; row < rows; row++) {
    const index = encoded.table[row * TABLE_STRIDE];
    assert.ok(index < reference.length && !taken.has(index), `${label}: row ${row} names one mesh once`);
    taken.add(index);
    const [a, b] = checkRow(encoded, row, reference[index]);
    referenceArea += a; decodedArea += b;
    inTriangles += reference[index].indices.length / 3;
    for (const field of ['positions', 'normals', 'indices']) {
      assert.equal(encoded.meshes[index][field].length, 0, `${label}: encoded mesh ${index} gave up its ${field}`);
    }
  }
  for (let i = 0; i < reference.length; i++) {
    if (taken.has(i)) continue;
    for (const field of ['positions', 'normals', 'indices']) {
      assert.deepEqual(encoded.meshes[i][field], reference[i][field], `${label}: refused mesh ${i} keeps its ${field}`);
    }
  }
  assert.equal(encoded.totals[1], inTriangles, `${label}: totals count the encoded meshes' triangles`);
  assert.ok(encoded.totals[3] <= encoded.totals[1] && encoded.totals[2] <= encoded.totals[0], `${label}: welding never adds`);
  // Welding and the lattice may only lose what the 1% collapse rule allows, and snapping moves area little.
  assert.ok(Math.abs(decodedArea - referenceArea) <= referenceArea * 0.01,
    `${label}: surface area ${decodedArea / 2} m² against ${referenceArea / 2} m²`);
  return { rows, refused, weld: encoded.totals[0] / encoded.totals[2] };
}

export function runCompactEncodeContracts(IfcAPI, test, skip, rootDir) {
  for (const fixture of FIXTURES) {
    const path = join(rootDir, fixture.path);
    const name = `compact encode: ${fixture.path.split('/').pop()} decodes within half a lattice step`;
    if (!existsSync(path)) {
      assert.ok(!fixture.committed, `${fixture.path} is committed and must exist`);
      skip(name, 'fixture missing — run `pnpm fixtures`');
      continue;
    }
    test(name, () => {
      const api = new IfcAPI();
      try {
        const result = checkFixture(api, readFileSync(path), fixture.path);
        console.log(`     ${result.rows} encoded, ${result.refused} refused, ${result.weld.toFixed(2)}x fewer vertices`);
      } finally {
        api.free();
      }
    });
  }
}
