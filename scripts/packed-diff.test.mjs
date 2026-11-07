/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tsImport } from 'tsx/esm/api';
import { semantics } from './packed-diff/semantics.mjs';

test('packed frozen vectors remain grounded in the independent TS oracle (#8042)', async () => {
  const oracle = await tsImport(new URL('../packages/diff/test/oracle/index.ts', import.meta.url).href, import.meta.url);
  // The oracle predates resident handles. Its unchanged operations must still
  // satisfy every frozen assertion used by the packed consumer.
  const result = semantics(oracle);
  assert.equal(result.operations.length, 23);
  assert.ok(result.operations.includes('diffModels'));
});
