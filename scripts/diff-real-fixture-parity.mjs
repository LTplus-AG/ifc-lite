/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #8042: exercise the actual WASM boundary on real IFC adapter output.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { loadIfcBytes } from '../packages/cli/dist/loader.js';
import { buildFileFingerprints } from '../packages/cli/dist/commands/diff-engine.js';
import { diffModels } from '../packages/diff/dist/index.js';
import { fingerprintColumns } from '../packages/diff/src/wasm-columns.ts';
import { restoreDiffReferences } from '../packages/diff/src/wasm-result.ts';
import { initSync, DiffModel } from '../packages/wasm/pkg/ifc-lite.js';

initSync({ module: readFileSync(new URL('../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url)) });
const root = new URL('../', import.meta.url);
const demo = 'apps/viewer/public/samples/';
const pairs = [
  [demo + 'building-architecture.ifc', demo + 'building-architecture-rev-b.ifc'],
  ['tests/models/ara3d/AC20-FZK-Haus.ifc', 'tests/models/ara3d/AC20-FZK-Haus.ifc'],
];
function retained(rows) {
  const c = fingerprintColumns(rows);
  return new DiffModel(c.strings, c.fields, c.flags, c.boxes, c.volumes, c.componentOffsets, c.componentPairs);
}
for (const [basePath, headPath] of pairs) {
  const paths = [basePath, headPath].map(path => new URL(path, root));
  if (paths.some(path => !existsSync(path))) {
    console.log(`SKIP ${basePath} / ${headPath}: missing IFC fixture; run pnpm fixtures`);
    continue;
  }
  const rows = await Promise.all(paths.map(async path => buildFileFingerprints(await loadIfcBytes(readFileSync(path), path.pathname))));
  const base = retained(rows[0]);
  try {
    const head = retained(rows[1]);
    try {
      for (const options of [{ scope: 'data' }, { scope: 'data', matchUnpairedByContent: true },
        { matchUnpairedByContent: true, detectSplitMerge: true, detectSuccessors: true }]) {
        const expected = diffModels(rows[0], rows[1], options);
        const actual = restoreDiffReferences(base.compare(head, options), rows[0], rows[1]);
        assert.deepEqual(actual, expected, `${basePath}: ${JSON.stringify(options)}`);
        for (const entry of actual.entries) {
          assert.equal(actual.byKey.get(entry.key), entry);
          if (entry.base) assert.ok(rows[0].includes(entry.base));
          if (entry.head) assert.ok(rows[1].includes(entry.head));
        }
        if (basePath === headPath) assert.equal(actual.counts.unchanged, rows[0].length);
        console.log(JSON.stringify({ base: basePath, head: headPath, options, entities: rows.map(row => row.length), counts: actual.counts, parity: 'exact' }));
      }
    } finally { head.free(); }
  } finally { base.free(); }
}
