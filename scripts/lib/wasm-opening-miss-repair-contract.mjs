/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMeshesViaPrePass } from './mesh-via-prepass.mjs';

/** Exact coordinate edge pairing; no tolerance can hide a reopened seam. */
function assertClosed(mesh, label) {
  const points = [];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const point = Array.from(mesh.positions.subarray(i, i + 3));
    assert.ok(point.every(Number.isFinite), `${label}: finite coordinates`);
    points.push(point.join(',')); // normalizes -0, as coordinate equality does
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(Math.abs(point[axis] + (mesh.origin?.[axis] ?? 0)) < 100,
        `${label}: the survey model must remain in its building-scale RTC frame`);
    }
  }
  const edges = new Map();
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const triangle = Array.from(mesh.indices.subarray(i, i + 3), index => points[index]);
    assert.ok(triangle.every(point => point !== undefined), `${label}: valid indices`);
    if (new Set(triangle).size < 3) continue;
    for (let j = 0; j < 3; j++) {
      const a = triangle[j], b = triangle[(j + 1) % 3];
      const key = a < b ? `${a};${b}` : `${b};${a}`;
      const count = edges.get(key) ?? [0, 0];
      count[a < b ? 0 : 1]++;
      edges.set(key, count);
    }
  }
  assert.ok(edges.size > 0, `${label}: a real surface was emitted`);
  for (const count of edges.values()) {
    assert.deepEqual(count, [1, 1], `${label}: every edge must have exactly one opposite mate`);
  }
}

export function runOpeningMissRepairContracts(IfcAPI, test, skip, root) {
  const fixture = join(root, 'tests/models/various/rvt01.ifc');
  const name = '#6516: disjoint opening misses preserve closed Revit material-layer parts';
  if (!existsSync(fixture)) {
    skip(name, 'run `pnpm fixtures` to fetch the real Revit rvt01 model');
    return;
  }
  test(name, () => {
    const api = new IfcAPI();
    try {
      const collection = parseMeshesViaPrePass(api, readFileSync(fixture, 'utf8'));
      try {
        for (const id of [6810, 38800]) {
          const parts = [];
          for (let i = 0; i < collection.length; i++) {
            const mesh = collection.get(i);
            if (mesh.expressId === id) parts.push(mesh);
          }
          assert.equal(parts.length, 3, `host ${id}: all three material layers must mesh`);
          parts.forEach((mesh, part) => assertClosed(mesh, `host ${id}, part ${part}`));
        }
      } finally { collection.free(); }
    } finally { api.free(); }
  });
}
