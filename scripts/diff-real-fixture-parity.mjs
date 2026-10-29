/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #8042: exercise the actual WASM boundary on real IFC adapter output.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { loadIfcBytes } from '../packages/cli/dist/loader.js';
import { buildFileFingerprints } from '../packages/cli/dist/commands/diff-engine.js';
import { loadDiffOracle } from './lib/diff-oracle.mjs';
import * as publicDiff from '../packages/diff/dist/index.js';
import { initSync } from '../packages/wasm/pkg/ifc-lite.js';
import { enrichGeometry } from './lib/diff-real-geometry.mjs';
import { assertDerivedClaims, assertOriginalReferences, derivedGeometryCases } from './lib/diff-derived-geometry.mjs';

const { diffModels } = await loadDiffOracle();

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const geometryWasm = readFileSync(new URL('../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
const diffWasm = readFileSync(new URL('../packages/wasm/pkg-diff/ifc-lite-diff_bg.wasm', import.meta.url));
initSync({ module: geometryWasm });
publicDiff.initDiffSync({ module: diffWasm });
console.log(JSON.stringify({ geometryWasmSha256: digest(geometryWasm), diffWasmSha256: digest(diffWasm) }));
const root = new URL('../', import.meta.url);
const demo = 'apps/viewer/public/samples/';
const pairs = [
  [demo + 'building-architecture.ifc', demo + 'building-architecture-rev-b.ifc'],
  ['tests/models/ara3d/AC20-FZK-Haus.ifc', 'tests/models/ara3d/AC20-FZK-Haus.ifc'],
];
function compare(base, head, options, label) {
  const expected = diffModels(base, head, options);
  // Exercise the full PUBLIC facade, including option projection and reference
  // restoration. Calling DiffModel.compare directly missed facade regressions.
  const actual = publicDiff.diffModels(base, head, options);
  assert.deepEqual(actual, expected, label);
  assertOriginalReferences(actual, base, head);
  return actual;
}
const loaded = new Map();
let derivedSource;
let comparisons = 0;
let executedPairs = 0;
let skipped = 0;
for (const [basePath, headPath] of pairs) {
  const paths = [basePath, headPath].map(path => new URL(path, root));
  if (paths.some(path => !existsSync(path))) {
    console.log(`SKIP ${basePath} / ${headPath}: missing IFC fixture; run pnpm fixtures`);
    skipped++;
    continue;
  }
  // The CLI loader captures process-wide console output while parsing.
  // Load sequentially so overlapping captures cannot swallow the evidence.
  const rows = [];
  for (const path of paths) {
    let model = loaded.get(path.href);
    if (!model) {
      assert.ok(statSync(path).size <= 16 * 1024 * 1024, 'acceptance input is capped at 16 MiB');
      const bytes = readFileSync(path);
      const fingerprints = buildFileFingerprints(await loadIfcBytes(bytes, path.pathname));
      assert.ok(fingerprints.length > 0, `${path.pathname}: expected at least one fingerprint (#8042)`);
      model = enrichGeometry(bytes, fingerprints);
      loaded.set(path.href, model);
      console.log(JSON.stringify({ fixture: path.pathname, sha256: digest(bytes), geometry: model.evidence }));
    }
    // Each revision owns its original rows, even for the self-comparison.
    rows.push(model.rows.map(row => ({ ...row })));
  }
  derivedSource ??= { fixture: basePath, rows: rows[0] };
  for (const options of [{ scope: 'data' }, { scope: 'data', matchUnpairedByContent: true },
    { matchUnpairedByContent: true, detectSplitMerge: true, detectSuccessors: true }]) {
    const actual = compare(rows[0], rows[1], options, `${basePath}: ${JSON.stringify(options)}`);
    if (basePath === headPath) assert.equal(actual.counts.unchanged, rows[0].length);
    comparisons++;
    console.log(JSON.stringify({ base: basePath, head: headPath, options, entities: rows.map(row => row.length), counts: actual.counts, parity: 'exact' }));
  }
  executedPairs++;
}
console.log(`Real IFC parity: ${executedPairs}/${pairs.length} pairs executed.`);
if (derivedSource) {
  const derived = derivedGeometryCases(derivedSource.rows, publicDiff);
  console.log(JSON.stringify({ fixture: derivedSource.fixture, derivedProvenance: derived.provenance }));
  for (const scenario of derived.cases) {
    const actual = compare(scenario.base, scenario.head, scenario.options, scenario.name);
    assertDerivedClaims(actual, scenario);
    comparisons++;
    console.log(JSON.stringify({ scenario: scenario.name, options: scenario.options, counts: actual.counts,
      splitMerges: actual.splitMerges, successors: actual.successors, parity: 'exact' },
    (_key, value) => typeof value === 'bigint' ? value.toString() : value));
  }
} else {
  skipped++;
  console.log('SKIP derived geometry revisions: no real IFC source available; run pnpm fixtures');
}
console.log(JSON.stringify({ comparisons, skipped, coverage: 'real geometry plus explicitly derived revisions; no authored split/merge ground truth' }));

if (comparisons === 0) {
  console.error('INCOMPLETE: no real IFC pairs executed; run pnpm fixtures and rerun parity.');
  process.exitCode = 2;
} else if (skipped > 0) {
  // A skipped section is missing coverage, not a pass: every fixture must be present.
  console.error(`INCOMPLETE: ${skipped} parity section(s) skipped; run pnpm fixtures and rerun parity.`);
  process.exitCode = 2;
}
