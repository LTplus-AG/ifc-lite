/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Manual real-model WASM reopening. Run after reproduce-reference.py.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { initSync, IfcAPI } from '../../../../packages/wasm/pkg/ifc-lite.js';
import { parseMeshesViaPrePass } from '../../../../scripts/lib/mesh-via-prepass.mjs';
initSync({ module: readFileSync(new URL('../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url)) });
const api = new IfcAPI();
try {
  const result = parseMeshesViaPrePass(api, readFileSync(process.argv[2], 'utf8'));
  try {
    const targets = Array.from({ length: result.length }, (_, index) => result.get(index)).filter(mesh => mesh.expressId === 59290);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].triangleCount, 32, 'Reference geometry must not re-cut the tessellated slab');
    assert.ok(targets[0].positions.every(Number.isFinite));
    console.log(JSON.stringify({ product: 59290, triangles: targets[0].triangleCount, vertices: targets[0].vertexCount, finite: true }));
  } finally { result.free(); }
} finally { api.clearPrePassCache(); api.free(); }
