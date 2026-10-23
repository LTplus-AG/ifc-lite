/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const binary = new URL('../pkg/ifc-lite_bg.wasm', import.meta.url);
test('actual WASM lineage helpers preserve TypeScript corpus and invalid-share semantics (#8042, #8084)', async context => {
  if (!existsSync(binary)) { context.skip('WASM bundle missing; run pnpm build:wasm'); return; }
  const wasm = await import('../pkg/ifc-lite.js');
  wasm.initSync({ module: readFileSync(binary) });
  const vectors = JSON.parse(readFileSync(new URL('../../../rust/diff/tests/lineage_vectors.json', import.meta.url), 'utf8'));
  for (const vector of vectors) {
    const expected = vector.expectedLineage;
    const { entries, deleted } = expected.lineage;
    assert.deepEqual(wasm.diffLineageConflicts(entries), expected.conflicts, vector.name);
    assert.deepEqual(wasm.diffKeyAliasesFromLineage(entries), expected.aliases, vector.name);
    for (const policy of ['copy-to-all', 'largest-share', 'orphan-on-split']) {
      assert.deepEqual(wasm.diffRekeyByLineage(vector.keys, entries, deleted, policy), expected.rekey[policy], `${vector.name}: ${policy}`);
    }
  }
  // The faithful port preserves the existing TS behavior; #8084 tracks the policy fix.
  const entry = { base: ['source'], head: ['a', 'b'], relation: 'split', reason: 'split:verified', shares: [NaN, 0.6] };
  assert.deepEqual(wasm.diffRekeyByLineage(['source', 'gone', 'same'], [entry], ['gone'], 'largest-share'), [
    { key: 'source', successors: ['a'], relation: 'split', orphan: false },
    { key: 'gone', successors: [], orphan: true },
    { key: 'same', successors: ['same'], relation: 'unchanged', orphan: false },
  ]);
});
