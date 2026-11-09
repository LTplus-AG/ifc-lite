/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Companion to large-tall-model-performance.js: that oracle measures columns
// and the F5 tower, not per-wall cost. Run this as an `ifc-lite run` script in
// the SAME exclusively admitted A/B cohort. It measures the public SDK call.
const { readFileSync, writeFileSync } = await import('node:fs');
const { resolve } = await import('node:path');
const { pathToFileURL } = await import('node:url');
const { performance } = await import('node:perf_hooks');
const root = process.env.PARITY_BUILD_ROOT || process.cwd();
const { IfcParser } = await import(pathToFileURL(resolve(root, 'packages/parser/dist/index.js')).href);
const { addWallToStore, resolveSpatialAnchor } = await import(pathToFileURL(resolve(root, 'packages/create/dist/index.js')).href);
const source = readFileSync(process.argv.at(-1));
const parsed = await new IfcParser().parseColumnar(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength), { disableWorkerScan: true });
const S = bim.store, M = bim.model.activeId(), L = S.listStoreyLevels(M)[0].expressId;
const anchor = resolveSpatialAnchor(parsed, L);
// Populate a real SESSION OVERLAY, not a newly parsed large file. Forward the
// canonical builder's records through public addEntity to avoid measuring an
// O(N²) setup loop. Geometry, placement, containment and mutation history are
// real; timed calls still use the complete recorded addWall operation.
const writer = { addEntity: (type, attributes) => S.addEntity(M, { type, attributes }) };
const params = i => ({ Start: [i * 10, 0, 0], End: [i * 10 + 4, 0, 0], Thickness: .2, Height: 3 });
const rows = [], samples = 5;
let count = 0;
for (const target of [1000, 10000]) {
  const setupStart = performance.now();
  while (count < target) addWallToStore(writer, anchor, params(count++));
  const setupMs = performance.now() - setupStart;
  // Cold index construction is reported separately, never hidden in setup.
  const coldStart = performance.now();
  S.addWall(M, L, params(count++));
  const coldMs = performance.now() - coldStart;
  const times = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    S.addWall(M, L, params(count++));
    times.push(performance.now() - start);
  }
  const sorted = [...times].sort((a, b) => a - b);
  rows.push({ sessionWalls: target, setupMs, coldMs, samplesMs: times, medianMsPerOp: sorted[Math.floor(sorted.length / 2)] });
}
const wallCount = bim.query().byType('IfcWall').toArray().length;
if (wallCount !== count) throw new Error(`Wall scaling fixture has ${wallCount} walls; expected ${count}`);
const result = { rows, wallCount, expectedWallCount: count, joins: bim.query().byType('IfcRelConnectsPathElements').toArray().length };
console.log(`@@WALL_SCALE@@${JSON.stringify(result)}`);
if (process.env.PARITY_WALL_SCALE_RESULT) writeFileSync(process.env.PARITY_WALL_SCALE_RESULT, JSON.stringify(result, null, 2));
