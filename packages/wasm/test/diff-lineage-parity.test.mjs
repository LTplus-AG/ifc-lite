/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const binary = new URL('../pkg-diff/ifc-lite-diff_bg.wasm', import.meta.url);
test('actual WASM lineage helpers preserve TypeScript corpus and invalid-share semantics (#8042, #8084)', async context => {
  if (!existsSync(binary)) { context.skip('WASM bundle missing; run pnpm build:wasm'); return; }
  const wasm = await import('../pkg-diff/ifc-lite-diff.js');
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
  // #8084: non-finite share evidence orphans the split across the real WASM boundary.
  const entry = { base: ['source'], head: ['a', 'b'], relation: 'split', reason: 'split:verified', shares: [NaN, 0.6] };
  assert.deepEqual(wasm.diffRekeyByLineage(['source', 'gone', 'same'], [entry], ['gone'], 'largest-share'), [
    { key: 'source', successors: [], relation: 'split', orphan: true },
    { key: 'gone', successors: [], orphan: true },
    { key: 'same', successors: ['same'], relation: 'unchanged', orphan: false },
  ]);
});

test('actual WASM derives identity and lineage from comparison projections (#8042)', async context => {
  if (!existsSync(binary)) { context.skip('WASM bundle missing; run pnpm build:wasm'); return; }
  const wasm = await import('../pkg-diff/ifc-lite-diff.js');
  const { projectContentMatches, projectAcceptedSuccessors, projectLineageDiff } = await import('../../diff/src/wasm-projections.ts');
  wasm.initSync({ module: readFileSync(binary) });
  const vectors = JSON.parse(readFileSync(new URL('../../../rust/diff/tests/lineage_vectors.json', import.meta.url), 'utf8'));
  for (const vector of vectors) {
    const diff = vector.expected;
    const accepted = vector.accept ? diff.successors : undefined;
    assert.deepEqual(wasm.diffIdentityMapFromContentMatches(projectContentMatches(diff.contentMatches)), vector.expectedLineage.identity, vector.name);
    assert.deepEqual(wasm.diffIdentityMapFromSuccessors(projectAcceptedSuccessors(accepted)), vector.expectedLineage.accepted, vector.name);
    assert.deepEqual(wasm.diffLineageOfDiff(projectLineageDiff(diff), projectAcceptedSuccessors(accepted),
      vector.aliasReasons ?? [], vector.aliasRelations ?? []), vector.expectedLineage.lineage, vector.name);
  }
});


// #8081: lossless full-facade observations supersede staged scalar rejection.
test('actual WASM lineage preserves lone units independently of replacement and escapes (#8081)', async context => {
  if (!existsSync(binary)) { context.skip('WASM bundle missing; run pnpm build:wasm'); return; }
  const wasm = await import('../pkg-diff/ifc-lite-diff.js');
  wasm.initSync({ module: readFileSync(binary) });
  const keys = ['\ud800', '\ud801', '\udfff', 'a\ud800b', '\udfff\ud800', '\ufffd', 'literal\\ud800'];
  const entries = keys.map(key => ({ base: [key], head: [`next:${key}`], relation: 'identity', reason: key }));
  assert.deepEqual(wasm.diffLineageConflicts(entries), []);
  assert.deepEqual(wasm.diffKeyAliasesFromLineage(entries), keys.map(key => [`next:${key}`, key]));
  assert.deepEqual(wasm.diffRekeyByLineage(keys, entries, [], 'copy-to-all'), keys.map(key => ({
    key, successors: [`next:${key}`], relation: 'identity', orphan: false,
  })));
  assert.deepEqual(wasm.diffRekeyByLineage(keys, [], keys, 'copy-to-all'), keys.map(key => ({
    key, successors: [], orphan: true,
  })));
  assert.deepEqual(wasm.diffLineageConflicts([entries[0], { ...entries[0], head: ['other'] }]), [
    'base key "\ud800" appears in more than one lineage entry',
  ]);
});
