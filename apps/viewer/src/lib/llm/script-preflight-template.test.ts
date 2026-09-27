/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateScriptPreflightDetailed } from './script-preflight.js';

test('preflight accepts the complete built-in building creation script (#6086)', () => {
  const script = readFileSync(new URL('../scripts/templates/create-building.ts', import.meta.url), 'utf8');
  const detached = validateScriptPreflightDetailed(script)
    .filter((diagnostic) => diagnostic.code === 'detached_snippet_scope');
  assert.deepEqual(detached, []);
});
