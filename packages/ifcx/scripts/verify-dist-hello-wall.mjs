/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFederatedIfcx, parseIfcx } from '../dist/index.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, '../../..');
const fixturesDir = path.join(repoRoot, 'tests/models/ifc5');

// Fixtures are fetched on demand via `pnpm fixtures` (AGENTS.md §9). Skip
// cleanly when they're absent so a fresh checkout — or a contributor who
// hasn't fetched fixtures yet — can still run `pnpm build` end-to-end.
const REQUIRED_FIXTURES = [
  'Hello_Wall_hello-wall.ifcx',
  'Hello_Wall_advanced_3rd-window.ifcx',
  'Point_Cloud_point-cloud.ifcx',
  'Point_Cloud_S1-pointcloud.ifcx',
];
const missing = REQUIRED_FIXTURES.filter((name) => !existsSync(path.join(fixturesDir, name)));
if (missing.length > 0) {
  console.warn(
    `verify-dist-hello-wall: skipping — missing ${missing.length} fixture(s): ${missing.join(', ')}.\n` +
    `Run \`pnpm fixtures\` from the repo root to fetch them, then rebuild.`,
  );
  process.exit(0);
}

function loadFixture(name) {
  const buffer = readFileSync(path.join(fixturesDir, name));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

async function main() {
  const base = loadFixture('Hello_Wall_hello-wall.ifcx');
  const overlay = loadFixture('Hello_Wall_advanced_3rd-window.ifcx');

  const baseResult = await parseIfcx(base);
  const baseWindowIds = [...new Set(
    baseResult.meshes.filter((mesh) => mesh.ifcType === 'IfcWindow').map((mesh) => mesh.expressId)
  )].sort((a, b) => a - b);

  assert.strictEqual(baseResult.meshes.length, 10);
  assert.deepStrictEqual(baseWindowIds, [3, 4]);
  assert.deepStrictEqual(baseResult.spatialHierarchy.byStorey.get(6), [5, 3, 4]);
  assert.deepStrictEqual(baseResult.spatialHierarchy.bySpace.get(2), [5, 3, 4]);

  const federatedResult = await parseFederatedIfcx([
    { buffer: base, name: 'hello-wall.ifcx' },
    { buffer: overlay, name: '3rd-window.ifcx' },
  ]);
  const federatedWindowIds = [...new Set(
    federatedResult.meshes.filter((mesh) => mesh.ifcType === 'IfcWindow').map((mesh) => mesh.expressId)
  )].sort((a, b) => a - b);

  assert.strictEqual(federatedResult.meshes.length, 10);
  assert.deepStrictEqual(federatedWindowIds, [1, 2]);
  assert.deepStrictEqual(federatedResult.spatialHierarchy.byStorey.get(7), [4, 1, 2, 3]);
  assert.deepStrictEqual(federatedResult.spatialHierarchy.bySpace.get(6), [4, 1, 2]);

  // Point Cloud samples — buildingSMART IFC5 fixtures whose nodes carry
  // only the inline pcd / points schemas (no bsi::ifc::class). Regression
  // guard for the entity extractor: if it skips them, `pointClouds` ends
  // up empty and the viewer shows a blank canvas.
  const smallPcd = loadFixture('Point_Cloud_point-cloud.ifcx');
  const smallResult = await parseIfcx(smallPcd);
  assert.strictEqual(smallResult.meshes.length, 0, 'small Point_Cloud should have 0 meshes');
  assert.strictEqual(smallResult.pointClouds.length, 5, 'small Point_Cloud should expose 5 point cloud assets');
  assert.ok(smallResult.entityCount >= 5, 'pointcloud nodes must become entities');
  for (const pc of smallResult.pointClouds) {
    assert.ok(pc.pointCount > 0, 'every extracted point cloud carries points');
    assert.ok(Number.isFinite(pc.bbox.min[0]), 'pc bbox must be finite');
  }

  const bigPcd = loadFixture('Point_Cloud_S1-pointcloud.ifcx');
  const bigResult = await parseIfcx(bigPcd);
  assert.strictEqual(bigResult.pointClouds.length, 1);
  assert.strictEqual(bigResult.pointClouds[0].pointCount, 101694,
    'S1 sample should decode all 101,694 binary_compressed points');
  assert.ok(bigResult.pointClouds[0].colors !== undefined, 'S1 sample carries RGB');
}

await main();
