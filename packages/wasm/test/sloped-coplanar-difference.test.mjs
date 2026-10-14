/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7292: exercise the viewer's prepass/batch producer with the reporter's
 * committed 2% sloped DIFFERENCE. Only the complete 25 mm strip remains. */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const rootDir = join(packageDir, '..', '..');
const wasmPath = join(packageDir, 'pkg', 'ifc-lite_bg.wasm');
const wasmJsPath = join(packageDir, 'pkg', 'ifc-lite.js');
const fixturePath = join(rootDir, 'rust', 'geometry', 'tests', 'fixtures',
  'issue_7292_sloped_coplanar_difference.ifc');

it('#7292: sloped DIFFERENCE keeps only the 25 mm strip through processGeometryBatch', async (t) => {
  if (!existsSync(wasmPath) || !existsSync(wasmJsPath)) {
    t.skip('wasm bundle not built — run `bash scripts/build-wasm.sh` first');
    return;
  }
  const { initSync, IfcAPI } = await import(wasmJsPath);
  const { parseMeshesViaPrePass } = await import(join(rootDir, 'scripts', 'lib', 'mesh-via-prepass.mjs'));
  initSync({ module: readFileSync(wasmPath) });
  const api = new IfcAPI();
  // The helper copies meshes into JS and frees their WASM handles and the
  // prepass cache. The API handle belongs to this test and is freed below.
  try {
    const result = parseMeshesViaPrePass(api, readFileSync(fixturePath, 'utf8'));
    const minimum = [Infinity, Infinity, Infinity];
    const maximum = [-Infinity, -Infinity, -Infinity];
    const rtc = result.hasRtcOffset()
      ? [result.rtcOffsetX, result.rtcOffsetY, result.rtcOffsetZ] : [0, 0, 0];
    let referencedVertices = 0;
    for (let meshIndex = 0; meshIndex < result.length; meshIndex++) {
      const mesh = result.get(meshIndex);
      if (!mesh || mesh.expressId !== 107) continue;
      const origin = mesh.origin ?? [0, 0, 0];
      for (const index of mesh.indices) {
        // MeshDataJs::new converts both positions and origins to Y-up:
        // (x, y, z) -> (x, z, -y). Invert that rotation after adding the
        // origin, then restore the prepass's IFC Z-up RTC translation.
        const render = [0, 1, 2].map((axis) => mesh.positions[index * 3 + axis] + origin[axis]);
        const world = [render[0] + rtc[0], -render[2] + rtc[1], render[1] + rtc[2]];
        assert.ok(world.every(Number.isFinite), 'indexed world coordinates must be finite');
        for (let axis = 0; axis < 3; axis++) {
          minimum[axis] = Math.min(minimum[axis], world[axis]);
          maximum[axis] = Math.max(maximum[axis], world[axis]);
        }
        const height = world[2] - (4.548 + 0.02 * world[1]);
        assert.ok(height >= -1e-4 && height <= 0.054 + 1e-4,
          `indexed vertex ${world} must remain in the 54 mm sloped layer`);
        referencedVertices++;
      }
    }
    assert.ok(referencedVertices > 0, 'the 25 mm strip must remain');
    // Independent IfcOpenShell bounds in IFC Z-up metres. As in the native
    // regression, 0.1 mm covers f32 storage and the kernel snap.
    const expectedMinimum = [-3.025, 0, 4.548];
    const expectedMaximum = [-3, 1.099780, 4.623996];
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(Math.abs(minimum[axis] - expectedMinimum[axis]) < 1e-4
        && Math.abs(maximum[axis] - expectedMaximum[axis]) < 1e-4,
      `axis ${axis} indexed world bounds [${minimum[axis]}, ${maximum[axis]}], `
        + `expected [${expectedMinimum[axis]}, ${expectedMaximum[axis]}]`);
    }
  } finally {
    api.free();
  }
});
