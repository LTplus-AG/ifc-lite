/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #858 regression guard — the LIVE VIEWER path.
 *
 * The browser viewer renders through `buildPrePassOnce` + `processGeometryBatch`
 * (the path `parseMeshesViaPrePass` drives). That path used to collapse an
 * `IfcIndexedColourMap` to a single dominant colour, so a face set whose
 * `ColourIndex` paints different triangles different colours rendered as one
 * solid colour (#858 "reappeared" after the #874 mesh-pipeline unification).
 *
 * The native `process_geometry` path always split correctly and its rust test
 * stayed green — which is exactly why this needs a WASM-path test: only this
 * level exercises `processGeometryBatch` and would have caught the regression.
 *
 * Fixture `tests/models/issues/858_indexed_colour_map.ifc`: an
 * IfcBuildingElementProxy #302 whose IfcTriangulatedFaceSet (12 tris) is
 * coloured red(8)/green(2)/yellow(2) purely via IfcIndexedColourMap +
 * IfcColourRgbList (no IfcStyledItem). The split must produce 3 sub-meshes.
 */

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const rootDir = join(packageDir, '..', '..');
const wasmPath = join(packageDir, 'pkg', 'ifc-lite_bg.wasm');
const wasmJsPath = join(packageDir, 'pkg', 'ifc-lite.js');
const fixturePath = join(rootDir, 'tests', 'models', 'issues', '858_indexed_colour_map.ifc');

const PROXY_ID = 302;
const RED = [1.0, 0.0, 0.0];
const GREEN = [0.0, 0.501960784313725, 0.0];
const YELLOW = [1.0, 1.0, 0.0];

function approxColor(c, target) {
  return target.every((v, i) => Math.abs(c[i] - v) < 1e-3);
}

describe('@ifc-lite/wasm IfcIndexedColourMap per-triangle split (#858)', () => {
  it('splits a face set into one sub-mesh per palette group on the processGeometryBatch path', async (t) => {
    if (!existsSync(wasmPath) || !existsSync(wasmJsPath)) {
      t.skip('wasm bundle not built — run `bash scripts/build-wasm.sh` first');
      return;
    }
    if (!existsSync(fixturePath)) {
      t.skip('fixture missing — run `pnpm fixtures` first');
      return;
    }

    const { initSync, IfcAPI } = await import(wasmJsPath);
    const { parseMeshesViaPrePass } = await import(
      join(rootDir, 'scripts', 'lib', 'mesh-via-prepass.mjs')
    );

    initSync(readFileSync(wasmPath));
    const api = new IfcAPI();

    const content = readFileSync(fixturePath, 'utf8');
    const result = parseMeshesViaPrePass(api, content);

    const pieces = [];
    for (let i = 0; i < result.length; i++) {
      const m = result.get(i);
      if (m && m.expressId === PROXY_ID) pieces.push(m);
    }

    assert.equal(
      pieces.length,
      3,
      `expected 3 palette sub-meshes for proxy #${PROXY_ID}, got ${pieces.length}: ` +
        JSON.stringify(pieces.map((m) => ({ color: Array.from(m.color), tris: m.triangleCount }))),
    );

    const red = pieces.find((m) => approxColor(m.color, RED));
    const green = pieces.find((m) => approxColor(m.color, GREEN));
    const yellow = pieces.find((m) => approxColor(m.color, YELLOW));

    assert.ok(red, 'missing red sub-mesh — palette split collapsed to dominant colour');
    assert.ok(green, 'missing green sub-mesh');
    assert.ok(yellow, 'missing yellow sub-mesh');

    assert.equal(red.triangleCount, 8, 'red group should keep 8 triangles');
    assert.equal(green.triangleCount, 2, 'green group should keep 2 triangles');
    assert.equal(yellow.triangleCount, 2, 'yellow group should keep 2 triangles');

    const totalTris = pieces.reduce((n, m) => n + m.triangleCount, 0);
    assert.equal(totalTris, 12, 'split must preserve the original 12 triangles');
  });
});
