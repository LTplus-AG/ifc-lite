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

// #8081 review 4364815636: distinct JS code units must never collide through
// replacement during serde or wasm-bindgen String conversion.
test('actual WASM staging lineage rejects lone surrogates before replacement (#8081)', async context => {
  if (!existsSync(binary)) { context.skip('WASM bundle missing; run pnpm build:wasm'); return; }
  const wasm = await import('../pkg-diff/ifc-lite-diff.js');
  wasm.initSync({ module: readFileSync(binary) });
  const entry = { base: ['old'], head: ['new'], relation: 'identity', reason: 'verified' };
  const rejection = /WASM diff lineage requires well-formed UTF-16/;
  // wasm-bindgen Result errors are thrown JS strings, not Error instances.
  function rejects(call, label) {
    assert.throws(call, error => typeof error === 'string' && rejection.test(error), label);
  }
  for (const lone of ['\ud800', '\udfff', 'a\ud800b', '\udfff\ud800']) {
    for (const field of ['base', 'head', 'reason', 'relation']) {
      const invalid = { ...entry, [field]: field === 'base' || field === 'head' ? [lone] : lone };
      for (const [name, call] of [
        ['conflicts', () => wasm.diffLineageConflicts([invalid])],
        ['aliases', () => wasm.diffKeyAliasesFromLineage([invalid])],
        ['rekey', () => wasm.diffRekeyByLineage(['old'], [invalid], [], 'copy-to-all')],
      ]) rejects(call, `${name}: ${field}`);
    }
    rejects(() => wasm.diffRekeyByLineage([lone], [], [], 'copy-to-all'), 'rekey keys');
    rejects(() => wasm.diffRekeyByLineage(['old'], [], [lone], 'copy-to-all'), 'deleted keys');
    rejects(() => wasm.diffRekeyByLineage(['old'], [], [], lone), 'policy');
    // This formerly returned a false duplicate-base conflict after U+FFFD substitution.
    rejects(() => wasm.diffLineageConflicts([
      { ...entry, base: [lone] }, { ...entry, base: ['\ufffd'], head: ['other'] },
    ]), 'lone surrogate must not collapse onto literal replacement');
  }
  const scalars = ['\ufffd', 'é', '😀', 'literal\\ud800', ''];
  const entries = scalars.map(key => ({ ...entry, base: [key], head: [`next:${key}`], reason: `verified:${key}` }));
  assert.deepEqual(wasm.diffLineageConflicts(entries), []);
  assert.deepEqual(wasm.diffKeyAliasesFromLineage(entries), scalars.map(key => [`next:${key}`, key]));
  assert.deepEqual(wasm.diffRekeyByLineage(scalars, entries, [], 'copy-to-all'), scalars.map(key => ({
    key, successors: [`next:${key}`], relation: 'identity', orphan: false,
  })));
  assert.deepEqual(wasm.diffRekeyByLineage(scalars, [], scalars, 'copy-to-all'), scalars.map(key => ({
    key, successors: [], orphan: true,
  })));
  assert.deepEqual(wasm.diffLineageConflicts([entries[0], { ...entries[0], head: ['other'] }]), [
    'base key "\ufffd" appears in more than one lineage entry',
  ]);
});
