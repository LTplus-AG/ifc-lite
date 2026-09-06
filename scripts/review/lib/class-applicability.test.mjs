/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `one-ended-numeric-bound` must not fire on a nested generic type annotation.
 *
 * MEASURED as a live CLASS_PASS_INCOMPLETE on two unrelated PRs the same day:
 * a test file's `Promise<Map<string, string>>` return type, and another's
 * `Array<ReturnType<typeof Rule.model>>` variable annotation. Neither line
 * contains a comparison of any kind. `unpartneredComparison`'s single-pass
 * generic-parameter strip only consumed the innermost `<...>`, leaving the
 * outer `<` (or, if the shift-operator strip ran first, the outer `<` after
 * `>>` was read as a right-shift token) counted as an unpartnered bracket, so
 * the predicate declared the class applicable on ordinary TypeScript with no
 * numeric bound in it at all -- a class the model could not honestly answer
 * `not-applicable` for and got refused, retry after retry, on the same line.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applicableClasses } from './class-applicability.mjs';

/** A minimal single-file, single-hunk `input.files` map, as production builds it. */
function inputFor(path, addedLines) {
  const hunk = `@@ -1,0 +1,${addedLines.length} @@\n${addedLines.map((l) => `+${l}`).join('\n')}`;
  return { files: new Map([[path, { patch: hunk }]]), contextPack: null };
}

test('does not fire on a two-level nested generic (Promise<Map<string, string>>)', () => {
  const input = inputFor('packages/bcf/src/schema-validation.test.ts', [
    'async function realArchiveEntries(fileName: string): Promise<Map<string, string>> {',
  ]);
  const applicable = applicableClasses(input);
  assert.equal(
    applicable.has('one-ended-numeric-bound'),
    false,
    `expected no site, got ${JSON.stringify(applicable.get('one-ended-numeric-bound'))}`,
  );
});

test('does not fire on a two-level nested generic (Array<ReturnType<...>>)', () => {
  const input = inputFor('apps/viewer/src/components/viewer/ClashSetFilterEditor.wiring.test.tsx', [
    'const commits: Array<ReturnType<typeof Rule.model>> = [];',
  ]);
  const applicable = applicableClasses(input);
  assert.equal(applicable.has('one-ended-numeric-bound'), false);
});

test('does not fire on a three-level nested generic', () => {
  const input = inputFor('src/x.ts', ['const x: Foo<Bar<Baz<string>>> = y;']);
  const applicable = applicableClasses(input);
  assert.equal(applicable.has('one-ended-numeric-bound'), false);
});

test('still fires on a genuine one-ended numeric bound', () => {
  const input = inputFor('src/x.ts', ['if (x > 5) {']);
  const applicable = applicableClasses(input);
  assert.equal(applicable.has('one-ended-numeric-bound'), true);
});

test('still does not fire when both ends are bounded on the same line', () => {
  const input = inputFor('src/x.ts', ['if (a > b && a < c) {']);
  const applicable = applicableClasses(input);
  assert.equal(applicable.has('one-ended-numeric-bound'), false);
});
